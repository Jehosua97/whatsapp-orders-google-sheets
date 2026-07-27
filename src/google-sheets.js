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
  "Estado cocina",
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
  "kitchenStatus",
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

const KITCHEN_HEADERS = [
  "ID pedido",
  "Status",
  "Fecha y hora",
  "Cliente",
  "Telefono",
  "Entrega o recogida",
  "Direccion",
  "Notas",
];
const KITCHEN_MAX_COLUMNS = KITCHEN_HEADERS.length + 10;

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

function receivedAtLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(date);
}

function fulfillmentLabel(order) {
  if (order.fulfillmentConflict === "SI") return "Revisar seleccion";
  if (order.fulfillmentType === "PICKUP") return "Recoger";
  if (order.city === "BRAMPTON") return "Entrega en Brampton";
  if (order.city === "MISSISSAUGA") return "Entrega en Mississauga";
  if (order.fulfillmentType === "DELIVERY") return "Entrega";
  return "Por definir";
}

function kitchenNotes(order) {
  return [
    order.requestedDate && `Fecha: ${order.requestedDate}`,
    order.timeWindow && `Horario: ${order.timeWindow}`,
    order.customerNotes,
  ]
    .filter(Boolean)
    .join(" | ");
}

function isKitchenProduct(item) {
  return item.isLogistics !== "SI" && item.isLogistics !== true;
}

function kitchenStatus(order) {
  const status = String(order.kitchenStatus || "").toLowerCase();
  if (status === "entregado") return "Entregado";
  if (status === "cancelado") return "Cancelado";
  return "Confirmado";
}

