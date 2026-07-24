"use strict";

const fs = require("node:fs");
const { google } = require("googleapis");
const { itemRow, summaryRow } = require("./order");

const ORDER_HEADERS = [
  "Fecha de recepcion",
  "ID del pedido",
  "Telefono",
  "Cliente",
  "Moneda",
  "Subtotal",
  "Total",
  "Estado",
  "ID del mensaje",
];

const ITEM_HEADERS = [
  "Fecha de recepcion",
  "ID del pedido",
  "ID del producto",
  "Producto",
  "Cantidad",
  "Precio unitario",
  "Moneda",
  "Total de linea",
];

function quoteSheetTitle(title) {
  return `'${title.replaceAll("'", "''")}'`;
}

class GoogleSheetsOrderStore {
  constructor(config) {
    this.config = config;
    this.sheets = null;
    this.pendingOrderIds = new Set();
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (!fs.existsSync(this.config.serviceAccountFile)) {
      throw new Error(
        `No se encontro la cuenta de servicio: ${this.config.serviceAccountFile}`,
      );
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: this.config.serviceAccountFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    this.sheets = google.sheets({ version: "v4", auth });
    await this.ensureWorksheets();
  }

  async ensureWorksheets() {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields: "sheets.properties.title",
    });

    const existing = new Set(
      (response.data.sheets || []).map((sheet) => sheet.properties.title),
    );
    const definitions = [
      [this.config.ordersSheet, ORDER_HEADERS],
      [this.config.itemsSheet, ITEM_HEADERS],
    ];

    const missing = definitions.filter(([title]) => !existing.has(title));
    if (missing.length) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          requests: missing.map(([title]) => ({
            addSheet: {
              properties: {
                title,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          })),
        },
      });
    }

    for (const [title, headers] of definitions) {
      await this.ensureHeaders(title, headers);
    }
  }

  async ensureHeaders(title, headers) {
    const range = `${quoteSheetTitle(title)}!1:1`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range,
    });

    if (!response.data.values?.[0]?.length) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range: `${quoteSheetTitle(title)}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    }
  }

  async hasOrder(orderId) {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${quoteSheetTitle(this.config.ordersSheet)}!B2:B`,
    });

    return (response.data.values || []).some(
      ([storedOrderId]) => String(storedOrderId) === String(orderId),
    );
  }

  async saveOrder(order) {
    const operation = this.writeQueue.then(() => this.saveOrderUnlocked(order));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveOrderUnlocked(order) {
    const orderId = order.summary.orderId;
    if (this.pendingOrderIds.has(orderId) || (await this.hasOrder(orderId))) {
      return { inserted: false };
    }

    this.pendingOrderIds.add(orderId);
    try {
      const ordersTitle = quoteSheetTitle(this.config.ordersSheet);
      const itemsTitle = quoteSheetTitle(this.config.itemsSheet);
      const current = await this.sheets.spreadsheets.values.batchGet({
        spreadsheetId: this.config.spreadsheetId,
        ranges: [`${ordersTitle}!A:A`, `${itemsTitle}!A:A`],
      });

      const nextOrderRow =
        (current.data.valueRanges?.[0]?.values?.length || 1) + 1;
      const nextItemRow =
        (current.data.valueRanges?.[1]?.values?.length || 1) + 1;
      const lastItemRow = nextItemRow + order.items.length - 1;

      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `${ordersTitle}!A${nextOrderRow}:I${nextOrderRow}`,
              values: [summaryRow(order.summary)],
            },
            {
              range: `${itemsTitle}!A${nextItemRow}:H${lastItemRow}`,
              values: order.items.map(itemRow),
            },
          ],
        },
      });

      return { inserted: true };
    } finally {
      this.pendingOrderIds.delete(orderId);
    }
  }
}

module.exports = {
  GoogleSheetsOrderStore,
  ITEM_HEADERS,
  ORDER_HEADERS,
  quoteSheetTitle,
};
