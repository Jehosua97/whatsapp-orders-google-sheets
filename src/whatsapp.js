"use strict";

const path = require("node:path");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
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

async function customerIdentity(message) {
  try {
    const contact = await message.getContact();
    return {
      name: contact.pushname || contact.name || "",
      phone: contact.number || "",
    };
  } catch {
    return { name: "", phone: "" };
  }
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
  client.on("ready", () => logger.log("WhatsApp listo para recibir pedidos."));
  client.on("auth_failure", (error) =>
    logger.error("Fallo la autenticacion de WhatsApp:", error),
  );
  client.on("disconnected", (reason) =>
    logger.error("WhatsApp se desconecto:", reason),
  );

  client.on("message", async (message) => {
    try {
      if (message.type === "order") {
        logger.log(`Carrito recibido: ${message.orderId || "sin ID"}`);
        const order = await loadOrderWithRetry(message);
        const customer = await customerIdentity(message);
        const normalized = normalizeOrder({
          message,
          order,
          customerName: customer.name,
          customerPhone: customer.phone,
          priceDivisor: config.whatsappPriceDivisor,
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
          await message.reply(
            [
              "Gracias, ya recibimos tu carrito.",
              `Pedido: ${normalized.summary.orderId}`,
              `Productos: ${formatMoney(normalized.summary.total, normalized.summary.currency)}`,
              "",
              "Prefieres recoger o necesitas entrega?",
              "Para entrega, comparte tu ubicacion desde el clip de WhatsApp. Para recoger, dinos que dia te gustaria pasar. Te confirmaremos personalmente el horario.",
            ].join("\n"),
          );
        }
        return;
      }

      if (message.type === "location") {
        await handleLocation({ message, store, config });
        return;
      }

      if (message.type === "chat") {
        await handleFulfillmentText({ message, store, config });
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
};
