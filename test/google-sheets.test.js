"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fulfillmentLabel,
  kitchenRow,
  KITCHEN_HEADERS,
} = require("../src/google-sheets");

test("crea una fila sencilla para cocina", () => {
  const row = kitchenRow(
    {
      receivedAt: "2026-07-24T16:00:00.000Z",
      customerName: "Ana",
      phone: "19055550123",
      fulfillmentType: "DELIVERY",
      city: "BRAMPTON",
      requestedDate: "",
      timeWindow: "",
      customerNotes: "",
      orderId: "WA-123",
      chatId: "chat@lid",
    },
    { productName: "Concha de chocolate", quantity: 4 },
  );

  assert.equal(row.length, KITCHEN_HEADERS.length);
  assert.equal(row[1], "Ana");
  assert.equal(row[3], "Concha de chocolate");
  assert.equal(row[4], 4);
  assert.equal(row[5], "Entrega en Brampton");
});

test("muestra cuando falta elegir entrega o recogida", () => {
  assert.equal(fulfillmentLabel({}), "Por definir");
  assert.equal(
    fulfillmentLabel({ fulfillmentType: "PICKUP" }),
    "Recoger",
  );
});
