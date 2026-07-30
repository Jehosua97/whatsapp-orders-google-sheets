"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readConfig } = require("../src/config");
const { GoogleSheetsOrderStore } = require("../src/google-sheets");

function quoteSheetTitle(title) {
  return `'${String(title).replaceAll("'", "''")}'`;
}

function resetJsonFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
}

async function main() {
  const config = readConfig();
  const store = new GoogleSheetsOrderStore(config);
  await store.initialize();

  const sheetRanges = [
    [config.ordersSheet, "A:Z"],
    [config.itemsSheet, "A:I"],
    [config.productionSheet, "A:E"],
    [config.kitchenSheet, "A:Z"],
  ];
  const ranges = sheetRanges.map(
    ([title, range]) => `${quoteSheetTitle(title)}!${range}`,
  );
  const current = await store.sheets.spreadsheets.values.batchGet({
    spreadsheetId: config.spreadsheetId,
    ranges,
  });
  const sheets = Object.fromEntries(
    sheetRanges.map(([title], index) => [
      title,
      current.data.valueRanges?.[index]?.values || [],
    ]),
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.resolve(".data", "backups");
  const backupFile = path.join(
    backupDirectory,
    `orders-before-reset-${timestamp}.json`,
  );
  fs.mkdirSync(backupDirectory, { recursive: true });
  fs.writeFileSync(
    backupFile,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        spreadsheetId: config.spreadsheetId,
        sheets,
        conversationState: fs.existsSync(config.conversationStateFile)
          ? JSON.parse(
              fs.readFileSync(config.conversationStateFile, "utf8"),
            )
          : {},
      },
      null,
      2,
    ),
  );

  await store.sheets.spreadsheets.values.batchClear({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      ranges: [
        `${quoteSheetTitle(config.ordersSheet)}!A2:Z`,
        `${quoteSheetTitle(config.itemsSheet)}!A2:I`,
        `${quoteSheetTitle(config.productionSheet)}!A2:E`,
        `${quoteSheetTitle(config.kitchenSheet)}!A:Z`,
      ],
    },
  });
  await store.refreshKitchenViewUnlocked({ syncStatuses: false });

  resetJsonFile(config.conversationStateFile);
  resetJsonFile(config.autoReplyStateFile);

  const orderRows = Math.max(
    (sheets[config.ordersSheet]?.length || 1) - 1,
    0,
  );
  const itemRows = Math.max(
    (sheets[config.itemsSheet]?.length || 1) - 1,
    0,
  );
  console.log(
    JSON.stringify(
      {
        backupFile,
        deletedOrders: orderRows,
        deletedItems: itemRows,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("No se pudieron reiniciar los pedidos:", error);
  process.exitCode = 1;
});
