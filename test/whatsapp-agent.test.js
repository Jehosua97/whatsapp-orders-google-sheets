"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AI_DISCLOSURE,
  SAFE_MODE_REPLY,
  handleAgentMessage,
  ingestEvent,
  newAgentSession,
  plainWhatsAppText,
} = require("../src/whatsapp-agent");

const config = {
  aiEnabled: true,
  agentMaxSteps: 6,
  agentTranscriptTurns: 12,
  minimumOrderPieces: 5,
  pickupAddress: "154 Royal Palm Dr",
  pickupTimeWindow: "5:00 p.m. a 6:00 p.m.",
  whatsappPriceDivisor: 1000,
  deliveryFees: { brampton: 0, mississauga: 8 },
  promotions: { freeBramptonDelivery: true },
  catalog: [
    {
      id: "chocolate",
      name: "Conchitas Chocolate",
      promptName: "Conchitas de Chocolate",
      sheetName: "Concha de chocolate",
      price: 3.5,
      productionWeekdays: [3, 6],
      active: true,
    },
  ],
  schedules: [],
  closures: [],
};

function memorySessions(initial = {}) {
  const values = { ...initial };
  return {
    get: (id) => values[id] || null,
    set: (id, value) => {
      values[id] = JSON.parse(JSON.stringify(value));
      return values[id];
    },
    values,
  };
}

function chatMessage(body, replies) {
  return {
    from: "customer@lid",
    type: "chat",
    body,
    id: { _serialized: "message-1" },
    reply: async (text) => replies.push(text),
  };
}

test("un saludo recibe una sola respuesta del agente y aviso sólo al inicio", async () => {
  const replies = [];
  const sessions = memorySessions();
  const aiAssistant = {
    enabled: () => true,
    circuitOpen: () => false,
    requestWithTools: async () => ({
      text: "Hola, hoy tengo conchitas de chocolate. ¿Te preparo algunas?",
      output: [],
    }),
  };
  await handleAgentMessage({
    message: chatMessage("Hola, ¿qué tienes?", replies),
    customer: { name: "Ana", phone: "14370000000" },
    config,
    sessionStore: sessions,
    aiAssistant,
    store: {},
    loadOrder: async () => {},
    logger: { log() {}, error() {} },
    now: new Date("2026-08-28T16:00:00Z"),
  });
  assert.equal(replies.length, 1);
  assert.ok(replies[0].startsWith(AI_DISCLOSURE));
  assert.equal(sessions.values["customer@lid"].transcript.length, 2);

  await handleAgentMessage({
    message: chatMessage("Sí, quiero seis", replies),
    customer: { name: "Ana", phone: "14370000000" },
    config,
    sessionStore: sessions,
    aiAssistant,
    store: {},
    loadOrder: async () => {},
    logger: { log() {}, error() {} },
    now: new Date("2026-08-28T16:01:00Z"),
  });
  assert.equal(replies.length, 2);
  assert.equal(replies[1].startsWith(AI_DISCLOSURE), false);
});

test("el texto enviado a WhatsApp elimina markdown y barras de formato", () => {
  assert.equal(
    plainWhatsAppText(
      "Perfecto: *5 Chocolate* y \\**3 Vainilla***.\\\nTotal: **$28 CAD**",
    ),
    "Perfecto: 5 Chocolate y 3 Vainilla.\nTotal: $28 CAD",
  );
});

test("OpenAI caído conserva el mensaje en una fila manual y responde una vez", async () => {
  const replies = [];
  const sessions = memorySessions();
  const saved = [];
  await handleAgentMessage({
    message: chatMessage("Quiero doce conchas", replies),
    customer: { name: "Ana", phone: "14370000000" },
    config,
    sessionStore: sessions,
    aiAssistant: { enabled: () => false, circuitOpen: () => false },
    store: {
      getOrder: async () => null,
      saveOrder: async (order) => {
        saved.push(order);
        return { inserted: true };
      },
    },
    loadOrder: async () => {},
    logger: { log() {}, error() {} },
    now: new Date("2026-08-28T16:00:00Z"),
  });
  assert.deepEqual(replies, [SAFE_MODE_REPLY]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].summary.status, "REVISION_MANUAL");
  assert.match(saved[0].summary.customerNotes, /doce conchas/i);
});

test("un carrito siembra sólo productos reconocidos sin confiar en su precio", async () => {
  const current = newAgentSession({ chatId: "customer@lid" });
  const message = {
    from: "customer@lid",
    type: "order",
    orderId: "WA-CART-1",
    id: { _serialized: "cart-message" },
  };
  const event = await ingestEvent({
    message,
    session: current,
    config,
    customer: { name: "Ana", phone: "14370000000" },
    loadOrder: async () => ({
      currency: "CAD",
      products: [
        {
          id: "chocolate",
          name: "Conchitas Chocolate",
          quantity: 6,
          price: 999000,
          currency: "CAD",
        },
        {
          id: "inventado",
          name: "Producto inventado",
          quantity: 4,
          price: 1000,
          currency: "CAD",
        },
      ],
    }),
    now: new Date("2026-08-28T16:00:00Z"),
  });
  assert.deepEqual(current.draft.items, [
    { product_id: "chocolate", cantidad: 6 },
  ]);
  assert.equal(current.draft.origen, "CARRITO");
  assert.deepEqual(event.seeded.unmatched, ["Producto inventado"]);
  assert.match(current.transcript[0].content, /no reconocidos/i);
});

test("una ubicación entra al transcript como evidencia exacta del cliente", async () => {
  const current = newAgentSession({ chatId: "customer@lid" });
  await ingestEvent({
    message: {
      from: "customer@lid",
      type: "location",
      location: {
        description: "15 Appleby Dr, Brampton",
        latitude: 43.7,
        longitude: -79.7,
      },
      id: { _serialized: "location-1" },
    },
    session: current,
    config,
    customer: {},
    loadOrder: async () => {},
  });
  assert.equal(current.ultima_ubicacion, "15 Appleby Dr, Brampton");
  assert.match(current.transcript[0].content, /15 Appleby Dr, Brampton/);
});
