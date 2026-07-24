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
  return {
    spreadsheetId: required("GOOGLE_SPREADSHEET_ID"),
    serviceAccountFile: path.resolve(
      process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
        ".secrets/google-service-account.json",
    ),
    ordersSheet: process.env.GOOGLE_ORDERS_SHEET?.trim() || "Pedidos",
    itemsSheet: process.env.GOOGLE_ITEMS_SHEET?.trim() || "Productos",
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
  };
}

module.exports = { readConfig };
