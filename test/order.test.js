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
      subtotal: "20000",
      total: "20000",
      products: [
        {
          id: "concha-chocolate",
          name: "Concha de chocolate",
          quantity: 4,
          price: "2500",
        },
      ],
    },
  });

  assert.equal(result.summary.orderId, "WA-123");
  assert.equal(result.summary.phone, "19055550123");
  assert.equal(result.summary.customerName, "Ana");
  assert.equal(result.summary.total, 10);
  assert.equal(result.summary.status, "ESPERANDO_DATOS");
  assert.equal(result.summary.productSummary, "4 x Concha de chocolate");
  assert.equal(result.items[0].quantity, 4);
  assert.equal(result.items[0].lineTotal, 10);
});

test("produce filas con el numero correcto de columnas", () => {
  const result = normalizeOrder({
    message: { orderId: "WA-456", from: "1@c.us" },
    order: {
      products: [
        { id: "bolillo", name: "Bolillo", quantity: 2, price: 1000 },
      ],
    },
  });

  assert.equal(summaryRow(result.summary).length, 26);
  assert.equal(itemRow(result.items[0]).length, 9);
});

test("separa Delivery Brampton de los productos de cocina", () => {
  const result = normalizeOrder({
    message: { orderId: "WA-DELIVERY", from: "1@lid" },
    order: {
      currency: "CAD",
      total: 8500,
      products: [
        { id: "test", name: "Test", quantity: 1, price: 3500 },
        {
          id: "delivery-brampton",
          name: "Delivery en Brampton",
          quantity: 1,
          price: 5000,
        },
      ],
    },
  });

  assert.equal(result.summary.total, 3.5);
  assert.equal(result.summary.deliveryFee, 5);
  assert.equal(result.summary.grandTotal, 8.5);
  assert.equal(result.summary.fulfillmentType, "DELIVERY");
  assert.equal(result.summary.city, "BRAMPTON");
  assert.equal(result.summary.productSummary, "1 x Test");
  assert.equal(result.items[1].isLogistics, true);
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
