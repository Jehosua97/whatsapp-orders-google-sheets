"use strict";

const path = require("node:path");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { AutoReplyState, isAllowedChat } = require("./auto-reply-state");
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

async function handleLocation({ message, store, config }) {
  const pending = await store.getPendingOrderByChat(message.from);
  if (!pending) return false;

  const description =
    message.location?.description ||
    message.location?.address ||
    message.location?.name ||
    "";
  const city = detectCity(description);
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
  if (city) {
    await message.reply(
      `Gracias, recibimos tu ubicacion en ${city === "BRAMPTON" ? "Brampton" : "Mississauga"}. ` +
        `La entrega cuesta ${formatMoney(deliveryFee, pending.currency)}. ` +
        "Te confirmaremos personalmente la fecha y el horario disponible.",
    );
  } else {
    await message.reply(
      "Gracias, recibimos tu ubicacion. Confirmanos si corresponde a Brampton o Mississauga y te propondremos un horario.",
    );
  }
  return true;
}

async function handleFulfillmentText({ message, store, config }) {
  const pending = await store.getPendingOrderByChat(message.from);
  if (!pending) return false;

  const parsed = parseFulfillmentText(message.body, config.deliveryFees);
  if (!parsed) return false;

  const patch = addGrandTotal(pending, parsed);
  await store.updateOrder(pending.orderId, patch);

  if (parsed.fulfillmentType === "PICKUP") {
    await message.reply(
      "Perfecto, lo prepararemos para recoger. Te confirmaremos personalmente la fecha y una ventana de 30 minutos.",
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

function createWhatsAppClient({ config, store, logger = console }) {
  const qrFile = path.resolve("whatsapp-qr.png");
  const autoReplyState = new AutoReplyState(
    config.autoReplyStateFile,
    config.autoReplyCooldownHours,
  );
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

  client.on("authenticated", () => logger.log("WhatsApp autenticado."));
  client.on("ready", async () => {
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
  client.on("auth_failure", (error) =>
    logger.error("Fallo la autenticacion de WhatsApp:", error),
  );
  client.on("disconnected", (reason) =>
    logger.error("WhatsApp se desconecto:", reason),
  );

  client.on("message", async (message) => {
    try {
      if (!isAllowedChat(message.from, config.automationAllowedChatIds)) {
        logger.log(`Mensaje ignorado por lista permitida: ${message.from}`);
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
          priceDivisor: config.whatsappPriceDivisor,
          deliveryFees: config.deliveryFees,
        });
        const result = await store.saveOrder(normalized);

        if (!result.inserted) {
          logger.log(`Pedido duplicado omitido: ${normalized.summary.orderId}`);
          return;
        }

        logger.log(
          `Pedido guardado en Google Sheets: ${normalized.summary.orderId}`,
        );
        if (config.sendCustomerConfirmation) {
          const productLines = normalized.items
            .filter((item) => !item.isLogistics)
            .map((item) => `- ${item.quantity} x ${item.productName}`);
          const lines = [
            "Gracias, ya recibimos tu carrito.",
            "",
            "Tu pedido:",
            ...(productLines.length
              ? productLines
              : ["- No encontramos productos para preparar"]),
            "",
          ];
          if (normalized.summary.fulfillmentConflict) {
            lines.push(
              "Vemos mas de una opcion de entrega o recogida. Dinos cual deseas conservar y te ayudaremos a corregirla.",
            );
          } else if (normalized.summary.fulfillmentType === "PICKUP") {
            lines.push(
              "Registramos que vas a recoger. Que dia te gustaria pasar? Te confirmaremos una ventana de 30 minutos.",
            );
          } else if (normalized.summary.fulfillmentType === "DELIVERY") {
            const city =
              normalized.summary.city === "BRAMPTON"
                ? "Brampton"
                : "Mississauga";
            lines.push(
              `Registramos entrega en ${city} por ${formatMoney(normalized.summary.deliveryFee, normalized.summary.currency)}.`,
              "Comparte tu ubicacion desde el clip de WhatsApp y te confirmaremos la fecha y el horario.",
            );
          } else {
            lines.push(
              "No encontramos una opcion de entrega o recogida en el carrito. Dinos si prefieres recoger o si necesitas entrega en Brampton o Mississauga.",
            );
          }
          await message.reply(lines.join("\n"));
          autoReplyState.markSent(message.from);
        }
        return;
      }

      if (message.type === "location") {
        await handleLocation({ message, store, config });
        return;
      }

      if (message.type === "chat") {
        const handled = await handleFulfillmentText({
          message,
          store,
          config,
        });
        if (handled) return;
      }

      const pending = await store.getPendingOrderByChat(message.from);
      if (pending || !autoReplyState.shouldSend(message.from)) return;

      await message.reply(
        [
          "Nos estamos actualizando para atenderte mejor.",
          "Puedes intentar hacer tu pedido desde el catalogo que aparece en la esquina superior derecha del chat.",
          "Si necesitas ayuda, con gusto tomaremos tu pedido por mensaje aqui mismo.",
        ].join("\n"),
      );
      autoReplyState.markSent(message.from);
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
  });

  return client;
}

module.exports = {
  addGrandTotal,
  createWhatsAppClient,
  customerIdentity,
  handleFulfillmentText,
  handleLocation,
  loadOrderWithRetry,
  phoneFromWhatsAppId,
  reconcileCustomerPhones,
  resolvePhoneNumber,
};
