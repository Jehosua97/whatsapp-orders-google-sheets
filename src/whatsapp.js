"use strict";

const path = require("node:path");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { normalizeOrder } = require("./order");

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

async function customerName(message) {
  try {
    const contact = await message.getContact();
    return contact.pushname || contact.name || "";
  } catch {
    return "";
  }
}

function createWhatsAppClient({ config, store, logger = console }) {
  const qrFile = path.resolve("whatsapp-qr.png");
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: "lacenaduria",
      dataPath: config.whatsappAuthPath,
    }),
    pairWithPhoneNumber: config.whatsappPhoneNumber
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
    if (message.type !== "order") return;

    logger.log(`Carrito recibido: ${message.orderId || "sin ID"}`);
    try {
      const order = await loadOrderWithRetry(message);
      const normalized = normalizeOrder({
        message,
        order,
        customerName: await customerName(message),
      });
      const result = await store.saveOrder(normalized);

      if (!result.inserted) {
        logger.log(`Pedido duplicado omitido: ${normalized.summary.orderId}`);
        return;
      }

      logger.log(`Pedido guardado en Google Sheets: ${normalized.summary.orderId}`);
      if (config.sendCustomerConfirmation) {
        await message.reply(
          [
            "¡Gracias! Recibimos tu carrito.",
            `Pedido: ${normalized.summary.orderId}`,
            `Total de productos: ${normalized.summary.total} ${normalized.summary.currency}`,
            "",
            "Enseguida confirmaremos disponibilidad, entrega o recogida.",
          ].join("\n"),
        );
      }
    } catch (error) {
      logger.error(`No se pudo guardar el pedido ${message.orderId}:`, error);
      await message
        .reply(
          "Recibimos tu carrito, pero necesitamos revisarlo manualmente. No es necesario que lo envies otra vez.",
        )
        .catch(() => {});
    }
  });

  return client;
}

module.exports = { createWhatsAppClient, loadOrderWithRetry };
