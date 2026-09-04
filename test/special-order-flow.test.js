"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  advanceSpecialSession,
  buildSpecialOrder,
  startSpecialSession,
} = require("../src/special-order-flow");

function baseSession() {
  return {
    orderId: "CHAT-BASE",
    chatId: "14370000000@c.us",
    customerName: "Ana",
    customerPhone: "14370000000",
    step: "DAY",
    quantities: { chocolate: 8 },
  };
}

test("una pregunta solamente ofrece tomar la solicitud especial", () => {
  const session = startSpecialSession({
    session: baseSession(),
    request: {
      productName: "pan de muerto",
      quantity: 0,
      wantsRequest: false,
    },
    customerMessage: "¿Tienen pan de muerto?",
    returnPrompt: "¿Para qué día quieres tus conchas?",
  });
  const result = advanceSpecialSession({
    session,
    request: { wantsRequest: false },
    customerMessage: "¿Tienen pan de muerto?",
  });

  assert.equal(result.session.step, "SPECIAL_OFFER");
  assert.match(result.reply, /solicitud especial/i);
  assert.match(result.reply, /¿Quieres que la tome?/i);
});

test("recopila un pedido especial y lo prepara para el Excel", () => {
  let session = startSpecialSession({
    session: baseSession(),
    request: {
      productName: "roles de canela",
      quantity: 10,
      wantsRequest: true,
    },
    customerMessage: "Quiero 10 roles de canela",
    returnPrompt: "¿Para qué día quieres tus conchas?",
    now: new Date("2026-08-28T12:00:00Z"),
  });

  let result = advanceSpecialSession({
    session,
    request: {},
    customerMessage: "Quiero 10 roles de canela",
  });
  assert.equal(result.session.step, "SPECIAL_DETAILS");
  assert.match(result.reply, /fecha/i);

  session = result.session;
  result = advanceSpecialSession({
    session,
    request: { requestedDate: "sábado" },
    customerMessage: "Para este sábado",
  });
  assert.match(result.reply, /pickup o delivery/i);

  session = result.session;
  result = advanceSpecialSession({
    session,
    request: { fulfillment: "PICKUP" },
    customerMessage: "Pickup por favor",
  });
  assert.equal(result.session.step, "SPECIAL_CONFIRMATION");
  assert.match(result.reply, /Precio, disponibilidad y horario: por confirmar/i);

  session = result.session;
  result = advanceSpecialSession({
    session,
    request: {},
    customerMessage: "Sí, envíala",
  });
  assert.equal(result.save, true);
  assert.equal(result.nextSession.step, "DAY");
  assert.deepEqual(result.nextSession.quantities, { chocolate: 8 });

  const order = buildSpecialOrder(result.session, {
    id: { _serialized: "message-special" },
  });
  assert.equal(order.summary.status, "REVISION_MANUAL");
  assert.equal(order.summary.kitchenStatus, "Por confirmar");
  assert.equal(order.summary.requestedDate, "sábado");
  assert.equal(order.summary.fulfillmentType, "PICKUP");
  assert.equal(order.items[0].productName, "roles de canela");
  assert.equal(order.items[0].quantity, 10);
  assert.equal(order.items[0].unitPrice, "");
});
