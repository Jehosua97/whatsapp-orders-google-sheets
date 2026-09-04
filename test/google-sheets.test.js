"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildKitchenTable,
  fulfillmentLabel,
  GoogleSheetsOrderStore,
  kitchenStatus,
} = require("../src/google-sheets");

test("crea una fila por pedido y una columna por producto", () => {
  const order = {
    receivedAt: "2026-07-24T16:00:00.000Z",
    customerName: "Ana",
    phone: "19055550123",
    fulfillmentType: "DELIVERY",
    city: "BRAMPTON",
    requestedDate: "",
    timeWindow: "",
    customerNotes: "",
    address: "123 Main Street",
    orderId: "WA-123",
  };
  const table = buildKitchenTable(
    [order],
    new Map([
      [
        "WA-123",
        [
          { productName: "Concha de vainilla", quantity: 2 },
          { productName: "Concha de chocolate", quantity: 4 },
          {
            productName: "Delivery en Brampton",
            quantity: 1,
            isLogistics: "SI",
          },
        ],
      ],
    ]),
  );

  assert.deepEqual(table.productNames, [
    "Concha de chocolate",
    "Concha de vainilla",
  ]);
  assert.equal(table.orderRows.length, 1);
  assert.deepEqual(table.orderRows[0].slice(0, 8), [
    "WA-123",
    "Confirmado",
    "24/07/26, 12:00 p.m.",
    "Ana",
    "19055550123",
    "Entrega en Brampton",
    "123 Main Street",
    "",
  ]);
  assert.deepEqual(table.orderRows[0].slice(8), [4, 2]);
  assert.deepEqual(table.totalRow.slice(8), [
    '=SUMIF($B$3:$B,"Confirmado",I$3:I)',
    '=SUMIF($B$3:$B,"Confirmado",J$3:J)',
  ]);
});

test("suma productos repetidos dentro del mismo pedido", () => {
  const table = buildKitchenTable(
    [
      {
        orderId: "WA-456",
        receivedAt: "2026-07-24T16:00:00.000Z",
      },
    ],
    new Map([
      [
        "WA-456",
        [
          { productName: "Bolillo", quantity: 2 },
          { productName: "Bolillo", quantity: 3 },
        ],
      ],
    ]),
  );
  assert.deepEqual(table.productNames, ["Bolillo"]);
  assert.equal(table.orderRows[0][8], 5);
});

test("pan listo aparece como pedido pero no se suma a lo que cocina debe preparar", () => {
  const table = buildKitchenTable(
    [
      { orderId: "FRESCO", receivedAt: "2026-08-28T15:00:00.000Z" },
      {
        orderId: "LISTO",
        receivedAt: "2026-08-28T16:00:00.000Z",
        customerNotes: "PAN LISTO: no producir",
      },
    ],
    new Map([
      [
        "FRESCO",
        [
          {
            productName: "Concha de chocolate",
            quantity: 6,
            source: "PRODUCCION_NUEVA",
          },
        ],
      ],
      [
        "LISTO",
        [
          {
            productName: "Concha de chocolate",
            quantity: 5,
            source: "PAN_LISTO",
          },
        ],
      ],
    ]),
  );

  assert.deepEqual(table.productNames, ["Concha de chocolate"]);
  const freshRow = table.orderRows.find((row) => row[0] === "FRESCO");
  const readyRow = table.orderRows.find((row) => row[0] === "LISTO");
  assert.equal(freshRow[8], 6);
  assert.equal(readyRow[8], "");
  assert.match(readyRow[7], /no producir/i);
});

test("acomoda hasta diez productos en una sola fila", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    productName: `Producto ${String(index + 1).padStart(2, "0")}`,
    quantity: index + 1,
  }));
  const table = buildKitchenTable(
    [{ orderId: "WA-10", receivedAt: "2026-07-24T16:00:00.000Z" }],
    new Map([["WA-10", items]]),
  );

  assert.equal(table.headers.length, 18);
  assert.equal(table.orderRows[0].length, 18);
  assert.equal(
    table.totalRow[17],
    '=SUMIF($B$3:$B,"Confirmado",R$3:R)',
  );
});

