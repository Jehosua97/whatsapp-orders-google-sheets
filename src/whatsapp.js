"use strict";

const path = require("node:path");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { DEFAULT_PICKUP_ADDRESS } = require("./business-details");
const { BotPauseState, botControlCommand } = require("./bot-pause-state");
const { isAllowedChat } = require("./auto-reply-state");
const {
  disableScheduledBot,
  requestGracefulShutdown,
} = require("./system-control");
const {
  advanceConversation,
  buildTextOrder,
  confirmedMessage,
  ConversationStateStore,
  menuMessage,
  newSession,
  updatedMessage,
} = require("./conversation-flow");
const {
  advanceCartConversation,
  cartConfirmedMessage,
  cartFinalSummary,
  cartReceivedMessage,
  createCartSession,
} = require("./cart-flow");
const {
  deliveryFeeFor,
  detectCity,
  detectPostalCode,
  parseFulfillmentText,
} = require("./fulfillment");
const { formatMoney, normalizeOrder } = require("./order");

const ORDER_RETRY_DELAYS_MS = [0, 1000, 2500];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loadOrderWithRetry(message) {
  let lastError;

  for (const delay of ORDER_RETRY_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      const order = await message.getOrder();
      if (order?.products?.length) return order;
      lastError = new Error("WhatsApp no devolvio productos para el pedido");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function phoneFromWhatsAppId(value) {
  const serialized = String(value || "");
  if (!/@(?:c\.us|s\.whatsapp\.net)$/i.test(serialized)) return "";
  return serialized.replace(/@.+$/, "").replace(/\D/g, "");
}

function canonicalPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

function isDirectChatId(value) {
  return /@(?:c\.us|s\.whatsapp\.net|lid)$/i.test(String(value || ""));
}

function handleBotControlMessage({
  message,
  pauseState,
  logger = console,
}) {
  if (!message?.fromMe) return "";
  const command = botControlCommand(message.body);
  const chatId = String(message.to || "");
  if (!command || !isDirectChatId(chatId)) return "";

  if (command === "STOP") {
    pauseState.pause(chatId);
    logger.log(`Bot pausado manualmente para: ${chatId}`);
  } else {
    pauseState.resume(chatId);
    logger.log(`Bot reactivado manualmente para: ${chatId}`);
  }
  return command;
}

async function resolvePhoneNumber(client, chatId, contact) {
  if (String(chatId).endsWith("@lid")) {
    try {
      const mappings = await client.getContactLidAndPhone([chatId]);
      const phone = phoneFromWhatsAppId(mappings?.[0]?.pn);
      if (phone) return phone;
    } catch {
      return "";
    }
    return "";
  }

  return (
    phoneFromWhatsAppId(contact?.id?._serialized) ||
    phoneFromWhatsAppId(chatId) ||
    String(contact?.number || "").replace(/\D/g, "")
  );
}

async function handleSystemDisableCommand({
  message,
  client,
  allowedPhone,
  disableSystem,
  shutdownSystem,
  logger = console,
}) {
  if (
    message?.type !== "chat" ||
    String(message.body || "").trim().toUpperCase() !== "DISABLE SYSTEM" ||
    !isDirectChatId(message.from)
  ) {
    return false;
  }

  const senderPhone = await resolvePhoneNumber(client, message.from);
  if (
    !canonicalPhone(allowedPhone) ||
    canonicalPhone(senderPhone) !== canonicalPhone(allowedPhone)
  ) {
    logger.log(
      `Comando de sistema ignorado para remitente no autorizado: ${message.from}`,
    );
    return true;
  }

  await disableSystem();
  await message.reply(
    "Sistema desactivado. El bot no volvera a iniciar automaticamente.",
  );
  logger.log(`Sistemad}`);
  shutdownSystem();
  return true;
}

async function isAllowedMessage({
  client,
  chatId,
  allowedChatIds,
  allowedPhones,
  blockedPhones,
  mode = "TESTING",
}) {
  if (!isDirectChatId(chatId)) return false;

  const phones = allowedPhones instanceof Set ? allowedPhones : new Set();
  const blocked =
    blockedPhones instanceof Set ? blockedPhones : new Set();
  const directPhone = phoneFromWhatsAppId(chatId);
  const resolvedPhone = String(chatId).endsWith("@lid")
    ? await resolvePhoneNumber(client, chatId)
    : directPhone;
  if (resolvedPhone && blocked.has(resolvedPhone)) return false;
  if (String(mode).toUpperCase() === "NORMAL") return true;
  if (isAllowedChat(chatId, allowedChatIds)) return true;
  return Boolean(resolvedPhone && phones.has(resolvedPhone));
}

async function customerIdentity(message, client) {
  let contact;
  try {
    contact = await message.getContact();
  } catch {}

  return {
    name: contact?.pushname || contact?.name || "",
    phone: await resolvePhoneNumber(client, message.from, contact),
  };
}

async function reconcileCustomerPhones({ client, store, logger = console }) {
  const orders = await store.listOrders();
  const lidChatIds = [
    ...new Set(
      orders
        .map((order) => order.chatId)
        .filter((chatId) => String(chatId).endsWith("@lid")),
    ),
  ];
  if (!lidChatIds.length) return 0;

  const mappings = await client.getContactLidAndPhone(lidChatIds);
  const phonesByLid = new Map(
    (mappings || [])
      .map((mapping) => [
        mapping.lid,
        phoneFromWhatsAppId(mapping.pn),
      ])
      .filter(([, phone]) => phone),
  );
  let updated = 0;

  for (const order of orders) {
    const phone = phonesByLid.get(order.chatId);
    if (!phone || order.phone === phone) continue;
    await store.updateOrder(order.orderId, { phone });
    updated += 1;
  }

  if (updated) {
    logger.log(`Telefonos reales actualizados: ${updated} pedido(s).`);
  }
  return updated;
}

function addGrandTotal(order, patch) {
  const productsTotal = Number(order.total);
  const fee = Number(patch.deliveryFee);
  return {
    ...patch,
    grandTotal:
      Number.isFinite(productsTotal) && Number.isFinite(fee)
        ? productsTotal + fee
        : order.total,
  };
}

function pickupReply(
  timeWindow,
  address = DEFAULT_PICKUP_ADDRESS,
) {
  return (
    "Perfecto, registramos que vas a recoger. " +
    `Puedes recoger tu pedido en ${address}, ` +
    `en el horario de ${timeWindow}.`
  );
}

function locationReceivedReply() {
  return (
    "Gracias, recibimos tu ubicacion. " +
    "En breve validaremos el horario de entrega."
  );
}

function liveLocationAddressReply() {
  return (
    "Recibimos una ubicación en tiempo real. " +
    "Para estar seguros, ¿me pudiera confirmar en texto su dirección completa?"
  );
}

function isLiveLocationMessage(message) {
  const raw = message?.rawData || message?._data || {};
  const type = String(message?.type || raw.type || "").toLowerCase();
  const rawType = String(raw.type || "").toLowerCase();
  const liveTypes = new Set([
    "live_location",
    "live-location",
    "livelocation",
  ]);
  const liveFlag =
    message?.location?.isLive === true ||
    raw.isLive === true ||
    raw.live === true ||
    raw.isLiveLocation === true ||
    Boolean(raw.liveLocation || raw.liveLocationMessage);
  const trackingDuration = Number(
    raw.shareDuration || raw.duration || raw.location?.shareDuration || 0,
  );

  return (
    liveTypes.has(type) ||
    liveTypes.has(rawType) ||
    liveFlag ||
    (type === "location" && trackingDuration > 0)
  );
}

async function handleLiveLocation({
  message,
  store,
  conversationState,
}) {
  if (!isLiveLocationMessage(message)) return false;

  const session = conversationState?.get(message.from);
  const waitingForAddress =
    session &&
    ["ADDRESS", "UPDATE_ADDRESS", "CART_ADDRESS"].includes(
      session.step,
    );
  const pending = waitingForAddress
    ? true
    : await store.getPendingOrderByChat(message.from);
  if (!pending) return false;

  await message.reply(liveLocationAddressReply());
  return true;
}

async function handleLocation({ message, store, config }) {
  const pending = await store.getPendingOrderByChat(message.from);
  if (!pending) return false;

  const description =
    message.location?.description ||
    message.location?.address ||
    message.location?.name ||
    "";
  const city = detectCity(description) || pending.city;
  const deliveryFee = deliveryFeeFor(city, config.deliveryFees);
  const patch = addGrandTotal(pending, {
    fulfillmentType: "DELIVERY",
    city,
    address: description,
    postalCode: detectPostalCode(description),
    deliveryFee,
    latitude: message.location?.latitude ?? "",
    longitude: message.location?.longitude ?? "",
    scheduleStatus: "PENDIENTE",
    status: city ? "ESPERANDO_HORARIO" : "ESPERANDO_DATOS",
    customerNotes: "Ubicacion compartida por WhatsApp",
  });

  await store.updateOrder(pending.orderId, patch);
  await message.reply(locationReceivedReply());
  return true;
}

async function handleFulfillmentText({ message, store, config }) {
  const pending = await store.getPendingOrderByChat(message.from);
  if (!pending) return false;

  const parsed = parseFulfillmentText(message.body, config.deliveryFees);
  if (!parsed) return false;

  const patch = addGrandTotal(pending, parsed);
  if (parsed.fulfillmentType === "PICKUP") {
    patch.timeWindow = config.pickupTimeWindow;
    patch.address = config.pickupAddress || DEFAULT_PICKUP_ADDRESS;
  }
  await store.updateOrder(pending.orderId, patch);

  if (parsed.fulfillmentType === "PICKUP") {
    await message.reply(
      pickupReply(config.pickupTimeWindow, config.pickupAddress),
    );
  } else if (parsed.city) {
    const cityName =
      parsed.city === "BRAMPTON" ? "Brampton" : "Mississauga";
    await message.reply(
      `Perfecto, registramos entrega en ${cityName} por ${formatMoney(parsed.deliveryFee, pending.currency)}. ` +
        "Comparte tu ubicacion desde el clip de WhatsApp y te confirmaremos la fecha y el horario.",
    );
  } else {
    await message.reply(
      "Claro. Para calcular la entrega, comparte tu ubicacion desde el clip de WhatsApp o escribe Brampton o Mississauga.",
    );
  }
  return true;
}

async function handleConversationMessage({
  message,
  client,
  store,
  config,
  conversationState,
  input,
  logger = console,
}) {
  let session = conversationState.get(message.from);
  if (session?.source === "CART") {
    return handleCartConversationMessage({
      message,
      store,
      config,
      conversationState,
      input,
      logger,
    });
  }
  if (!session) {
    const customer = await customerIdentity(message, client);
    session = newSession({
      chatId: message.from,
      customerName: customer.name,
      customerPhone: customer.phone,
      config,
    });
    conversationState.set(message.from, session);
    await message.reply(menuMessage(session.customerName, config));
    return true;
  }

  const result = advanceConversation(
    session,
    input ?? message.body,
    config,
    new Date(),
  );

  if (result.orderCanceled) {
    await store.updateOrder(session.orderId, {
      status: "CANCELADO",
      kitchenStatus: "Cancelado",
      customerNotes: "Pedido cancelado por el cliente en WhatsApp",
    });
    conversationState.set(message.from, result.session);
    logger.log(`Pedido conversacional cancelado: ${session.orderId}`);
    await message.reply(
      [
        "❌ Tu pedido fue cancelado.",
        "Ya no se incluirá en las cantidades por preparar.",
        "",
        "Escribe HOLA cuando quieras hacer un pedido nuevo.",
      ].join("\n"),
    );
    return true;
  }

  if (result.updated) {
    const normalized = buildTextOrder(result.session, message, config);
    await store.replaceOrder(normalized);
    conversationState.set(message.from, result.session);
    logger.log(`Pedido conversacional actualizado: ${session.orderId}`);
    await message.reply(updatedMessage(result.session, config));
    return true;
  }

  if (result.completed) {
    const normalized = buildTextOrder(session, message, config);
    const saved = await store.saveOrder(normalized);
    if (saved.inserted) {
      logger.log(`Pedido conversacional guardado: ${session.orderId}`);
    } else {
      logger.log(`Pedido conversacional duplicado omitido: ${session.orderId}`);
    }
    conversationState.set(message.from, result.session);
    await message.reply(confirmedMessage(session, config));
    return true;
  }

  conversationState.set(message.from, result.session);
  for (const reply of result.messages) {
    await message.reply(reply);
  }
  return true;
}

async function handleCartConversationMessage({
  message,
  store,
  config,
  conversationState,
  input,
  logger = console,
}) {
  const session = conversationState.get(message.from);
  if (!session || session.source !== "CART") return false;

  const result = advanceCartConversation(
    session,
    input ?? message.body,
    config,
    new Date(),
  );

  if (result.startTextOrder) {
    conversationState.set(message.from, result.session);
    await message.reply(menuMessage(result.session.customerName, config));
    return true;
  }

  if (result.orderCanceled) {
    await store.updateOrder(session.orderId, {
      status: "CANCELADO",
      kitchenStatus: "Cancelado",
      customerNotes: "Pedido cancelado por el cliente en WhatsApp",
    });
    conversationState.set(message.from, result.session);
    logger.log(`Pedido de carrito cancelado: ${session.orderId}`);
    await message.reply(
      [
        "❌ Tu pedido fue cancelado.",
        "Ya no se incluirá en las cantidades por preparar.",
        "",
        "Escribe NUEVO PEDIDO cuando quieras iniciar otro.",
      ].join("\n"),
    );
    return true;
  }

  if (result.updated) {
    await store.replaceOrder(result.session.cartOrder);
    conversationState.set(message.from, result.session);
    logger.log(`Pedido de carrito actualizado: ${session.orderId}`);
    await message.reply(
      [
        "✅ Tu pedido fue actualizado.",
        "",
        cartFinalSummary(result.session),
        "",
        "Para consultar tu pedido escribe HOLA.",
      ].join("\n"),
    );
    return true;
  }

  if (result.completed) {
    const saved = await store.saveOrder(result.session.cartOrder);
    conversationState.set(message.from, result.session);
    if (saved.inserted) {
      logger.log(`Pedido de carrito guardado: ${session.orderId}`);
    } else {
      logger.log(`Pedido de carrito duplicado omitido: ${session.orderId}`);
    }
    await message.reply(cartConfirmedMessage(result.session));
    return true;
  }

  if (result.session) {
    conversationState.set(message.from, result.session);
  } else {
    conversationState.set(message.from, null);
  }
  for (const reply of result.messages) {
    await message.reply(reply);
  }
  return true;
}

function createWhatsAppClient({
  config,
  configProvider = () => config,
  conversationState: suppliedConversationState,
  pauseState: suppliedPauseState,
  disableSystem = disableScheduledBot,
  shutdownSystem = requestGracefulShutdown,
  store,
  logger = console,
}) {
  const qrFile = path.resolve("whatsapp-qr.png");
  const messageQueues = new Map();
  const conversationState =
    suppliedConversationState ||
    new ConversationStateStore(config.conversationStateFile, {
      pendingTimeoutMs:
        config.conversationSessionTimeoutHours * 60 * 60 * 1000,
    });
  const pauseState =
    suppliedPauseState || new BotPauseState(config.botPauseStateFile);
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "lacenaduria",
      dataPath: config.whatsappAuthPath,
    }),
    pairWithPhoneNumber:
      config.whatsappPhoneNumber && config.whatsappPairingMode !== "qr"
        ? {
            phoneNumber: config.whatsappPhoneNumber,
            showNotification: true,
            intervalMs: 180000,
          }
        : undefined,
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });
  client.lacenaduriaStatus = "CONNECTING";

  client.on("code", (code) => {
    const formatted = String(code).match(/.{1,4}/g)?.join("-") || code;
    logger.log("\nCodigo de vinculacion de WhatsApp:");
    logger.log(formatted);
    logger.log("Este codigo se renueva aproximadamente cada tres minutos.");
  });

  client.on("qr", async (qr) => {
    try {
      await QRCode.toFile(qrFile, qr, {
        width: 512,
        margin: 4,
        errorCorrectionLevel: "M",
      });
      logger.log("\nWhatsApp genero un codigo QR nuevo.");
      logger.log(`Abre y escanea esta imagen: ${qrFile}`);
    } catch (error) {
      logger.error("No se pudo crear la imagen del codigo QR:", error);
    }
  });

  client.on("authenticated", () => {
    client.lacenaduriaStatus = "AUTHENTICATED";
    logger.log("WhatsApp autenticado.");
  });
  client.on("ready", async () => {
    client.lacenaduriaStatus = "READY";
    logger.log("WhatsApp listo para recibir pedidos.");
    try {
      await reconcileCustomerPhones({ client, store, logger });
    } catch (error) {
      logger.error(
        "No se pudieron actualizar los telefonos asociados a los LID:",
        error,
      );
    }
  });
  client.on("auth_failure", (error) => {
    client.lacenaduriaStatus = "AUTH_FAILURE";
    logger.error("Fallo la autenticacion de WhatsApp:", error);
  });
  client.on("disconnected", (reason) => {
    client.lacenaduriaStatus = "DISCONNECTED";
    logger.error("WhatsApp se desconecto:", reason);
  });

  const processMessage = async (message) => {
    try {
      const runtimeConfig = configProvider();
      const systemCommandHandled = await handleSystemDisableCommand({
        message,
        client,
        allowedPhone: runtimeConfig.adminCommandAllowedPhone,
        disableSystem,
        shutdownSystem,
        logger,
      });
      if (systemCommandHandled) return;

      const allowed = await isAllowedMessage({
        client,
        chatId: message.from,
        allowedChatIds: runtimeConfig.automationAllowedChatIds,
        allowedPhones: runtimeConfig.automationAllowedPhones,
        blockedPhones: runtimeConfig.automationBlockedPhones,
        mode: runtimeConfig.automationMode,
      });
      if (!allowed) {
        logger.log(
          `Mensaje ignorado por la política de automatización: ${message.from}`,
        );
        return;
      }

      if (pauseState.isPaused(message.from)) {
        logger.log(
          `Mensaje ignorado porque el bot esta pausado para: ${message.from}`,
        );
        return;
      }

      if (isLiveLocationMessage(message)) {
        const handled = await handleLiveLocation({
          message,
          store,
          conversationState,
        });
        if (!handled) {
          logger.log(
            `Ubicación en tiempo real ignorada fuera del paso de dirección: ${message.from}`,
          );
        }
        return;
      }

      if (message.type === "order") {
        logger.log(`Carrito recibido: ${message.orderId || "sin ID"}`);
        const order = await loadOrderWithRetry(message);
        const customer = await customerIdentity(message, client);
        const normalized = normalizeOrder({
          message,
          order,
          customerName: customer.name,
          customerPhone: customer.phone,
          priceDivisor: runtimeConfig.whatsappPriceDivisor,
          deliveryFees: runtimeConfig.deliveryFees,
          pickupTimeWindow: runtimeConfig.pickupTimeWindow,
        });
        const session = createCartSession(normalized, runtimeConfig);
        conversationState.set(message.from, session);
        logger.log(
          `Carrito pendiente de modalidad: ${normalized.summary.orderId}`,
        );
        await message.reply(cartReceivedMessage(session, runtimeConfig));
        return;
      }

      if (message.type === "location") {
        const session = conversationState.get(message.from);
        if (
          session &&
          ["ADDRESS", "UPDATE_ADDRESS", "CART_ADDRESS"].includes(
            session.step,
          )
        ) {
          const description =
            message.location?.description ||
            message.location?.address ||
            message.location?.name ||
            "";
          const latitude = message.location?.latitude;
          const longitude = message.location?.longitude;
          const locationInput =
            description ||
            (latitude !== undefined && longitude !== undefined
              ? `https://maps.google.com/?q=${latitude},${longitude}`
              : "");
          await handleConversationMessage({
            message,
            client,
            store,
            config: runtimeConfig,
            conversationState,
            input: locationInput,
            logger,
          });
          return;
        }
        await handleLocation({
          message,
          store,
          config: runtimeConfig,
        });
        return;
      }

      if (message.type === "chat") {
        await handleConversationMessage({
          message,
          client,
          store,
          config: runtimeConfig,
          conversationState,
          logger,
        });
        return;
      }
    } catch (error) {
      logger.error("No se pudo procesar el mensaje de WhatsApp:", error);
      if (message.type === "order") {
        await message
          .reply(
            "Recibimos tu carrito, pero necesitamos revisarlo manualmente. No es necesario que lo envies otra vez.",
          )
          .catch(() => {});
      }
    }
  };

  client.on("message", (message) => {
    const previous = messageQueues.get(message.from) || Promise.resolve();
    const current = previous.then(() => processMessage(message));
    messageQueues.set(message.from, current);
    current.finally(() => {
      if (messageQueues.get(message.from) === current) {
        messageQueues.delete(message.from);
      }
    });
  });

  client.on("message_create", (message) => {
    try {
      handleBotControlMessage({ message, pauseState, logger });
    } catch (error) {
      logger.error("No se pudo cambiar la pausa del bot:", error);
    }
  });

  return client;
}

module.exports = {
  addGrandTotal,
  createWhatsAppClient,
  customerIdentity,
  handleBotControlMessage,
  handleConversationMessage,
  handleCartConversationMessage,
  handleFulfillmentText,
  handleLiveLocation,
  handleLocation,
  handleSystemDisableCommand,
  isAllowedMessage,
  isDirectChatId,
  isLiveLocationMessage,
  loadOrderWithRetry,
  liveLocationAddressReply,
  locationReceivedReply,
  phoneFromWhatsAppId,
  pickupReply,
  reconcileCustomerPhones,
  resolvePhoneNumber,
};
