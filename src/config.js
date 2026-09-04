"use strict";

const path = require("node:path");
const dotenv = require("dotenv");
const { DEFAULT_PICKUP_ADDRESS } = require("./business-details");

dotenv.config({ quiet: true, override: true });

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

  const boolean = (name, fallback) => {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if (["true", "1", "yes", "si"].includes(value)) return true;
    if (["false", "0", "no"].includes(value)) return false;
    return fallback;
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
    adminCommandAllowedPhone: (
      process.env.ADMIN_COMMAND_ALLOWED_PHONE || ""
    ).replace(/\D/g, ""),
    whatsappPairingMode:
      process.env.WHATSAPP_PAIRING_MODE?.trim().toLowerCase() || "auto",
    whatsappPriceDivisor: number("WHATSAPP_PRICE_DIVISOR", 1000),
    deliveryFees: {
      brampton: number("BRAMPTON_DELIVERY_FEE", 5),
      mississauga: number("MISSISSAUGA_DELIVERY_FEE", 8),
    },
    pickupTimeWindow:
      process.env.PICKUP_TIME_WINDOW?.trim() || "5:00 p.m. a 6:00 p.m.",
    pickupAddress:
      process.env.PICKUP_ADDRESS?.trim() || DEFAULT_PICKUP_ADDRESS,
    automationAllowedChatIds: new Set(
      (process.env.WHATSAPP_AUTOMATION_ALLOWLIST || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    automationAllowedPhones: new Set(
      (process.env.WHATSAPP_AUTOMATION_ALLOWED_PHONES || "")
        .split(",")
        .map((value) => value.replace(/\D/g, ""))
        .filter(Boolean),
    ),
    autoReplyCooldownHours: number("AUTO_REPLY_COOLDOWN_HOURS", 24),
    autoReplyStateFile: path.resolve(
      process.env.AUTO_REPLY_STATE_FILE || ".data/auto-reply-state.json",
    ),
    botPauseStateFile: path.resolve(
      process.env.BOT_PAUSE_STATE_FILE || ".data/bot-pause-state.json",
    ),
    conversationStateFile: path.resolve(
      process.env.CONVERSATION_STATE_FILE ||
        ".data/conversation-state.json",
    ),
    conversationSessionTimeoutHours: number(
      "CONVERSATION_SESSION_TIMEOUT_HOURS",
      24,
    ),
    adminConfigFile: path.resolve(
      process.env.ADMIN_CONFIG_FILE || ".data/admin-config.json",
    ),
    adminHost: process.env.ADMIN_HOST?.trim() || "127.0.0.1",
    adminPort: number("ADMIN_PORT", 3090),
    adminPassword: process.env.ADMIN_PASSWORD || "",
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini",
    openaiTimeoutMs: number("OPENAI_TIMEOUT_MS", 20000),
    aiEnabledByDefault: boolean("AI_ASSISTANT_ENABLED", true),
    aiAgentMode: boolean("AI_AGENT_MODE", true),
    agentMaxSteps: Math.max(1, Math.min(12, number("AGENT_MAX_STEPS", 6))),
    agentTranscriptTurns: Math.max(
      4,
      Math.min(40, number("AGENT_TRANSCRIPT_TURNS", 12)),
    ),
    aiRewriteResponses: boolean("AI_REWRITE_RESPONSES", true),
    minimumOrderPieces: number("MINIMUM_ORDER_PIECES", 5),
    menuPrices: {
      chocolate: number("CHOCOLATE_CONCHA_PRICE", 3.5),
      vanilla: number("VANILLA_CONCHA_PRICE", 3.5),
      bolillo: number("BOLILLO_PRICE", 2.5),
    },
    deliveryWindows: {
      wednesday:
        process.env.WEDNESDAY_DELIVERY_WINDOW?.trim() ||
        "después de las 3:00 PM",
      saturday:
        process.env.SATURDAY_DELIVERY_WINDOW?.trim() ||
        "después de las 10:00 AM",
    },
  };
}

module.exports = { readConfig };
