"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCartSession } = require("../src/cart-flow");
const { ConversationStateStore } = require("../src/conversation-flow");
const {
  handleCartConversationMessage,
  handleConversationMessage,
} = require("../src/whatsapp");

function testConfig() {
  return {
    aiEnabled: true,
    aiRewriteResponses: true,
    minimumOrderPieces: 5,
    pickupAddress: "154 Royal Palm Dr, Brampton",
    pickupTimeWindow: "5:00 p.m. a 6:00 p.m.",
    deliveryFees: { brampton: 0, mississauga: 8 },
    deliveryWindows: {
      wednesday: "después de las 3:00 PM",
      saturday: "después de las 10:00 AM",
    },
    promotions: { freeBramptonDelivery: true },
    menuPrices: { chocolate: 3.5, vanilla: 3.5 },
    catalog: [
      {
        id: "chocolate",
        productId: "concha-chocolate",
        name: "Conchitas Chocolate",
        promptName: "Conchitas de Chocolate",
        sheetName: "Concha de chocolate",
        emoji: "🍫",
        price: 3.5,
        productionWeekdays: [3, 6],
        active: true,
      },
      {
        id: "vanilla",
        productId: "concha-vainilla",
        name: "Conchitas Vainilla",
        promptName: "Conchitas de Vainilla",
        sheetName: "Concha de Vainilla",
        emoji: "🍦",
        price: 3.5,
        productionWeekdays: [3, 6],
        active: true,
      },
    ],
    schedules: [
      {
        id: "wednesday",
        name: "Miércoles",
        weekday: 3,
        active: true,
        pickupEnabled: true,
        pickupWindow: "5:00 p.m. a 6:00 p.m.",
        deliveryEnabled: true,
        deliveryWindow: "después de las 3:00 PM",
      },
      {
        id: "saturday",
        name: "Sábado",
        weekday: 6,
        active: true,
        pickupEnabled: true,
        pickupWindow: "10:00 a.m. a 11:00 a.m.",
        deliveryEnabled: true,
        deliveryWindow: "después de las 10:00 AM",
      },
    ],
    closures: [],
  };
}

function stateStore(label) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `lacenaduria-ai-${label}-`),
  );
  return new ConversationStateStore(path.join(directory, "state.json"));
}

function customerMessage(body, replies) {
  return {
    from: "14370000000@c.us",
    type: "chat",
    body,
    id: { _serialized: `message-${Date.now()}` },
    getContact: async () => ({
      pushname: "Ana",
      id: { _serialized: "14370000000@c.us" },
      number: "14370000000",
    }),
    reply: async (text) => replies.push(text),
  };
}

const silentLogger = { log() {}, error() {} };

