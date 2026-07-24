"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateTotals,
  validateConfirmation,
} = require("../src/admin-server");

const fees = { brampton: 5, mississauga: 8 };

test("calcula total final para entrega", () => {
  const result = calculateTotals(
    { total: 20 },
    {
      fulfillmentType: "DELIVERY",
      city: "MISSISSAUGA",
      deliveryFee: "",
    },
    fees,
  );
  assert.equal(result.deliveryFee, 8);
  assert.equal(result.grandTotal, 28);
});

test("recogida siempre tiene costo cero", () => {
  const result = calculateTotals(
    { total: 20 },
    { fulfillmentType: "PICKUP", deliveryFee: 8 },
    fees,
  );
  assert.equal(result.deliveryFee, 0);
  assert.equal(result.grandTotal, 20);
});

test("exige datos operativos antes de confirmar", () => {
  assert.deepEqual(
    validateConfirmation({
      fulfillmentType: "DELIVERY",
      city: "",
      address: "",
      latitude: "",
      requestedDate: "",
      timeWindow: "",
    }),
    ["fecha", "horario", "ciudad", "direccion o ubicacion"],
  );
});