function buildKitchenTable(orders, itemsByOrder) {
  const sortedOrders = [...orders].sort((left, right) => {
    const statusRank = (order) => {
      const status = kitchenStatus(order);
      if (status === "Confirmado") return 0;
      if (status === "Entregado") return 1;
      return 2;
    };
    const statusDifference = statusRank(left) - statusRank(right);
    if (statusDifference) return statusDifference;
    return String(right.receivedAt).localeCompare(String(left.receivedAt));
  });
  const productNames = [
    ...new Set(
      sortedOrders.flatMap((order) =>
        (itemsByOrder.get(String(order.orderId)) || [])
          .filter(isKitchenProduct)
          .map((item) => item.productName)
          .filter(Boolean),
      ),
    ),
  ].sort((left, right) =>
    left.localeCompare(right, "es", { sensitivity: "base" }),
  );

  const headers = [...KITCHEN_HEADERS, ...productNames];
  const totalRow = [
    "TOTAL A PREPARAR",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ...productNames.map((_, index) => {
      const column = columnName(KITCHEN_HEADERS.length + index + 1);
      return `=SUMIF($B$3:$B,"Confirmado",${column}$3:${column})`;
    }),
  ];
  const orderRows = sortedOrders.map((order) => {
    const quantities = new Map();
    for (const item of itemsByOrder.get(String(order.orderId)) || []) {
      if (!isKitchenProduct(item)) continue;
      quantities.set(
        item.productName,
        (quantities.get(item.productName) || 0) + Number(item.quantity || 0),
      );
    }

    return [
      order.orderId,
      kitchenStatus(order),
      receivedAtLabel(order.receivedAt),
      order.customerName,
      order.phone,
      fulfillmentLabel(order),
      order.address || "",
      kitchenNotes(order),
      ...productNames.map((productName) => quantities.get(productName) || ""),
    ];
  });

  return {
    headers,
    totalRow,
    orderRows,
    productNames,
    values: [headers, totalRow, ...orderRows],
  };
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
    await this.refreshKitchenViewUnlocked();
  }

  async ensureWorksheets() {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields: "sheets.properties(sheetId,title)",
    });

    const existing = new Set(
      (response.data.sheets || []).map((sheet) => sheet.properties.title),
    );
    const definitions = [
      [this.config.ordersSheet, ORDER_HEADERS],
      [this.config.itemsSheet, ITEM_HEADERS],
      [this.config.productionSheet, PRODUCTION_HEADERS],
      [this.config.kitchenSheet, KITCHEN_HEADERS],
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

    await this.formatWorksheets();
  }

  async formatWorksheets() {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: this.config.spreadsheetId,
      fields:
        "sheets.properties(sheetId,title),sheets.conditionalFormats",
    });
    const sheetsByTitle = new Map(
      (response.data.sheets || []).map((sheet) => [
        sheet.properties.title,
        sheet,
      ]),
    );
    const kitchenSheet = sheetsByTitle.get(this.config.kitchenSheet);
    const kitchenSheetId = kitchenSheet?.properties.sheetId;
    if (kitchenSheetId === undefined) return;

    const requests = (kitchenSheet.conditionalFormats || [])
      .map((_, index) => ({
        deleteConditionalFormatRule: {
          sheetId: kitchenSheetId,
          index,
        },
      }))
      .reverse();
    requests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: kitchenSheetId,
            hidden: false,
            gridProperties: { frozenRowCount: 2, frozenColumnCount: 2 },
          },
          fields:
            "hidden,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: kitchenSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: KITCHEN_MAX_COLUMNS,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.29, green: 0.12, blue: 0.08 },
              textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
              },
              verticalAlignment: "MIDDLE",
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: kitchenSheetId,
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 0,
            endColumnIndex: KITCHEN_MAX_COLUMNS,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.85, green: 0.93, blue: 0.82 },
              textFormat: { bold: true },
              verticalAlignment: "MIDDLE",
            },
          },
          fields: "userEnteredFormat",
        },
      },
      {
        updateDimensionProperties: {
          range: {
            sheetId: kitchenSheetId,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: KITCHEN_MAX_COLUMNS,
          },
          properties: { hiddenByUser: false },
          fields: "hiddenByUser",
        },
      },
      {
        setDataValidation: {
          range: {
            sheetId: kitchenSheetId,
            startRowIndex: 2,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: [
                { userEnteredValue: "Confirmado" },
                { userEnteredValue: "Entregado" },
                { userEnteredValue: "Cancelado" },
              ],
            },
            strict: true,
            showCustomUi: true,
          },
        },
      },
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [
              {
                sheetId: kitchenSheetId,
                startRowIndex: 2,
                startColumnIndex: 0,
                endColumnIndex: KITCHEN_MAX_COLUMNS,
              },
            ],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: '=$B3="Entregado"' }],
              },
              format: {
                backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                textFormat: {
                  foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 },
                },
              },
            },
          },
        },
      },
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [
              {
                sheetId: kitchenSheetId,
                startRowIndex: 2,
                startColumnIndex: 0,
                endColumnIndex: KITCHEN_MAX_COLUMNS,
              },
            ],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: '=$B3="Cancelado"' }],
              },
              format: {
                backgroundColor: { red: 0.96, green: 0.84, blue: 0.84 },
                textFormat: {
                  foregroundColor: { red: 0.55, green: 0.15, blue: 0.15 },
                },
              },
            },
          },
        },
      },
    );

    [190, 110, 150, 150, 125, 180, 300, 300].forEach(
      (pixelSize, columnIndex) => {
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: kitchenSheetId,
              dimension: "COLUMNS",
              startIndex: columnIndex,
              endIndex: columnIndex + 1,
            },
            properties: { pixelSize },
            fields: "pixelSize",
          },
        });
      },
    );
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId: kitchenSheetId,
          dimension: "COLUMNS",
          startIndex: KITCHEN_HEADERS.length,
          endIndex: KITCHEN_MAX_COLUMNS,
        },
        properties: { pixelSize: 150 },
        fields: "pixelSize",
      },
    });

    for (const title of [
      this.config.ordersSheet,
      this.config.itemsSheet,
      this.config.productionSheet,
    ]) {
      const sheetId = sheetsByTitle.get(title)?.properties.sheetId;
      if (sheetId === undefined || sheetId === kitchenSheetId) continue;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, hidden: true },
          fields: "hidden",
        },
      });
    }

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: { requests },
    });
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
      .map((row, index) => ({
        ...objectFromRow(row, ITEM_KEYS),
        sheetRow: index + 2,
      }))
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

      await this.refreshKitchenViewUnlocked();
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
      await this.refreshKitchenViewUnlocked({ syncStatuses: false });
      return updated;
    });
  }

  async replaceOrder(order) {
    return this.enqueue(async () => {
      const current = await this.getOrder(order.summary.orderId);
      if (!current) {
        throw new Error(`No existe el pedido ${order.summary.orderId}`);
      }
      const existingItems = await this.getOrderItems(order.summary.orderId);
      const ordersTitle = quoteSheetTitle(this.config.ordersSheet);
      const itemsTitle = quoteSheetTitle(this.config.itemsSheet);
      const endColumn = columnName(ORDER_HEADERS.length);
      const updatedSummary = {
        ...order.summary,
        receivedAt: current.receivedAt || order.summary.receivedAt,
        updatedAt: new Date().toISOString(),
      };

      if (existingItems.length) {
        await this.sheets.spreadsheets.values.batchClear({
          spreadsheetId: this.config.spreadsheetId,
          requestBody: {
            ranges: existingItems.map(
              (item) => `${itemsTitle}!A${item.sheetRow}:I${item.sheetRow}`,
            ),
          },
        });
      }

      const itemColumn = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.config.spreadsheetId,
        range: `${itemsTitle}!A:A`,
      });
      const nextItemRow =
        (itemColumn.data.values?.length || 1) + 1;
      const lastItemRow = nextItemRow + order.items.length - 1;
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `${ordersTitle}!A${current.sheetRow}:${endColumn}${current.sheetRow}`,
              values: [summaryRow(updatedSummary)],
            },
            {
              range: `${itemsTitle}!A${nextItemRow}:I${lastItemRow}`,
              values: order.items.map(itemRow),
            },
          ],
        },
      });
      await this.refreshKitchenViewUnlocked();
      return updatedSummary;
    });
  }

  async refreshKitchenViewUnlocked({ syncStatuses = true } = {}) {
    if (syncStatuses) await this.syncKitchenStatusesUnlocked();
    const orders = await this.listOrders();
    const itemsByOrder = new Map();

    for (const order of orders) {
      const items = await this.getOrderItems(order.orderId);
      itemsByOrder.set(String(order.orderId), items);
    }
    const table = buildKitchenTable(orders, itemsByOrder);

    const title = quoteSheetTitle(this.config.kitchenSheet);
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.config.spreadsheetId,
      range: `${title}!A:Z`,
    });
    const endColumn = columnName(table.headers.length);
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range: `${title}!A1:${endColumn}${table.values.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: table.values },
    });
    return table;
  }

  async syncKitchenStatusesUnlocked() {
    const kitchenTitle = quoteSheetTitle(this.config.kitchenSheet);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${kitchenTitle}!A3:B`,
    });
    const selectedStatuses = new Map(
      (response.data.values || [])
        .map(([orderId, status]) => [
          String(orderId || ""),
          String(status || "").toLowerCase() === "entregado"
            ? "Entregado"
            : String(status || "").toLowerCase() === "cancelado"
              ? "Cancelado"
            : String(status || "").toLowerCase() === "confirmado"
              ? "Confirmado"
              : "",
        ])
        .filter(([orderId, status]) => orderId && status),
    );
    if (!selectedStatuses.size) return 0;

    const orders = await this.listOrders();
    const updates = orders
      .map((order) => ({
        order,
        status: selectedStatuses.get(String(order.orderId)),
      }))
      .filter(
        ({ order, status }) =>
          status && kitchenStatus(order) !== status,
      );
    if (!updates.length) return 0;

    const statusColumn = columnName(ORDER_HEADERS.length);
    const ordersTitle = quoteSheetTitle(this.config.ordersSheet);
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.config.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates.map(({ order, status }) => ({
          range: `${ordersTitle}!${statusColumn}${order.sheetRow}`,
          values: [[status]],
        })),
      },
    });
    return updates.length;
  }

  async syncKitchenView() {
    return this.enqueue(async () => {
      const updated = await this.syncKitchenStatusesUnlocked();
      if (!updated) return { updated, table: null };
      const table = await this.refreshKitchenViewUnlocked({
        syncStatuses: false,
      });
      return { updated, table };
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
  buildKitchenTable,
  GoogleSheetsOrderStore,
  ITEM_HEADERS,
  KITCHEN_HEADERS,
  ORDER_HEADERS,
  PRODUCTION_HEADERS,
  columnName,
  fulfillmentLabel,
  kitchenStatus,
  quoteSheetTitle,
};
