"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectCity,
  detectPostalCode,
  parseFulfillmentText,
} = require("../src/fulfillment");

const fees = { brampton: 5, mississauga: 8 };

test("reconoce entrega en Brampton", () => {
  const result = parseFulfillmentText(
    "Necesito entrega en Brampton, L6X 1A1",
    fees,
  );

  assert.equal(result.fulfillmentType, "DELIVERY");
  assert.equal(result.city, "BRAMPTON");
  assert.equal(result.deliveryFee, 5);
  assert.equal(result.postalCode, "L6X 1A1");
  assert.equal(result.status, "ESPERANDO_HORARIO");
});

test("reconoce variantes de Mississauga", () => {
  assert.equal(detectCity("Estoy en missisauga"), "MISSISSAUGA");
  assert.equal(
    parseFulfillmentText("delivery Mississauga", fees).deliveryFee,
    8,
  );
});

test("reconoce recogida sin costo", () => {
  const result = parseFulfillmentText(
    "Prefiero recoger el sabado por la tarde",
    fees,
  );

  assert.equal(result.fulfillmentType, "PICKUP");
  assert.equal(result.deliveryFee, 0);
  assert.equal(result.status, "ESPERANDO_HORARIO");
});

test("ignora conversaciones que no describen recepcion", () => {
  assert.equal(parseFulfillmentText("Muchas gracias", fees), null);
  assert.equal(detectPostalCode("sin codigo"), "");
});
