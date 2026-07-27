"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  ConversationStateStore,
} = require("../src/conversation-flow");
const {
  handleConversationMessage,
  handleLocation,
  locationReceivedReply,
  phoneFromWhatsAppId,
  pickupReply,
  resolvePhoneNumber,
} = require("../src/whatsapp");

test("extrae un telefono de un ID telefonico de WhatsApp", () => {
  assert.equal(phoneFromWhatsAppId("14165550123@c.us"), "14165550123");
  assert.equal(
    phoneFromWhatsAppId("14165550123@s.whatsapp.net"),
    "14165550123",
  );
});

test("nunca presenta un LID como numero telefonico", () => {
  assert.equal(phoneFromWhatsAppId("999888777666555@lid"), "");
});

test("resuelve el numero asociado a un chat LID", async () => {
  const client = {
    getContactLidAndPhone: async () => [
      {
        lid: "999888777666555@lid",
        pn: "14165550123@c.us",
      },
    ],
  };

  const phone = await resolvePhoneNumber(
    client,
    "999888777666555@lid",
    { number: "999888777666555" },
  );
  assert.equal(phone, "14165550123");
});

test("deja el telefono vacio si WhatsApp no revela el mapeo del LID", async () => {
  const client = {
    getContactLidAndPhone: async () => [],
  };

  const phone = await resolvePhoneNumber(
    client,
    "999888777666555@lid",
    { number: "999888777666555" },
  );
  assert.equal(phone, "");
});

test("la respuesta de ubicacion no pide confirmar la ciudad", () => {
  const reply = locationReceivedReply();
  assert.match(reply, /recibimos tu ubicacion/i);
  assert.match(reply, /validaremos el horario de entrega/i);
  assert.doesNotMatch(reply, /Brampton|Mississauga/i);
});

test("la respuesta de recogida usa el horario configurable", () => {
  const reply = pickupReply("4:30 p.m. a 5:30 p.m.");
  assert.match(reply, /mandaremos la direccion/i);
  assert.match(reply, /4:30 p\.m\. a 5:30 p\.m\./i);
});

test("conserva la ciudad del catalogo al recibir una ubicacion", async () => {
  let savedPatch;
  let sentReply;
  const store = {
    getPendingOrderByChat: async () => ({
      orderId: "WA-123",
      city: "BRAMPTON",
      total: 10,
      currency: "CAD",
    }),
    updateOrder: async (_orderId, patch) => {
      savedPatch = patch;
    },
  };
  const message = {
    from: "test@lid",
    location: {
      description: "123 Main Street",
      latitude: 43.7,
      longitude: -79.7,
    },
    reply: async (text) => {
      sentReply = text;
    },
  };

  await handleLocation({
    message,
    store,
    config: { deliveryFees: { brampton: 5, mississauga: 8 } },
  });

  assert.equal(savedPatch.city, "BRAMPTON");
  assert.equal(savedPatch.deliveryFee, 5);
  assert.equal(sentReply, locationReceivedReply());
});

test("el manejador guarda solamente despues de recibir SI", async () => {
  const state = new ConversationStateStore(
    path.join(
      os.tmpdir(),
      `lacenaduria-handler-${process.pid}-${Date.now()}.json`,
    ),
  );
  const replies = [];
  const savedOrders = [];
  const replacedOrders = [];
  const orderUpdates = [];
  const client = {};
  const store = {
    saveOrder: async (order) => {
      savedOrders.push(order);
      return { inserted: true };
    },
    replaceOrder: async (order) => {
      replacedOrders.push(order);
    },
    updateOrder: async (orderId, patch) => {
      orderUpdates.push({ orderId, patch });
    },
  };
  const config = {
    conversationStateFile: state.file,
    minimumOrderPieces: 5,
    menuPrices: { chocolate: 3.5, vanilla: 3.5, bolillo: 2.5 },
    deliveryWindows: {
      wednesday: "después de las 3:00 PM",
      saturday: "después de las 10:00 AM",
    },
    deliveryFees: { brampton: 5, mississauga: 8 },
  };
  const send = async (body) =>
    handleConversationMessage({
      message: {
        from: "14370000000@c.us",
        type: "chat",
        body,
        id: { _serialized: `message-${body}` },
        getContact: async () => ({
          pushname: "Ana",
          id: { _serialized: "14370000000@c.us" },
          number: "14370000000",
        }),
        reply: async (text) => replies.push(text),
      },
      client,
      store,
      config,
      conversationState: state,
      logger: { log() {} },
    });

  for (const input of ["Hola", "1", "5", "0", "3", "2", "1"]) {
    await send(input);
  }
  assert.equal(savedOrders.length, 0);

  await send("SI");
  assert.equal(savedOrders.length, 1);
  assert.equal(savedOrders[0].summary.total, 25);
  assert.match(replies.at(-1), /Pedido confirmado, Ana/);

  for (const input of ["agregar", "1", "3", "2", "SI"]) {
    await send(input);
  }
  assert.equal(replacedOrders.length, 1);
  assert.equal(replacedOrders[0].summary.total, 30);
  assert.match(replies.at(-1), /pedido fue actualizado/i);

  for (const input of ["cancelar", "5", "SI"]) {
    await send(input);
  }
  assert.equal(orderUpdates.length, 1);
  assert.equal(orderUpdates[0].patch.kitchenStatus, "Cancelado");
  assert.match(replies.at(-1), /pedido fue cancelado/i);
});
