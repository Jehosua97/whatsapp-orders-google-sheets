"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildKitchenTable,
  fulfillmentLabel,
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
  assert.deepEqual(table.orderRows[0].slice(0, 6), [
    "WA-123",
    "24/07/26, 12:00 p.m.",
    "Ana",
    "19055550123",
    "Entrega en Brampton",
    "",
  ]);
  assert.deepEqual(table.orderRows[0].slice(6), [4, 2]);
  assert.deepEqual(table.totalRow.slice(6), ["=SUM(G3:G)", "=SUM(H3:H)"]);
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
  assert.equal(table.orderRows[0][6], 5);
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

  assert.equal(table.headers.length, 16);
  assert.equal(table.orderRows[0].length, 16);
  assert.equal(table.totalRow[15], "=SUM(P3:P)");
});

test("muestra cuando falta elegir entrega o recogida", () => {
  assert.equal(fulfillmentLabel({}), "Por definir");
  assert.equal(
    fulfillmentLabel({ fulfillmentType: "PICKUP" }),
    "Recoger",
  );
});
