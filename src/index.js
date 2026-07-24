"use strict";

const { readConfig } = require("./config");
const { createAdminServer } = require("./admin-server");
const { GoogleSheetsOrderStore } = require("./google-sheets");
const { createWhatsAppClient } = require("./whatsapp");

async function main() {
  const config = readConfig();
  const store = new GoogleSheetsOrderStore(config);

  console.log("Conectando con Google Sheets...");
  await store.initialize();
  console.log("Google Sheets listo.");

  const whatsapp = createWhatsAppClient({ config, store });
  await whatsapp.initialize();
  const adminServer = createAdminServer({ config, store, whatsapp });

  const shutdown = async (signal) => {
    console.log(`\n${signal}: cerrando WhatsApp...`);
    adminServer.close();
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
