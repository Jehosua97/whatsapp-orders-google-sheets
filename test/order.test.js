"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { itemRow, normalizeOrder, summaryRow } = require("../src/order");

test("normaliza un carrito de WhatsApp", () => {
  const result = normalizeOrder({
    message: {
      orderId: "WA-123",
      from: "19055550123@c.us",
      id: { _serialized: "message-1" },
    },
    customerName: "Ana",
    order: {
      currency: "CAD",
      subtotal: "20.00",
      total: "20.00",
      products: [
        {
          id: "concha-chocolate",
          name: "Concha de chocolate",
          quantity: 4,
          price: "2.50",
        },
      ],
    },
  });

  assert.equal(result.summary.orderId, "WA-123");
  assert.equal(result.summary.phone, "19055550123");
  assert.equal(result.summary.customerName, "Ana");
  assert.equal(result.items[0].quantity, 4);
  assert.equal(result.items[0].lineTotal, 10);
});

test("produce filas con el numero correcto de columnas", () => {
  const result = normalizeOrder({
    message: { orderId: "WA-456", from: "1@c.us" },
    order: {
      products: [{ id: "bolillo", name: "Bolillo", quantity: 2, price: 1 }],
    },
  });

  assert.equal(summaryRow(result.summary).length, 9);
  assert.equal(itemRow(result.items[0]).length, 8);
});

test("rechaza carritos vacios", () => {
  assert.throws(
    () =>
      normalizeOrder({
        message: { orderId: "WA-789", from: "1@c.us" },
        order: { products: [] },
      }),
    /no contiene productos/i,
  );
});
