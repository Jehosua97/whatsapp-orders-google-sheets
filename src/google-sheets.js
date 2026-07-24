"use strict";

const fs = require("node:fs");
const { google } = require("googleapis");
const { isActiveOrder } = require("./fulfillment");
const { itemRow, summaryRow } = require("./order");

const ORDER_HEADERS = [
  "Fecha de recepcion",
  "ID del pedido",
  "Telefono",
  "Cliente",
  "Moneda",
  "Subtotal",
  "Total productos",
  "Estado",
  "ID del mensaje",
  "ID del chat",
  "Modalidad",
  "Ciudad",
  "Direccion",
  "Codigo postal",
  "Fecha solicitada",
  "Horario",
  "Costo entrega",
  "Total final",
  "Estado horario",
  "Latitud",
  "Longitud",
  "Ultima actualizacion",
  "Notas del cliente",
  "Resumen productos",
  "Conflicto modalidad",
];

const ORDER_KEYS = [
  "receivedAt",
  "orderId",
  "phone",
  "customerName",
  "currency",
  "subtotal",
  "total",
  "status",
  "messageId",
  "chatId",
  "fulfillmentType",
  "city",
  "address",
  "postalCode",
  "requestedDate",
  "timeWindow",
  "deliveryFee",
  "grandTotal",
  "scheduleStatus",
  "latitude",
  "longitude",
  "updatedAt",
  "customerNotes",
  "productSummary",
  "fulfillmentConflict",
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
  "Es logistica",
];

const ITEM_KEYS = [
  "receivedAt",
  "orderId",
  "productId",
  "productName",
  "quantity",
  "unitPrice",
  "currency",
  "lineTotal",
  "isLogistics",
];

const PRODUCTION_HEADERS = [
  "Fecha",
  "ID del producto",
  "Producto",
  "Cantidad total",
  "Pedidos",
];

function quoteSheetTitle(title) {
  return `'${title.replaceAll("'", "''")}'`;
}

function columnName(number) {
  let result = "";
  let current = number;
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function objectFromRow(row, keys) {
  return Object.fromEntries(keys.map((key, index) => [key, row[index] ?? ""]));
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
      [this.config.productionSheet, PRODUCTION_HEADERS],
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
    const endColumn = columnName(headers.length);
    const range = `${quoteSheetTitle(title)}!A1:${endColumn}1`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range,
    });
    const existing = response.data.values?.[0] || [];

    if (headers.some((header, index) => existing[index] !== header)) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    }
  }

  enqueue(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async listOrders() {
    const title = quoteSheetTitle(this.config.ordersSheet);
    const endColumn = columnName(ORDER_HEADERS.length);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${title}!A2:${endColumn}`,
    });

    return (response.data.values || [])
      .map((row, index) => ({
        ...objectFromRow(row, ORDER_KEYS),
        sheetRow: index + 2,
      }))
      .reverse();
  }

  async getOrder(orderId) {
    const orders = await this.listOrders();
    return orders.find((order) => String(order.orderId) === String(orderId));
  }

  async getPendingOrderByChat(chatId) {
    const orders = await this.listOrders();
    return orders.find(
      (order) => order.chatId === chatId && isActiveOrder(order),
    );
  }

  async getOrderItems(orderId) {
    const title = quoteSheetTitle(this.config.itemsSheet);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${title}!A2:I`,
    });
    return (response.data.values || [])
      .map((row) => objectFromRow(row, ITEM_KEYS))
      .filter((item) => String(item.orderId) === String(orderId));
  }

  async hasOrder(orderId) {
    return Boolean(await this.getOrder(orderId));
  }

  async saveOrder(order) {
    return this.enqueue(() => this.saveOrderUnlocked(order));
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
      const orderEndColumn = columnName(ORDER_HEADERS.length);

      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `${ordersTitle}!A${nextOrderRow}:${orderEndColumn}${nextOrderRow}`,
              values: [summaryRow(order.summary)],
            },
            {
              range: `${itemsTitle}!A${nextItemRow}:I${lastItemRow}`,
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

  async updateOrder(orderId, patch) {
    return this.enqueue(async () => {
      const current = await this.getOrder(orderId);
      if (!current) throw new Error(`No existe el pedido ${orderId}`);

      const updated = {
        ...current,
        ...patch,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      };
      const title = quoteSheetTitle(this.config.ordersSheet);
      const endColumn = columnName(ORDER_HEADERS.length);

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.spreadsheetId,
        range: `${title}!A${current.sheetRow}:${endColumn}${current.sheetRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [summaryRow(updated)] },
      });
      return updated;
    });
  }

  async refreshProductionSummary() {
    return this.enqueue(async () => {
      const orders = await this.listOrders();
      const confirmed = orders.filter((order) =>
        ["CONFIRMADO", "EN_COCINA"].includes(order.status),
      );
      const groups = new Map();

      for (const order of confirmed) {
        if (!order.requestedDate) continue;
        const items = await this.getOrderItems(order.orderId);
        for (const item of items) {
          if (item.isLogistics === "SI") continue;
          const key = `${order.requestedDate}:${item.productId}`;
          const current = groups.get(key) || {
            date: order.requestedDate,
            productId: item.productId,
            productName: item.productName,
            quantity: 0,
            orders: [],
          };
          current.quantity += Number(item.quantity || 0);
          current.orders.push(order.orderId);
          groups.set(key, current);
        }
      }

      const rows = [...groups.values()]
        .sort(
          (left, right) =>
            left.date.localeCompare(right.date) ||
            left.productName.localeCompare(right.productName),
        )
        .map((group) => [
          group.date,
          group.productId,
          group.productName,
          group.quantity,
          group.orders.join(", "),
        ]);
      const title = quoteSheetTitle(this.config.productionSheet);
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: this.config.spreadsheetId,
        range: `${title}!A2:E`,
      });
      if (rows.length) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.config.spreadsheetId,
          range: `${title}!A2:E${rows.length + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: rows },
        });
      }
      return rows;
    });
  }
}

module.exports = {
  GoogleSheetsOrderStore,
  ITEM_HEADERS,
  ORDER_HEADERS,
  PRODUCTION_HEADERS,
  columnName,
  quoteSheetTitle,
};
