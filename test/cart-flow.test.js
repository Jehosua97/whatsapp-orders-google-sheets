"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  advanceCartConversation,
  cartReceivedMessage,
  createCartSession,
} = require("../src/cart-flow");
const {
  ConversationStateStore,
} = require("../src/conversation-flow");
const { normalizeOrder } = require("../src/order");
const {
  handleCartConversationMessage,
} = require("../src/whatsapp");

const config = {
  minimumOrderPieces: 5,
  menuPrices: {
    chocolate: 3.5,
    vanilla: 3.5,
    bolillo: 2.5,
  },
  pickupTimeWindow: "4:00 PM a 6:00 PM",
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

function normalizedCart(products = null) {
  return normalizeOrder({
    message: {
      orderId: "WA-CART-123",
      from: "14378781645@c.us",
      id: { _serialized: "message-cart-123" },
    },
    order: {
      currency: "CAD",
      products:
        products || [
          {
            id: "chocolate",
            name: "Conchita Chocolate",
            quantity: 5,
            price: 3500,
            currency: "CAD",
          },
          {
            id: "delivery-brampton",
            name: "Delivery en Brampton",
            quantity: 1,
            price: 5000,
            currency: "CAD",
          },
        ],
    },
    customerName: "Ana",
    customerPhone: "14378781645",
    deliveryFees: config.deliveryFees,
  });
}

function advance(session, input) {
  return advanceCartConversation(session, input, config, monday);
}

test("el carrito pregunta pickup o delivery e ignora productos logisticos", () => {
  const session = createCartSession(normalizedCart());
  const received = cartReceivedMessage(session, config);

  assert.equal(session.step, "CART_FULFILLMENT");
  assert.equal(session.cartOrder.items.length, 1);
  assert.equal(session.cartOrder.items[0].productName, "Conchita Chocolate");
  assert.match(received, /Pickup GRATIS/);
  assert.match(received, /Delivery a domicilio/);
  assert.doesNotMatch(received, /1 Delivery en Brampton/);
});

test("completa un carrito con pickup gratis solamente despues de SI", () => {
  let session = createCartSession(normalizedCart());

  let result = advance(session, "1");
  session = result.session;
  assert.equal(session.step, "CART_DAY");
  assert.match(result.messages[0], /4:00 PM a 6:00 PM/);

  result = advance(session, "1");
  session = result.session;
  assert.equal(session.step, "CART_CONFIRMATION");
  assert.equal(result.completed, undefined);

  result = advance(session, "SI");
  assert.equal(result.completed, true);
  assert.equal(result.session.step, "CART_COMPLETED");
  assert.equal(result.session.cartOrder.summary.fulfillmentType, "PICKUP");
  assert.equal(result.session.cartOrder.summary.deliveryFee, 0);
  assert.equal(result.session.cartOrder.summary.grandTotal, 17.5);
  assert.equal(result.session.cartOrder.summary.status, "CONFIRMADO");
});

test("delivery solicita ciudad y direccion y aplica la tarifa correcta", () => {
  let session = createCartSession(normalizedCart());

  session = advance(session, "2").session;
  assert.equal(session.step, "CART_CITY");

  session = advance(session, "2").session;
  assert.equal(session.step, "CART_ADDRESS");

  const mapsUrl = "https://maps.google.com/?q=43.7,-79.7";
  session = advance(session, mapsUrl).session;
  assert.equal(session.step, "CART_DAY");
  assert.equal(session.deliveryAddress, mapsUrl);

  session = advance(session, "1").session;
  const result = advance(session, "SI");
  const order = result.session.cartOrder;
  assert.equal(order.summary.fulfillmentType, "DELIVERY");
  assert.equal(order.summary.city, "MISSISSAUGA");
  assert.equal(order.summary.address, mapsUrl);
  assert.equal(order.summary.deliveryFee, 8);
  assert.equal(order.summary.grandTotal, 25.5);
});

test("una instruccion inesperada no crea productos undefined", () => {
  const session = createCartSession(normalizedCart());
  const result = advance(session, "quitar producto");

  assert.equal(result.session.step, "CART_FULFILLMENT");
  assert.match(result.messages[0], /Responde con 1 o 2/);
  assert.doesNotMatch(result.messages[0], /undefined/i);
});

test("el manejador de carrito no guarda antes de la confirmacion final", async () => {
  const state = new ConversationStateStore(
    path.join(
      os.tmpdir(),
      `lacenaduria-cart-${process.pid}-${Date.now()}.json`,
    ),
  );
  const chatId = "14378781645@c.us";
  state.set(chatId, createCartSession(normalizedCart()));

  const savedOrders = [];
  const replies = [];
  const store = {
    saveOrder: async (order) => {
      savedOrders.push(order);
      return { inserted: true };
    },
    replaceOrder: async () => {},
    updateOrder: async () => {},
  };
  const send = async (body) =>
    handleCartConversationMessage({
      message: {
        from: chatId,
        body,
        reply: async (text) => replies.push(text),
      },
      store,
      config,
      conversationState: state,
      logger: { log() {} },
    });

  await send("1");
  await send("1");
  assert.equal(savedOrders.length, 0);

  await send("SI");
  assert.equal(savedOrders.length, 1);
  assert.equal(savedOrders[0].summary.fulfillmentType, "PICKUP");
  assert.match(replies.at(-1), /pedido fue confirmado/i);
});
