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

function completedCartSession() {
  let session = createCartSession(normalizedCart());
  session = advance(session, "1").session;
  session = advance(session, "1").session;
  return advance(session, "SI").session;
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
  assert.match(result.messages[0], /154 Royal Palm Dr, Brampton/);

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
  assert.equal(
    result.session.cartOrder.summary.address,
    "154 Royal Palm Dr, Brampton",
  );
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

test("un texto cualquiera responde con el carrito confirmado", () => {
  const session = completedCartSession();
  const result = advance(session, "tengo una pregunta");

  assert.equal(result.session.step, "CART_COMPLETED");
  assert.equal(result.session.orderId, session.orderId);
  assert.match(result.messages[0], /Este es tu pedido confirmado/);
  assert.match(result.messages[0], /Actualizar pedido/);
});

test("permite agregar y quitar productos de un carrito confirmado", () => {
  let result = advance(completedCartSession(), "agregar producto");
  let session = result.session;
  assert.equal(session.step, "CART_UPDATE_PRODUCT");
  assert.match(result.messages[0], /Qué producto deseas agregar/);
  assert.match(result.messages[0], /Conchitas de Vainilla/);

  session = advance(session, "2").session;
  result = advance(session, "2");
  session = result.session;
  assert.equal(session.step, "CART_UPDATE_CONFIRMATION");
  assert.equal(session.cartOrder.items.length, 2);
  assert.equal(session.cartOrder.summary.total, 24.5);
  assert.match(result.messages[0], /2 Concha de Vainilla/);

  result = advance(session, "SI");
  session = result.session;
  assert.equal(result.updated, true);
  assert.equal(session.step, "CART_COMPLETED");

  session = advance(session, "quitar").session;
  assert.equal(session.step, "CART_UPDATE_PRODUCT");
  session = advance(session, "1").session;
  result = advance(session, "1");
  assert.equal(result.session.cartOrder.summary.total, 21);
  assert.match(result.messages[0], /4 Conchita Chocolate/);
});

test("al agregar un producto existente no crea una linea duplicada", () => {
  let session = advance(completedCartSession(), "agregar").session;
  session = advance(session, "1").session;
  const result = advance(session, "1");

  assert.equal(result.session.cartOrder.items.length, 1);
  assert.equal(result.session.cartOrder.items[0].quantity, 6);
  assert.equal(result.session.cartOrder.summary.total, 21);
});

test("NO descarta los cambios de productos del carrito", () => {
  let session = advance(completedCartSession(), "agregar").session;
  session = advance(session, "2").session;
  session = advance(session, "2").session;
  assert.equal(session.cartOrder.summary.total, 24.5);

  const result = advance(session, "NO");
  assert.equal(result.session.step, "CART_COMPLETED");
  assert.equal(result.session.cartOrder.items.length, 1);
  assert.equal(result.session.cartOrder.summary.total, 17.5);
});

test("un carrito actualizado conserva el minimo de piezas", () => {
  let session = advance(completedCartSession(), "quitar").session;
  session = advance(session, "1").session;
  const result = advance(session, "2");

  assert.equal(result.session.step, "CART_UPDATE_QUANTITY");
  assert.match(result.messages[0], /al menos 5 piezas/i);
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
  const replacedOrders = [];
  const replies = [];
  const store = {
    saveOrder: async (order) => {
      savedOrders.push(order);
      return { inserted: true };
    },
    replaceOrder: async (order) => {
      replacedOrders.push(order);
    },
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

  await send("agregar");
  await send("2");
  await send("2");
  assert.equal(replacedOrders.length, 0);

  await send("SI");
  assert.equal(replacedOrders.length, 1);
  assert.equal(replacedOrders[0].summary.total, 24.5);
  assert.match(replies.at(-1), /consultar tu pedido escribe HOLA/i);
});