test("entiende producto y cantidad en una sola frase sin confirmar solo", async () => {
  const conversationState = stateStore("natural-order");
  const replies = [];
  const savedOrders = [];
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async ({ customerMessage: body }) =>
      /confirmo/i.test(body)
        ? {
            kind: "ADVANCE",
            inputs: ["SI"],
            reply: "",
            confidence: 1,
          }
        : /primera fecha/i.test(body)
          ? {
              kind: "ADVANCE",
              inputs: ["1"],
              reply: "",
              confidence: 1,
            }
        : {
            kind: "ADVANCE",
            // Pickup se conserva; el SI anticipado se descarta.
            inputs: ["2", "12", "pickup", "SI"],
            reply: "",
            confidence: 1,
          },
    rewriteVerifiedReply: async ({ verifiedReply }) => verifiedReply,
  };
  const store = {
    saveOrder: async (order) => {
      savedOrders.push(order);
      return { inserted: true };
    },
    replaceOrder: async () => {},
    updateOrder: async () => {},
  };

  await handleConversationMessage({
    message: customerMessage(
      "Buenas tardes, quiero una docena de conchas de vainilla para pickup",
      replies,
    ),
    client: {},
    store,
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  const pending = conversationState.get("14370000000@c.us");
  assert.equal(pending.step, "DAY");
  assert.equal(pending.quantities.vanilla, 12);
  assert.deepEqual(
    pending.aiDeferredInputs.map((item) => item.value),
    ["pickup"],
  );
  assert.equal(savedOrders.length, 0);
  assert.match(replies.at(-1), /¿Para qué día/i);

  await handleConversationMessage({
    message: customerMessage("La primera fecha", replies),
    client: {},
    store,
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  const confirmation = conversationState.get("14370000000@c.us");
  assert.equal(confirmation.step, "CONFIRMATION");
  assert.equal(confirmation.fulfillment.type, "PICKUP");
  assert.equal(confirmation.aiDeferredInputs, undefined);
  assert.equal(savedOrders.length, 0);
  assert.match(replies.at(-1), /¿Confirmas tu pedido\?/i);

  await handleConversationMessage({
    message: customerMessage("Sí, confirmo", replies),
    client: {},
    store,
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  assert.equal(savedOrders.length, 1);
  assert.equal(savedOrders[0].summary.total, 42);
  assert.equal(conversationState.get("14370000000@c.us").step, "COMPLETED");
});

test("responde sobre un producto inexistente sin modificar el pedido", async () => {
  const conversationState = stateStore("catalog-question");
  const replies = [];
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async () => ({
      kind: "ANSWER",
      answerType: "CATALOG",
      productIds: [],
      inputs: [],
      reply:
        "Por ahora el pan de muerto no aparece disponible en nuestro catálogo.",
      confidence: 0.99,
    }),
    rewriteVerifiedReply: async ({ verifiedReply }) => verifiedReply,
  };

  await handleConversationMessage({
    message: customerMessage("Hola, ¿tienes pan de muerto?", replies),
    client: {},
    store: {},
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  assert.equal(conversationState.get("14370000000@c.us").step, "MENU");
  assert.match(replies[0], /no aparece disponible/i);
  assert.match(replies[0], /NUESTRO MENU/i);
});

test("nunca convierte pan de muerto en un producto distinto del catalogo", async () => {
  const conversationState = stateStore("wrong-product-guard");
  const replies = [];
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async () => ({
      kind: "ADVANCE",
      answerType: "NONE",
      productIds: [],
      inputs: ["1", "8"],
      reply: "",
      confidence: 0.99,
    }),
    rewriteVerifiedReply: async ({ verifiedReply }) => verifiedReply,
  };

  await handleConversationMessage({
    message: customerMessage("8 panes de muerto", replies),
    client: {},
    store: {},
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  const session = conversationState.get("14370000000@c.us");
  assert.equal(session.step, "MENU");
  assert.deepEqual(session.quantities, {});
  assert.match(replies[0], /^🤖 Aviso: Mensajes generados con IA/);
  assert.match(replies[0], /pedido especial/i);
  assert.match(replies[0], /Conchitas Chocolate/i);
  assert.match(replies[0], /Conchitas Vainilla/i);
});

test("un pedido especial no altera el pedido que ya estaba en curso", async () => {
  const conversationState = stateStore("special-during-order");
  const replies = [];
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async ({ customerMessage: body }) => ({
      kind: "ADVANCE",
      answerType: "NONE",
      productIds: [],
      inputs: /roles/i.test(body) ? ["1"] : ["1", "8"],
      reply: "",
      confidence: 0.99,
    }),
    rewriteVerifiedReply: async ({ verifiedReply }) => verifiedReply,
  };

  await handleConversationMessage({
    message: customerMessage("Quiero 8 conchas de chocolate", replies),
    client: {},
    store: {},
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });
  assert.equal(conversationState.get("14370000000@c.us").step, "DAY");

  await handleConversationMessage({
    message: customerMessage("Quiero tambien 10 roles de canela", replies),
    client: {},
    store: {},
    config: testConfig(),
    conversationState,
    aiAssistant,
    lastBotMessage: "📅 ¿Para qué día quieres tu entrega?",
    logger: silentLogger,
  });

  const session = conversationState.get("14370000000@c.us");
  assert.equal(session.step, "DAY");
  assert.deepEqual(session.quantities, { chocolate: 8 });
  assert.match(replies.at(-1), /pedido especial/i);
  assert.match(replies.at(-1), /¿Para qué día/i);
});

test("si OpenAI falla inicia el flujo tradicional sin perder el mensaje", async () => {
  const conversationState = stateStore("fallback");
  const replies = [];
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async () => {
      throw new Error("timeout de prueba");
    },
  };

  await handleConversationMessage({
    message: customerMessage("Hola", replies),
    client: {},
    store: {},
    config: testConfig(),
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  assert.equal(conversationState.get("14370000000@c.us").step, "MENU");
  assert.match(replies[0], /NUESTRO MENU/i);
});

test("la IA entiende respuestas naturales del carrito y conserva la confirmacion", async () => {
  const conversationState = stateStore("cart");
  const replies = [];
  const savedOrders = [];
  const config = testConfig();
  const session = createCartSession(
    {
      summary: {
        orderId: "WA-AI-CART",
        chatId: "14370000000@c.us",
        customerName: "Ana",
        phone: "14370000000",
        total: 42,
        currency: "CAD",
        receivedAt: new Date().toISOString(),
      },
      items: [
        {
          orderId: "WA-AI-CART",
          productId: "vanilla",
          productName: "Conchitas Vainilla",
          quantity: 12,
          unitPrice: 3.5,
          lineTotal: 42,
          currency: "CAD",
          isLogistics: false,
        },
      ],
    },
    config,
  );
  conversationState.set(session.chatId, session);
  const aiAssistant = {
    enabled: () => true,
    interpretTurn: async ({ customerMessage: body }) => ({
      kind: "ADVANCE",
      inputs: /confirmo/i.test(body) ? ["SI"] : ["1", "1", "SI"],
      reply: "",
      confidence: 1,
    }),
    rewriteVerifiedReply: async ({ verifiedReply }) => verifiedReply,
  };
  const store = {
    saveOrder: async (order) => {
      savedOrders.push(order);
      return { inserted: true };
    },
    replaceOrder: async () => {},
    updateOrder: async () => {},
  };

  await handleCartConversationMessage({
    message: customerMessage("Prefiero recoger el primer día", replies),
    store,
    config,
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  assert.equal(conversationState.get(session.chatId).step, "CART_CONFIRMATION");
  assert.equal(savedOrders.length, 0);
  assert.match(replies.at(-1), /¿Confirmas tu pedido\?/i);

  await handleCartConversationMessage({
    message: customerMessage("Sí, confirmo", replies),
    store,
    config,
    conversationState,
    aiAssistant,
    logger: silentLogger,
  });

  assert.equal(savedOrders.length, 1);
  assert.equal(conversationState.get(session.chatId).step, "CART_COMPLETED");
});
