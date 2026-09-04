"use strict";

const { readConfig } = require("./config");
const { AdminConfigStore } = require("./admin-config");
const { createAdminServer } = require("./admin-server");
const { OpenAiBusinessAssistant } = require("./openai-client");
const {
  ConversationStateStore: AgentSessionStore,
} = require("./session-store");
const {
  ConversationStateStore: LegacyConversationStateStore,
} = require("./conversation-flow");
const { GoogleSheetsOrderStore } = require("./google-sheets");
const { createWhatsAppClient } = require("./whatsapp");

async function main() {
  const config = readConfig();
  const store = new GoogleSheetsOrderStore(config);
  const configStore = new AdminConfigStore(
    config.adminConfigFile,
    config,
  );
  const SessionStore =
    config.aiAgentMode === false
      ? LegacyConversationStateStore
      : AgentSessionStore;
  const conversationState = new SessionStore(
    config.conversationStateFile,
    {
      pendingTimeoutMs:
        config.conversationSessionTimeoutHours * 60 * 60 * 1000,
      transcriptTurns: config.agentTranscriptTurns,
    },
  );
  const aiAssistant = new OpenAiBusinessAssistant({
    apiKey: config.openaiApiKey,
    model: config.openaiModel,
    timeoutMs: config.openaiTimeoutMs,
  });
  const recoveredSessions = conversationState.lastRecoveryReport;
  if (
    recoveredSessions.resetCart ||
    recoveredSessions.migratedSessions ||
    recoveredSessions.clearedSessions ||
    recoveredSessions.clearedConversation ||
    recoveredSessions.removedInvalid
  ) {
    console.log(
      "Recuperacion de conversaciones:",
      JSON.stringify(recoveredSessions),
    );
  }

  console.log("Conectando con Google Sheets...");
  await store.initialize();
  console.log("Google Sheets listo.");

  const pendingReadyReservations = configStore.pendingReadyReservations();
  for (const reservation of pendingReadyReservations) {
    const exists = await store.hasOrder(reservation.orderId);
    if (exists) {
      configStore.commitReadyInventory(reservation.orderId);
      console.log(
        `Reserva de pan listo confirmada al recuperar: ${reservation.orderId}`,
      );
    } else {
      configStore.rollbackReadyInventory(reservation.orderId);
      console.log(
        `Reserva de pan listo devuelta al recuperar: ${reservation.orderId}`,
      );
    }
  }

  const whatsapp = createWhatsAppClient({
    config,
    configProvider: () => configStore.runtimeConfig(),
    conversationState,
    aiAssistant,
    store,
    inventoryStore: configStore,
  });
  const admin = createAdminServer({
    config,
    configStore,
    conversationState,
    aiAssistant,
    store,
    whatsapp,
  });
  const adminServer = await admin.listen();
  console.log(
    `Panel administrativo: http://${config.adminHost}:${config.adminPort}`,
  );
  try {
    await whatsapp.initialize();
  } catch (error) {
    await new Promise((resolve) => adminServer.close(resolve));
    await whatsapp.destroy().catch(() => {});
    throw error;
  }
  const kitchenSyncTimer = setInterval(() => {
    store.syncKitchenView().catch((error) => {
      console.error("No se pudo sincronizar el status de cocina:", error);
    });
  }, config.kitchenSyncSeconds * 1000);

  const shutdown = async (signal) => {
    console.log(`\n${signal}: cerrando WhatsApp...`);
    clearInterval(kitchenSyncTimer);
    await new Promise((resolve) => adminServer.close(resolve));
    await whatsapp.destroy().catch(() => {});
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("No se pudo iniciar la aplicacion:", error);
  process.exitCode = 1;
});
