"use strict";

const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable obligatoria ${name} en el archivo .env`);
  }
  return value;
}

function readConfig() {
  const number = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    spreadsheetId: required("GOOGLE_SPREADSHEET_ID"),
    serviceAccountFile: path.resolve(
      process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
        ".secrets/google-service-account.json",
    ),
    ordersSheet: process.env.GOOGLE_ORDERS_SHEET?.trim() || "Pedidos",
    itemsSheet: process.env.GOOGLE_ITEMS_SHEET?.trim() || "Productos",
    productionSheet:
      process.env.GOOGLE_PRODUCTION_SHEET?.trim() || "Produccion",
    kitchenSheet:
      process.env.GOOGLE_KITCHEN_SHEET?.trim() || "Pedidos para cocina",
    kitchenSyncSeconds: number("KITCHEN_SYNC_SECONDS", 30),
    sendCustomerConfirmation:
      process.env.SEND_CUSTOMER_CONFIRMATION !== "false",
    whatsappAuthPath: path.resolve(
      process.env.WHATSAPP_AUTH_PATH || ".wwebjs_auth",
    ),
    whatsappPhoneNumber: (process.env.WHATSAPP_PHONE_NUMBER || "").replace(
      /\D/g,
      "",
    ),
    whatsappPairingMode:
      process.env.WHATSAPP_PAIRING_MODE?.trim().toLowerCase() || "auto",
    whatsappPriceDivisor: number("WHATSAPP_PRICE_DIVISOR", 1000),
    deliveryFees: {
      brampton: number("BRAMPTON_DELIVERY_FEE", 5),
      mississauga: number("MISSISSAUGA_DELIVERY_FEE", 8),
    },
    automationAllowedChatIds: new Set(
      (process.env.WHATSAPP_AUTOMATION_ALLOWLIST || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    autoReplyCooldownHours: number("AUTO_REPLY_COOLDOWN_HOURS", 24),
    autoReplyStateFile: path.resolve(
      process.env.AUTO_REPLY_STATE_FILE || ".data/auto-reply-state.json",
    ),
  };
}

module.exports = { readConfig };
