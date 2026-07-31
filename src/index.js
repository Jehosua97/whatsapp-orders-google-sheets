"use strict";

const { readConfig } = require("./config");
const { AdminConfigStore } = require("./admin-config");
const { createAdminServer } = require("./admin-server");
const { ConversationStateStore } = require("./conversation-flow");
const { GoogleSheetsOrderStore } = require("./google-sheets");
const { createWhatsAppClient } = require("./whatsapp");

async function main() {
  const config = readConfig();
  const store = new GoogleSheetsOrderStore(config);
  const configStore = new AdminConfigStore(
    config.adminConfigFile,
    config,
  );
  const conversationState = new ConversationStateStore(
    config.conversationStateFile,
    {
      pendingTimeoutMs:
        config.conversationSessionTimeoutHours * 60 * 60 * 1000,
    },
  );
  const recoveredSessions = conversationState.lastRecoveryReport;
  if (
    recoveredSessions.resetCart ||
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

  const whatsapp = createWhatsAppClient({
    config,
    configProvider: () => configStore.runtimeConfig(),
    conversationState,
    store,
  });
  const admin = createAdminServer({
    config,
    configStore,
    conversationState,
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
