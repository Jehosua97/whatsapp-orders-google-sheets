"use strict";

const path = require("node:path");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { handleAgentMessage } = require("./whatsapp-agent");
const {
  ConversationStateStore: AgentSessionStore,
} = require("./session-store");
const { DEFAULT_PICKUP_ADDRESS } = require("./business-details");
const { BotPauseState, botControlCommand } = require("./bot-pause-state");
const { isAllowedChat } = require("./auto-reply-state");
const {
  catalogProductMention,
  guardNaturalPlan,
  isConfirmationStep,
  validatePlannedInput,
  verifiedKnowledgeReply,
} = require("./ai-assistant");
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
  orderSummary,
  scheduleOptions,
  totalPieces,
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
const {
  abandonSpecialSession,
  advanceSpecialSession,
  buildSpecialOrder,
  isSpecialSession,
  startSpecialSession,
} = require("./special-order-flow");

const ORDER_RETRY_DELAYS_MS = [0, 1000, 2500];
const CLOSED_ORDER_STATUSES = new Set(["CANCELADO", "ENTREGADO"]);
const AI_DISCLOSURE = "🤖 Aviso: Mensajes generados con IA";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withAiDisclosure(message, enabled) {
  const content = String(message || "").trim();
  if (!content || !enabled || content.startsWith(AI_DISCLOSURE)) return content;
  return `${AI_DISCLOSURE}\n\n${content}`;
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

function isClosedOrder(order) {
  if (!order) return false;
  const values = [order.status, order.kitchenStatus].map((value) =>
    String(value || "").trim().toUpperCase(),
  );
  return values.some((value) => CLOSED_ORDER_STATUSES.has(value));
}

async function resetClosedOrderSession({
  chatId,
  session,
  store,
  conversationState,
  logger = console,
}) {
  if (!session || !["COMPLETED", "CANCELED"].includes(session.step)) {
    return session;
  }
  if (typeof store.getOrder !== "function") return session;

  try {
    if (typeof store.syncKitchenView === "function") {
      await store.syncKitchenView();
    }
    const order = await store.getOrder(session.orderId);
    if (!isClosedOrder(order)) return session;

    conversationState.set(chatId, null);
    logger.log(
      `Conversacion reiniciada porque el pedido ${session.orderId} esta cerrado en Excel.`,
    );
    return null;
  } catch (error) {
    logger.error(
      `No se pudo verificar en Excel el pedido ${session.orderId}:`,
      error,
    );
    return session;
  }
}

function isDirectChatId(value) {
  return /@(?:c\.us|s\.whatsapp\.net|lid)$/i.test(String(value || ""));
}

async function handleBotControlMessage({
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
    const lastMessage = pauseState.lastMessage?.(chatId) || "";
    if (lastMessage && typeof message.getChat === "function") {
      const chat = await message.getChat();
      await chat.sendMessage(lastMessage);
      logger.log(`Ultimo mensaje del bot reenviado para: ${chatId}`);
    }
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
  logger.log("Sistema desactivado por el administrador.");
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

function sessionProgressSignature(session) {
  if (!session) return "NONE";
  return JSON.stringify({
    step: session.step,
    productIndex: session.productIndex,
    quantities: session.quantities,
    schedule: session.schedule?.date || "",
    fulfillment: session.fulfillment,
    deliveryAddress: session.deliveryAddress,
    updateAction: session.updateAction,
    updateProductKey: session.updateProductKey,
    updateProductChoice: session.updateProductChoice?.productId,
  });
}

async function naturalTurnPlan({
  aiAssistant,
  customerMessage,
  session,
  config,
  lastBotMessage,
  logger = console,
}) {
  if (!aiAssistant?.enabled?.(config)) return null;
  try {
    const plan = await aiAssistant.interpretTurn({
      customerMessage,
      session,
      config,
      lastBotMessage,
    });
    return guardNaturalPlan(plan, customerMessage, session, config);
  } catch (error) {
    logger.error(
      `La IA no pudo interpretar el mensaje; se usa el flujo seguro: ${error.message}`,
    );
    return null;
  }
}

async function groundedReply({
  aiAssistant,
  customerMessage,
  verifiedReply,
  session,
  config,
  logger = console,
}) {
  const source = String(verifiedReply || "").trim();
  if (!source || !aiAssistant?.enabled?.(config)) return source;
  try {
    return await aiAssistant.rewriteVerifiedReply({
      customerMessage,
      verifiedReply: source,
      session,
      config,
    });
  } catch (error) {
    logger.error(
      `La IA no pudo redactar la respuesta; se envía el texto verificado: ${error.message}`,
    );
    return source;
  }
}

function planReply(plan, verifiedPrompt = "") {
  const reply = String(plan?.reply || "").trim();
  const prompt = String(verifiedPrompt || "").trim();
  if (!reply) {
    return prompt || "¿Me puedes dar un poco más de información para ayudarte?";
  }
  if (!prompt || normalizedForComparison(reply).includes(normalizedForComparison(prompt))) {
    return reply;
  }
  return `${reply}\n\n${prompt}`;
}

function normalizedForComparison(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function aiInputs(plan) {
  if (
    plan?.kind !== "ADVANCE" ||
    Number(plan.confidence || 0) < 0.55 ||
    !Array.isArray(plan.inputs)
  ) {
    return [];
  }
  return plan.inputs.slice(0, 8);
}

function scheduleDateLabel(option) {
  try {
    return new Intl.DateTimeFormat("es-MX", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${option.date}T12:00:00.000Z`));
  } catch {
    return option.date || "";
  }
}

function applyAiOrderChanges(session, changes, config, now = new Date()) {
  if (
    !session ||
    session.source === "CART" ||
    ["COMPLETED", "CANCELED"].includes(session.step) ||
    String(session.step || "").startsWith("UPDATE")
  ) {
    return null;
  }
  const catalog = (config.catalog || []).filter(
    (product) => product.active !== false,
  );
  const quantities = { ...(session.quantities || {}) };
  const applied = [];
  for (const change of changes || []) {
    const product = catalog.find((item) => item.id === change.productId);
    if (!product) continue;
    const current = Number(quantities[product.id] || 0);
    const quantity = Number(change.quantity || 0);
    if (change.action === "ADD" && quantity > 0) {
      quantities[product.id] = current + quantity;
    } else if (change.action === "SET" && quantity > 0) {
      quantities[product.id] = quantity;
    } else if (change.action === "REMOVE") {
      quantities[product.id] = quantity > 0 ? Math.max(0, current - quantity) : 0;
    } else {
      continue;
    }
    if (quantities[product.id] <= 0) delete quantities[product.id];
    applied.push({ ...change, product });
  }
  if (!applied.length || !Object.keys(quantities).length) return null;

  const productOrder = [
    ...(session.productOrder || []).filter((id) => Number(quantities[id]) > 0),
    ...Object.keys(quantities).filter(
      (id) => !(session.productOrder || []).includes(id),
    ),
  ];
  const pieces = totalPieces(quantities);
  const minimum = Number(config.minimumOrderPieces || 0);
  if (pieces < minimum) {
    return {
      session,
      applied: false,
      reply: `Ese cambio dejaría el pedido en ${pieces} piezas y el mínimo es ${minimum}. Dime qué otra cantidad prefieres.`,
    };
  }
  const options = scheduleOptions(config, now, "", productOrder);
  if (!options.length) {
    return {
      session,
      reply:
        "No encontré una fecha compatible para combinar esos productos. Puedo registrar la combinación como solicitud especial para revisión.",
      applied: false,
    };
  }

  const next = {
    ...session,
    step: "DAY",
    quantities,
    productOrder,
    productIndex: productOrder.length,
    schedule: null,
    scheduleOptions: options,
    fulfillment: null,
    deliveryAddress: "",
    addressType: "",
  };
  const changeLines = applied.map(({ action, product, quantity }) => {
    if (action === "ADD") return `Agregué ${quantity} de ${product.name}.`;
    if (action === "SET") return `${product.name} quedó en ${quantity} piezas.`;
    return quantity > 0
      ? `Quité ${quantity} de ${product.name}.`
      : `Quité ${product.name} del pedido.`;
  });
  const nextQuestion = [
    "¿Para qué día lo necesitas?",
    ...options.map(
      (option, index) =>
        `${index + 1} - ${option.name} ${scheduleDateLabel(option)}`,
    ),
  ].join("\n");
  return {
    session: next,
    applied: true,
    reply: [...changeLines, "", orderSummary(next, config), "", nextQuestion].join(
      "\n",
    ),
  };
}

function canonicalAiInput(step, input, session) {
  const value = String(input || "").trim();
  const normalized = normalizedForComparison(value);
  if (["FULFILLMENT", "UPDATE_FULFILLMENT", "CART_FULFILLMENT"].includes(step)) {
    if (/\b(PICKUP|RECOGER|RECOGIDA|PASAR POR|VOY POR)\b/.test(normalized)) {
      return "1";
    }
    if (/\b(DELIVERY|ENTREGA|DOMICILIO|A DOMICILIO)\b/.test(normalized)) {
      return "2";
    }
  }
  if (["CITY", "UPDATE_CITY", "CART_CITY"].includes(step)) {
    if (/\bBRAMPTON\b/.test(normalized)) return "1";
    if (/\bMISSISSAUGA\b/.test(normalized)) return "2";
  }
  if (["DAY", "UPDATE_DAY", "CART_DAY"].includes(step) && !/^\d+$/.test(value)) {
    const options =
      session.scheduleOptions || session.updateScheduleOptions || [];
    const index = options.findIndex((option) => {
      const name = normalizedForComparison(option.name);
      const date = normalizedForComparison(option.date);
      return (
        (name && normalized.includes(name)) ||
        (date && normalized.includes(date))
      );
    });
    if (index >= 0) return String(index + 1);
  }
  if (isConfirmationStep(step)) {
    if (/\b(SI|YES|CONFIRMO|CONFIRMAR|DE ACUERDO|OK|DALE)\b/.test(normalized)) {
      return "SI";
    }
    if (/\b(NO|CANCELAR|CONSERVAR|MANTENER)\b/.test(normalized)) {
      return "NO";
    }
  }
  return value;
}

function safeDeferredInput(item) {
  const value = String(item?.value || "").trim();
  const normalized = normalizedForComparison(value);
  if (!value || /^\d+$/.test(value) || Number(item?.attempts || 0) > 2) {
    return false;
  }
  return !/\b(SI|YES|NO|CONFIRMO|CONFIRMAR|CANCELAR|CANCELO)\b/.test(
    normalized,
  );
}

function attachDeferredInputs(session, queue) {
  if (!session) return session;
  const next = { ...session };
  const deferred = queue.filter(safeDeferredInput).slice(0, 6);
  if (deferred.length) next.aiDeferredInputs = deferred;
  else delete next.aiDeferredInputs;
  return next;
}

function runConversationInputs({
  session,
  inputs,
  customerMessage,
  config,
  now = new Date(),
}) {
  const initialStep = session.step;
  const initialOrderId = session.orderId;
  let current = session;
  let result = null;
  let applied = 0;
  let queue = [
    ...inputs.map((value) => ({
      value: String(value || ""),
      sourceMessage: customerMessage,
      attempts: 0,
    })),
    ...(session.aiDeferredInputs || []).map((item) =>
      typeof item === "string"
        ? { value: item, sourceMessage: "", attempts: 1 }
        : item,
    ),
  ];

  while (queue.length) {
    if (!current) break;
    if (
      applied > 0 &&
      isConfirmationStep(current.step) &&
      !isConfirmationStep(initialStep)
    ) {
      break;
    }
    const item = queue.shift();
    const canonicalInput = canonicalAiInput(
      current.step,
      item.value,
      current,
    );
    if (
      !validatePlannedInput({
        step: current.step,
        input: canonicalInput,
        customerMessage: item.sourceMessage || customerMessage,
        session: current,
      })
    ) {
      queue.unshift({
        ...item,
        attempts: Number(item.attempts || 0) + 1,
      });
      break;
    }
    const before = sessionProgressSignature(current);
    result = advanceConversation(
      current,
      canonicalInput,
      config,
      now,
    );
    applied += 1;
    current = result.session;
    if (
      result.completed ||
      result.updated ||
      result.orderCanceled ||
      result.canceled ||
      !current
    ) {
      queue = [];
      break;
    }
    if (before === sessionProgressSignature(current)) break;
    if (
      isConfirmationStep(current.step) &&
      !isConfirmationStep(initialStep)
    ) {
      break;
    }
  }
  if (current?.orderId !== initialOrderId) queue = [];
  current = attachDeferredInputs(current, queue);
  if (result?.session) result = { ...result, session: current };
  return { result, applied, session: current };
}

function runCartInputs({
  session,
  inputs,
  customerMessage,
  config,
  now = new Date(),
}) {
  const initialStep = session.step;
  const initialOrderId = session.orderId;
  let current = session;
  let result = null;
  let applied = 0;
  let queue = [
    ...inputs.map((value) => ({
      value: String(value || ""),
      sourceMessage: customerMessage,
      attempts: 0,
    })),
    ...(session.aiDeferredInputs || []).map((item) =>
      typeof item === "string"
        ? { value: item, sourceMessage: "", attempts: 1 }
        : item,
    ),
  ];

  while (queue.length) {
    if (!current) break;
    if (
      applied > 0 &&
      isConfirmationStep(current.step) &&
      !isConfirmationStep(initialStep)
    ) {
      break;
    }
    const item = queue.shift();
    const canonicalInput = canonicalAiInput(
      current.step,
      item.value,
      current,
    );
    if (
      !validatePlannedInput({
        step: current.step,
        input: canonicalInput,
        customerMessage: item.sourceMessage || customerMessage,
        session: current,
      })
    ) {
      queue.unshift({
        ...item,
        attempts: Number(item.attempts || 0) + 1,
      });
      break;
    }
    const before = sessionProgressSignature(current);
    result = advanceCartConversation(
      current,
      canonicalInput,
      config,
      now,
    );
    applied += 1;
    current = result.session;
    if (
      result.completed ||
      result.updated ||
      result.orderCanceled ||
      result.canceled ||
      result.startTextOrder ||
      !current
    ) {
      queue = [];
      break;
    }
    if (before === sessionProgressSignature(current)) break;
    if (
      isConfirmationStep(current.step) &&
      !isConfirmationStep(initialStep)
    ) {
      break;
    }
  }
  if (current?.orderId !== initialOrderId) queue = [];
  current = attachDeferredInputs(current, queue);
  if (result?.session) result = { ...result, session: current };
  return { result, applied, session: current };
}

async function handleConversationMessage({
  message,
  client,
  store,
  config,
  conversationState,
  aiAssistant,
  lastBotMessage = "",
  input,
  logger = console,
}) {
  let session = conversationState.get(message.from);
  session = await resetClosedOrderSession({
    chatId: message.from,
    session,
    store,
    conversationState,
    logger,
  });
  if (session?.source === "CART") {
    return handleCartConversationMessage({
      message,
      store,
      config,
      conversationState,
      aiAssistant,
      lastBotMessage,
      input,
      logger,
    });
  }
  const customerMessage = String(input ?? message.body ?? "");
  let createdSession = false;
  if (!session) {
    const customer = await customerIdentity(message, client);
    session = newSession({
      chatId: message.from,
      customerName: customer.name,
      customerPhone: customer.phone,
      config,
    });
    conversationState.set(message.from, session);
    createdSession = true;
  }
  const discloseAi =
    createdSession && Boolean(aiAssistant?.enabled?.(config));

  if (isSpecialSession(session) && catalogProductMention(customerMessage, config)) {
    session = abandonSpecialSession(session);
    conversationState.set(message.from, session);
  }

  const plan = await naturalTurnPlan({
    aiAssistant,
    customerMessage,
    session,
    config,
    lastBotMessage,
    logger,
  });
  const plannedInputs = aiInputs(plan);
  const currentPrompt =
    lastBotMessage ||
    (createdSession || session.step === "MENU"
      ? menuMessage(session.customerName, config)
      : "");

  if (plan?.kind === "SPECIAL" || isSpecialSession(session)) {
    if (!isSpecialSession(session)) {
      session = startSpecialSession({
        session,
        request: plan?.specialRequest,
        customerMessage,
        createdSession,
        returnPrompt: currentPrompt,
      });
    }
    const special = advanceSpecialSession({
      session,
      request: plan?.specialRequest || {},
      customerMessage,
    });

    if (special.save) {
      const order = buildSpecialOrder(special.session, message);
      await store.saveOrder(order);
      conversationState.set(message.from, special.nextSession);
      const continuation = special.returnPrompt
        ? `\n\nPodemos continuar donde estábamos:\n${special.returnPrompt}`
        : "";
      const verifiedReply = [
        "✅ Ya registré tu solicitud especial en Excel.",
        `${order.summary.productSummary}.`,
        "Quedó por confirmar: el administrador revisará disponibilidad, precio y fecha antes de prepararla.",
      ].join("\n") + continuation;
      const reply = await groundedReply({
        aiAssistant,
        customerMessage,
        verifiedReply,
        session: special.nextSession || special.session,
        config,
        logger,
      });
      await message.reply(withAiDisclosure(reply, discloseAi));
      return true;
    }

    conversationState.set(message.from, special.session);
    const continuation = special.returnPrompt
      ? `\n\n${special.returnPrompt}`
      : "";
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply: `${special.reply || ""}${continuation}`.trim(),
      session: special.session || session,
      config,
      logger,
    });
    await message.reply(withAiDisclosure(reply, discloseAi));
    return true;
  }

  if (plan?.kind === "ORDER_CHANGE") {
    const changed = applyAiOrderChanges(
      session,
      plan.orderChanges,
      config,
    );
    const nextSession = changed?.session || session;
    conversationState.set(message.from, nextSession);
    const verifiedReply =
      changed?.reply || "¿Qué producto y cantidad deseas cambiar?";
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply,
      session: nextSession,
      config,
      logger,
    });
    await message.reply(withAiDisclosure(reply, discloseAi));
    return true;
  }

  if (plan && !plannedInputs.length) {
    conversationState.set(message.from, session);
    const conversationalAnswer = ["GREETING", "GENERAL", "UNSUPPORTED"].includes(
      plan.answerType,
    )
      ? String(plan.reply || "").trim()
      : "";
    const verifiedAnswer =
      plan.kind === "ANSWER"
        ? conversationalAnswer || verifiedKnowledgeReply(plan, session, config)
        : plan.reply;
    const transition =
      plan.kind === "ANSWER" && !conversationalAnswer
        ? String(plan.reply || "").trim()
        : "";
    const factualReply =
      plan.kind === "ANSWER"
        ? [verifiedAnswer, transition].filter(Boolean).join("\n\n")
        : String(plan.reply || "").trim() || currentPrompt;
    const reply =
      plan.kind === "ANSWER"
        ? await groundedReply({
            aiAssistant,
            customerMessage,
            verifiedReply: factualReply,
            session,
            config,
            logger,
          })
        : factualReply;
    await message.reply(withAiDisclosure(reply, discloseAi));
    return true;
  }

  let execution;
  if (plannedInputs.length) {
    execution = runConversationInputs({
      session,
      inputs: plannedInputs,
      customerMessage,
      config,
    });
  } else if (createdSession) {
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply: currentPrompt,
      session,
      config,
      logger,
    });
    await message.reply(withAiDisclosure(reply, discloseAi));
    return true;
  } else {
    execution = {
      result: advanceConversation(
        session,
        customerMessage,
        config,
        new Date(),
      ),
      applied: 1,
    };
  }

  if (!execution.result || execution.applied === 0) {
    conversationState.set(message.from, execution.session || session);
    await message.reply(
      withAiDisclosure(
        planReply(plan, currentPrompt || menuMessage(session.customerName, config)),
        discloseAi,
      ),
    );
    return true;
  }

  const result = execution.result;
  const startsNewConversation =
    discloseAi ||
    Boolean(
      result.session?.orderId &&
        session.orderId &&
        result.session.orderId !== session.orderId &&
        aiAssistant?.enabled?.(config),
    );
  const sendVerified = async (verifiedReply, replySession = result.session) => {
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply,
      session: replySession,
      config,
      logger,
    });
    if (reply) {
      await message.reply(withAiDisclosure(reply, startsNewConversation));
    }
  };

  if (result.orderCanceled) {
    const orderId = result.session?.orderId || session.orderId;
    await store.updateOrder(orderId, {
      status: "CANCELADO",
      kitchenStatus: "Cancelado",
      customerNotes: "Pedido cancelado por el cliente en WhatsApp",
    });
    conversationState.set(message.from, result.session);
    logger.log(`Pedido conversacional cancelado: ${orderId}`);
    await sendVerified(
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
    logger.log(`Pedido conversacional actualizado: ${result.session.orderId}`);
    await sendVerified(updatedMessage(result.session, config));
    return true;
  }

  if (result.completed) {
    const normalized = buildTextOrder(result.session, message, config);
    const saved = await store.saveOrder(normalized);
    if (saved.inserted) {
      logger.log(`Pedido conversacional guardado: ${result.session.orderId}`);
    } else {
      logger.log(`Pedido conversacional duplicado omitido: ${result.session.orderId}`);
    }
    conversationState.set(message.from, result.session);
    await sendVerified(confirmedMessage(result.session, config));
    return true;
  }

  conversationState.set(message.from, result.session);
  if (result.messages?.length) {
    await sendVerified(result.messages.join("\n\n"));
  }
  return true;
}

async function handleCartConversationMessage({
  message,
  store,
  config,
  conversationState,
  aiAssistant,
  lastBotMessage = "",
  input,
  logger = console,
}) {
  let session = conversationState.get(message.from);
  if (!session || session.source !== "CART") return false;
  const customerMessage = String(input ?? message.body ?? "");
  if (isSpecialSession(session) && catalogProductMention(customerMessage, config)) {
    session = abandonSpecialSession(session);
    conversationState.set(message.from, session);
  }
  const plan = await naturalTurnPlan({
    aiAssistant,
    customerMessage,
    session,
    config,
    lastBotMessage,
    logger,
  });
  const plannedInputs = aiInputs(plan);

  if (plan?.kind === "SPECIAL" || isSpecialSession(session)) {
    const specialSession = isSpecialSession(session)
      ? session
      : startSpecialSession({
          session,
          request: plan?.specialRequest,
          customerMessage,
          returnPrompt: lastBotMessage,
        });
    const special = advanceSpecialSession({
      session: specialSession,
      request: plan?.specialRequest || {},
      customerMessage,
    });
    if (special.save) {
      const order = buildSpecialOrder(special.session, message);
      await store.saveOrder(order);
      conversationState.set(message.from, special.nextSession);
      const continuation = special.returnPrompt
        ? `\n\nPodemos continuar donde estábamos:\n${special.returnPrompt}`
        : "";
      const reply = await groundedReply({
        aiAssistant,
        customerMessage,
        verifiedReply:
          [
            "✅ Ya registré tu solicitud especial en Excel.",
            `${order.summary.productSummary}.`,
            "Quedó por confirmar: revisaremos disponibilidad, precio y fecha antes de prepararla.",
          ].join("\n") + continuation,
        session: special.nextSession || special.session,
        config,
        logger,
      });
      await message.reply(reply);
      return true;
    }
    conversationState.set(message.from, special.session);
    const continuation = special.returnPrompt
      ? `\n\n${special.returnPrompt}`
      : "";
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply: `${special.reply || ""}${continuation}`.trim(),
      session: special.session || session,
      config,
      logger,
    });
    await message.reply(reply);
    return true;
  }

  if (plan && !plannedInputs.length) {
    const conversationalAnswer = ["GREETING", "GENERAL", "UNSUPPORTED"].includes(
      plan.answerType,
    )
      ? String(plan.reply || "").trim()
      : "";
    const verifiedAnswer =
      plan.kind === "ANSWER"
        ? conversationalAnswer || verifiedKnowledgeReply(plan, session, config)
        : plan.reply;
    const transition =
      plan.kind === "ANSWER" && !conversationalAnswer
        ? String(plan.reply || "").trim()
        : "";
    const factualReply =
      plan.kind === "ANSWER"
        ? [verifiedAnswer, transition].filter(Boolean).join("\n\n")
        : String(plan.reply || "").trim() || lastBotMessage;
    const reply =
      plan.kind === "ANSWER"
        ? await groundedReply({
            aiAssistant,
            customerMessage,
            verifiedReply: factualReply,
            session,
            config,
            logger,
          })
        : factualReply;
    await message.reply(reply);
    return true;
  }

  const execution = plannedInputs.length
    ? runCartInputs({
        session,
        inputs: plannedInputs,
        customerMessage,
        config,
      })
    : {
        result: advanceCartConversation(
          session,
          customerMessage,
          config,
          new Date(),
        ),
        applied: 1,
      };
  if (!execution.result || execution.applied === 0) {
    conversationState.set(message.from, execution.session || session);
    await message.reply(planReply(plan, lastBotMessage));
    return true;
  }
  const result = execution.result;
  const sendVerified = async (
    verifiedReply,
    replySession = result.session,
    discloseAi = false,
  ) => {
    const reply = await groundedReply({
      aiAssistant,
      customerMessage,
      verifiedReply,
      session: replySession,
      config,
      logger,
    });
    if (reply) await message.reply(withAiDisclosure(reply, discloseAi));
  };

  if (result.startTextOrder) {
    conversationState.set(message.from, result.session);
    await sendVerified(
      menuMessage(result.session.customerName, config),
      result.session,
      Boolean(aiAssistant?.enabled?.(config)),
    );
    return true;
  }

  if (result.orderCanceled) {
    await store.updateOrder(session.orderId, {
      status: "CANCELADO",
      kitchenStatus: "Cancelado",
      customerNotes: "Pedido cancelado por el cliente en WhatsApp",
    });
    conversationState.set(message.from, result.session);
    logger.log(`Pedido de carrito cancelado: ${result.session?.orderId || session.orderId}`);
    await sendVerified(
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
    logger.log(`Pedido de carrito actualizado: ${result.session.orderId}`);
    await sendVerified(
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
      logger.log(`Pedido de carrito guardado: ${result.session.orderId}`);
    } else {
      logger.log(`Pedido de carrito duplicado omitido: ${result.session.orderId}`);
    }
    await sendVerified(cartConfirmedMessage(result.session));
    return true;
  }

  if (result.session) {
    conversationState.set(message.from, result.session);
  } else {
    conversationState.set(message.from, null);
  }
  if (result.messages?.length) {
    await sendVerified(result.messages.join("\n\n"));
  }
  return true;
}

function createWhatsAppClient({
  config,
  configProvider = () => config,
  conversationState: suppliedConversationState,
  pauseState: suppliedPauseState,
  aiAssistant,
  disableSystem = disableScheduledBot,
  shutdownSystem = requestGracefulShutdown,
  store,
  inventoryStore,
  logger = console,
}) {
  const qrFile = path.resolve("whatsapp-qr.png");
  const messageQueues = new Map();
  const conversationState =
    suppliedConversationState ||
    new (config.aiAgentMode === false
      ? ConversationStateStore
      : AgentSessionStore)(config.conversationStateFile, {
        pendingTimeoutMs:
          config.conversationSessionTimeoutHours * 60 * 60 * 1000,
        transcriptTurns: config.agentTranscriptTurns,
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

      if (runtimeConfig.botEnabled === false) {
        logger.log(`Mensaje ignorado porque el bot esta pausado globalmente: ${message.from}`);
        return;
      }

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

      if (
        typeof message.reply === "function" &&
        typeof pauseState.rememberLastMessage === "function"
      ) {
        const reply = message.reply.bind(message);
        message.reply = async (content, ...args) => {
          const sent = await reply(content, ...args);
          pauseState.rememberLastMessage(message.from, content);
          return sent;
        };
      }

      if (runtimeConfig.aiAgentMode !== false) {
        if (isLiveLocationMessage(message)) {
          await message.reply(liveLocationAddressReply());
          return;
        }
        if (["chat", "order", "location"].includes(message.type)) {
          const customer = await customerIdentity(message, client);
          await handleAgentMessage({
            message,
            customer,
            config: runtimeConfig,
            sessionStore: conversationState,
            aiAssistant,
            store,
            inventoryStore,
            pauseState,
            loadOrder: loadOrderWithRetry,
            logger,
          });
        }
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
        await message.reply(
          withAiDisclosure(
            cartReceivedMessage(session, runtimeConfig),
            Boolean(aiAssistant?.enabled?.(runtimeConfig)),
          ),
        );
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
            aiAssistant,
            lastBotMessage: pauseState.lastMessage?.(message.from) || "",
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
          aiAssistant,
          lastBotMessage: pauseState.lastMessage?.(message.from) || "",
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

  client.on("message_create", async (message) => {
    try {
      await handleBotControlMessage({ message, pauseState, logger });
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
  isClosedOrder,
  isDirectChatId,
  isLiveLocationMessage,
  loadOrderWithRetry,
  liveLocationAddressReply,
  locationReceivedReply,
  phoneFromWhatsAppId,
  pickupReply,
  reconcileCustomerPhones,
  resolvePhoneNumber,
  resetClosedOrderSession,
};
