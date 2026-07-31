"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  ConversationStateStore,
} = require("../src/conversation-flow");
const {
  handleBotControlMessage,
  handleConversationMessage,
  handleLocation,
  handleSystemDisableCommand,
  isAllowedMessage,
  isDirectChatId,
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

test("solo reconoce conversaciones individuales como chats directos", () => {
  assert.equal(isDirectChatId("14165550123@c.us"), true);
  assert.equal(isDirectChatId("14165550123@s.whatsapp.net"), true);
  assert.equal(isDirectChatId("999888777666555@lid"), true);
  assert.equal(isDirectChatId("120363000000000000@g.us"), false);
  assert.equal(isDirectChatId("status@broadcast"), false);
  assert.equal(isDirectChatId("12345@newsletter"), false);
});

test("solo el negocio puede pausar y reactivar un chat individual", () => {
  const paused = new Set();
  const pauseState = {
    pause: (chatId) => paused.add(chatId),
    resume: (chatId) => paused.delete(chatId),
  };
  const logger = { log() {} };

  assert.equal(
    handleBotControlMessage({
      message: {
        fromMe: false,
        from: "customer@lid",
        body: "STOP BOT",
      },
      pauseState,
      logger,
    }),
    "",
  );
  assert.equal(paused.size, 0);

  assert.equal(
    handleBotControlMessage({
      message: {
        fromMe: true,
        to: "customer@lid",
        body: "STOP BOT",
      },
      pauseState,
      logger,
    }),
    "STOP",
  );
  assert.equal(paused.has("customer@lid"), true);

  assert.equal(
    handleBotControlMessage({
      message: {
        fromMe: true,
        to: "customer@lid",
        body: "CONTINUE BOT",
      },
      pauseState,
      logger,
    }),
    "CONTINUE",
  );
  assert.equal(paused.has("customer@lid"), false);
});

test("solo el numero autorizado puede desactivar el sistema", async () => {
  const replies = [];
  let disabled = 0;
  let shutdowns = 0;
  const disableSystem = async () => {
    disabled += 1;
  };
  const shutdownSystem = () => {
    shutdowns += 1;
  };

  const unauthorizedHandled = await handleSystemDisableCommand({
    message: {
      type: "chat",
      from: "14165550123@c.us",
      body: "DISABLE SYSTEM",
      reply: async (value) => replies.push(value),
    },
    client: {},
    allowedPhone: "4378781645",
    disableSystem,
    shutdownSystem,
    logger: { log() {} },
  });
  assert.equal(unauthorizedHandled, true);
  assert.equal(disabled, 0);
  assert.equal(shutdowns, 0);
  assert.equal(replies.length, 0);

  const authorizedHandled = await handleSystemDisableCommand({
    message: {
      type: "chat",
      from: "14378781645@c.us",
      body: "disable system",
      reply: async (value) => replies.push(value),
    },
    client: {},
    allowedPhone: "4378781645",
    disableSystem,
    shutdownSystem,
    logger: { log() {} },
  });
  assert.equal(authorizedHandled, true);
  assert.equal(disabled, 1);
  assert.equal(shutdowns, 1);
  assert.deepEqual(replies, [
    "Sistema desactivado. El bot no volvera a iniciar automaticamente.",
  ]);
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

test("autoriza solamente telefonos configurados aunque WhatsApp use LID", async () => {
  const allowedPhones = new Set(["15550001111"]);
  const client = {
    getContactLidAndPhone: async ([chatId]) => [
      {
        lid: chatId,
        pn:
          chatId === "allowed@lid"
            ? "15550001111@c.us"
            : "15559999999@c.us",
      },
    ],
  };

  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "15550001111@c.us",
      allowedChatIds: new Set(),
      allowedPhones,
    }),
    true,
  );
  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "allowed@lid",
      allowedChatIds: new Set(),
      allowedPhones,
    }),
    true,
  );
  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "other@lid",
      allowedChatIds: new Set(),
      allowedPhones,
    }),
    false,
  );
});

test("el modo normal responde a todos excepto numeros bloqueados", async () => {
  const client = {
    getContactLidAndPhone: async ([chatId]) => [
      {
        lid: chatId,
        pn:
          chatId === "blocked@lid"
            ? "15559999999@c.us"
            : "15550001111@c.us",
      },
    ],
  };

  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "customer@lid",
      allowedChatIds: new Set(),
      allowedPhones: new Set(),
      blockedPhones: new Set(["15559999999"]),
      mode: "NORMAL",
    }),
    true,
  );
  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "blocked@lid",
      allowedChatIds: new Set(),
      allowedPhones: new Set(["15559999999"]),
      blockedPhones: new Set(["15559999999"]),
      mode: "NORMAL",
    }),
    false,
  );
  assert.equal(
    await isAllowedMessage({
      client,
      chatId: "120363000000000000@g.us",
      allowedChatIds: new Set(["120363000000000000@g.us"]),
      allowedPhones: new Set(),
      blockedPhones: new Set(),
      mode: "NORMAL",
    }),
    false,
  );
});

test("la respuesta de ubicacion no pide confirmar la ciudad", () => {
  const reply = locationReceivedReply();
  assert.match(reply, /recibimos tu ubicacion/i);
  assert.match(reply, /validaremos el horario de entrega/i);
  assert.doesNotMatch(reply, /Brampton|Mississauga/i);
});

test("la respuesta de recogida usa el horario configurable", () => {
  const reply = pickupReply("4:30 p.m. a 5:30 p.m.");
  assert.match(reply, /154 Royal Palm Dr, Brampton/i);
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

  for (const input of ["Hola", "4", "5", "0", "3", "2", "1"]) {
    await send(input);
  }
  assert.equal(savedOrders.length, 0);

  await send("SI");
  assert.equal(savedOrders.length, 1);
  assert.equal(savedOrders[0].summary.total, 25);
  assert.match(replies.at(-1), /Pedido confirmado, Ana/);

  for (const input of ["agregar", "3", "2", "SI"]) {
    await send(input);
  }
  assert.equal(replacedOrders.length, 1);
  assert.equal(replacedOrders[0].summary.total, 30);
  assert.match(replies.at(-1), /pedido fue actualizado/i);

  for (const input of ["cancelar", "SI"]) {
    await send(input);
  }
  assert.equal(orderUpdates.length, 1);
  assert.equal(orderUpdates[0].patch.kitchenStatus, "Cancelado");
  assert.match(replies.at(-1), /pedido fue cancelado/i);
});