test("coloca pedidos entregados al final", () => {
  const orders = [
    {
      orderId: "ENTREGADO",
      receivedAt: "2026-07-24T17:00:00.000Z",
      kitchenStatus: "Entregado",
    },
    {
      orderId: "CONFIRMADO",
      receivedAt: "2026-07-24T16:00:00.000Z",
      kitchenStatus: "Confirmado",
    },
  ];
  const table = buildKitchenTable(
    orders,
    new Map([
      ["ENTREGADO", [{ productName: "Bolillo", quantity: 2 }]],
      ["CONFIRMADO", [{ productName: "Bolillo", quantity: 3 }]],
    ]),
  );

  assert.equal(table.orderRows[0][0], "CONFIRMADO");
  assert.equal(table.orderRows[1][0], "ENTREGADO");
  assert.equal(kitchenStatus(orders[0]), "Entregado");
});

test("un pedido cancelado queda inactivo", () => {
  assert.equal(kitchenStatus({ kitchenStatus: "Cancelado" }), "Cancelado");
  assert.equal(kitchenStatus({ kitchenStatus: "Por confirmar" }), "Por confirmar");
});

test("guarda en la hoja interna un status editado por cocina", async () => {
  let batchRequest;
  const store = new GoogleSheetsOrderStore({
    kitchenSheet: "Pedidos para cocina",
    ordersSheet: "Pedidos",
  });
  store.sheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: { values: [["WA-123", "Entregado"]] },
        }),
        batchUpdate: async (request) => {
          batchRequest = request;
        },
      },
    },
  };
  store.listOrders = async () => [
    {
      orderId: "WA-123",
      kitchenStatus: "Confirmado",
      sheetRow: 4,
    },
  ];

  const updated = await store.syncKitchenStatusesUnlocked();

  assert.equal(updated, 1);
  assert.equal(
    batchRequest.requestBody.data[0].range,
    "'Pedidos'!Z4",
  );
  assert.deepEqual(batchRequest.requestBody.data[0].values, [["Entregado"]]);
});

test("una cancelacion del bot no se revierte con el status visible anterior", async () => {
  let writtenRow;
  let refreshOptions;
  const store = new GoogleSheetsOrderStore({
    spreadsheetId: "test",
    ordersSheet: "Pedidos",
  });
  store.sheets = {
    spreadsheets: {
      values: {
        update: async (request) => {
          writtenRow = request.requestBody.values[0];
        },
      },
    },
  };
  store.getOrder = async () => ({
    orderId: "WA-123",
    status: "CONFIRMADO",
    kitchenStatus: "Confirmado",
    sheetRow: 3,
  });
  store.refreshKitchenViewUnlocked = async (options) => {
    refreshOptions = options;
  };

  const updated = await store.updateOrder("WA-123", {
    status: "CANCELADO",
    kitchenStatus: "Cancelado",
  });

  assert.equal(updated.status, "CANCELADO");
  assert.equal(updated.kitchenStatus, "Cancelado");
  assert.equal(writtenRow[25], "Cancelado");
  assert.deepEqual(refreshOptions, { syncStatuses: false });
});

test("reemplaza productos conservando el mismo ID de pedido", async () => {
  let clearedRanges;
  let updateRequest;
  const store = new GoogleSheetsOrderStore({
    ordersSheet: "Pedidos",
    itemsSheet: "Productos",
  });
  store.sheets = {
    spreadsheets: {
      values: {
        batchClear: async (request) => {
          clearedRanges = request.requestBody.ranges;
        },
        get: async () => ({ data: { values: [["Fecha"], ["dato"]] } }),
        batchUpdate: async (request) => {
          updateRequest = request;
        },
      },
    },
  };
  store.getOrder = async () => ({
    orderId: "CHAT-123",
    receivedAt: "2026-07-27T15:00:00.000Z",
    sheetRow: 3,
  });
  store.getOrderItems = async () => [
    { orderId: "CHAT-123", sheetRow: 8 },
    { orderId: "CHAT-123", sheetRow: 9 },
  ];
  store.refreshKitchenViewUnlocked = async () => {};

  await store.replaceOrder({
    summary: {
      orderId: "CHAT-123",
      receivedAt: "nueva",
      kitchenStatus: "Confirmado",
    },
    items: [
      {
        orderId: "CHAT-123",
        productName: "Bolillo",
        quantity: 5,
      },
    ],
  });

  assert.deepEqual(clearedRanges, [
    "'Productos'!A8:J8",
    "'Productos'!A9:J9",
  ]);
  assert.equal(
    updateRequest.requestBody.data[0].range,
    "'Pedidos'!A3:Z3",
  );
  assert.equal(
    updateRequest.requestBody.data[1].range,
    "'Productos'!A3:J3",
  );
});

test("muestra cuando falta elegir entrega o recogida", () => {
  assert.equal(fulfillmentLabel({}), "Por definir");
  assert.equal(
    fulfillmentLabel({ fulfillmentType: "PICKUP" }),
    "Recoger",
  );
});
