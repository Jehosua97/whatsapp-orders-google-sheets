"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  advanceConversation,
  buildTextOrder,
  confirmedMessage,
  ConversationStateStore,
  menuMessage,
  newSession,
  subtotal,
  totalPieces,
} = require("../src/conversation-flow");

const config = {
  minimumOrderPieces: 5,
  menuPrices: {
    chocolate: 3.5,
    vanilla: 3.5,
    bolillo: 2.5,
  },
  deliveryWindows: {
    wednesday: "después de las 3:00 PM",
    saturday: "después de las 10:00 AM",
  },
  deliveryFees: {
    brampton: 5,
    mississauga: 8,
  },
};

const monday = new Date("2026-07-27T15:00:00.000Z");

function answer(session, input) {
  return advanceConversation(session, input, config, monday);
}

test("recorre el flujo completo de pickup del ejemplo", () => {
  let session = newSession({
    chatId: "test@lid",
    customerName: "Lic. Gonzalez",
    customerPhone: "14370000000",
    now: monday,
  });

  assert.match(menuMessage("Pancho", config), /Mucho gusto, Pancho/);
  let result = answer(session, "1");
  session = result.session;
  assert.match(result.messages[0], /Conchitas de Chocolate/);

  result = answer(session, "5");
  session = result.session;
  assert.match(result.messages[0], /5 Conchitas de Chocolate anotadas/);
  assert.match(result.messages[0], /Conchitas de Vainilla/);

  result = answer(session, "0");
  session = result.session;
  assert.match(result.messages[0], /Bolillos/);

  result = answer(session, "3");
  session = result.session;
  assert.equal(session.step, "DAY");
  assert.equal(totalPieces(session.quantities), 8);
  assert.equal(subtotal(session.quantities, config.menuPrices), 25);
  assert.match(result.messages[0], /Subtotal: \$25\.00/);

  result = answer(session, "2");
  session = result.session;
  assert.equal(session.schedule.date, "2026-08-01");
  assert.match(result.messages[0], /Sábado anotado/);

  result = answer(session, "1");
  session = result.session;
  assert.equal(session.step, "CONFIRMATION");
  assert.match(result.messages[0], /Pickup seleccionado/);
  assert.match(result.messages[0], /TOTAL: \$25\.00/);

  result = answer(session, "SI");
  assert.equal(result.completed, true);
  assert.equal(result.session.step, "COMPLETED");

  const order = buildTextOrder(
    session,
    { id: { _serialized: "message-confirmation" } },
    config,
  );
  assert.equal(order.summary.orderId, session.orderId);
  assert.equal(order.summary.total, 25);
  assert.equal(order.summary.grandTotal, 25);
  assert.equal(order.summary.requestedDate, "2026-08-01");
  assert.equal(order.summary.fulfillmentType, "PICKUP");
  assert.equal(order.summary.status, "CONFIRMADO");
  assert.deepEqual(
    order.items
      .filter((item) => !item.isLogistics)
      .map((item) => [item.productName, item.quantity]),
    [
      ["Concha de chocolate", 5],
      ["Bolillo", 3],
    ],
  );
  assert.match(confirmedMessage(session), /Pedido confirmado, Lic\. Gonzalez/);
});

test("no permite continuar con menos de cinco piezas", () => {
  let session = newSession({
    chatId: "test@lid",
    customerName: "Ana",
    customerPhone: "",
    now: monday,
  });
  session = answer(session, "1").session;
  session = answer(session, "1").session;
  session = answer(session, "1").session;
  const result = answer(session, "1");

  assert.equal(result.session.step, "QUANTITY");
  assert.equal(result.session.productIndex, 0);
  assert.deepEqual(result.session.quantities, {});
  assert.match(result.messages[0], /pedido mínimo es de 5 piezas/i);
});

test("rechaza cantidades y opciones invalidas sin avanzar", () => {
  let session = newSession({
    chatId: "test@lid",
    customerName: "Ana",
    customerPhone: "",
    now: monday,
  });
  let result = answer(session, "9");
  assert.equal(result.session.step, "MENU");

  session = answer(session, "1").session;
  result = answer(session, "cinco");
  assert.equal(result.session.step, "QUANTITY");
  assert.equal(result.session.productIndex, 0);
});

test("calcula delivery en Brampton y espera ubicacion despues de confirmar", () => {
  let session = newSession({
    chatId: "test@lid",
    customerName: "Ana",
    customerPhone: "14370000000",
    now: monday,
  });
  for (const input of ["4", "2", "2", "1", "1", "2", "1"]) {
    session = answer(session, input).session;
  }

  assert.equal(session.step, "CONFIRMATION");
  assert.equal(session.fulfillment.city, "BRAMPTON");
  assert.equal(session.fulfillment.deliveryFee, 5);

  const order = buildTextOrder(session, {}, config);
  assert.equal(order.summary.total, 16.5);
  assert.equal(order.summary.grandTotal, 21.5);
  assert.equal(order.summary.status, "ESPERANDO_DATOS");
  assert.match(confirmedMessage(session), /Comparte tu ubicación/);
});

test("NO cancela sin completar el pedido", () => {
  const session = {
    ...newSession({
      chatId: "test@lid",
      customerName: "Ana",
      customerPhone: "",
      now: monday,
    }),
    step: "CONFIRMATION",
  };
  const result = answer(session, "NO");
  assert.equal(result.canceled, true);
  assert.equal(result.session, null);
});

test("el estado conversacional persiste en disco", () => {
  const file = path.join(
    os.tmpdir(),
    `lacenaduria-conversation-${process.pid}-${Date.now()}.json`,
  );
  const session = newSession({
    chatId: "test@lid",
    customerName: "Ana",
    customerPhone: "",
    now: monday,
  });
  const first = new ConversationStateStore(file);
  first.set("test@lid", session);

  const reloaded = new ConversationStateStore(file);
  assert.equal(reloaded.get("test@lid").orderId, session.orderId);
  reloaded.set("test@lid", null);
  assert.equal(reloaded.get("test@lid"), null);
});
