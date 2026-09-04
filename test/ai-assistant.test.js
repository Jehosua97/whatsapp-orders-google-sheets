"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OpenAiBusinessAssistant,
  buildBusinessContext,
  explicitConfirmation,
  guardNaturalPlan,
  groundedRewrite,
  normalizePlan,
  validatePlannedInput,
  verifiedKnowledgeReply,
} = require("../src/ai-assistant");

const config = {
  aiEnabled: true,
  minimumOrderPieces: 5,
  pickupAddress: "154 Royal Palm Dr, Brampton",
  deliveryFees: { brampton: 0, mississauga: 8 },
  promotions: { freeBramptonDelivery: true },
  catalog: [
    {
      id: "chocolate",
      name: "Conchitas Chocolate",
      price: 3.5,
      productionWeekdays: [3, 6],
      active: true,
    },
    {
      id: "muerto",
      name: "Pan de muerto",
      price: 4,
      productionWeekdays: [3],
      active: false,
    },
  ],
  schedules: [],
  closures: [],
};

test("la IA distingue disponibilidad semanal de capacidades del negocio", () => {
  const context = buildBusinessContext({
    customerMessage: "Tienes pan de muerto?",
    session: { step: "MENU", quantities: {} },
    config,
    now: new Date("2026-08-26T16:00:00Z"),
  });

  assert.equal(context.currentDateToronto, "2026-08-26");
  assert.deepEqual(
    context.businessTruth.catalog.map((product) => product.name),
    ["Conchitas Chocolate"],
  );
  assert.deepEqual(
    context.businessTruth.capabilities.map((product) => ({
      name: product.name,
      availableThisWeek: product.availableThisWeek,
    })),
    [
      { name: "Conchitas Chocolate", availableThisWeek: true },
      { name: "Pan de muerto", availableThisWeek: false },
    ],
  );
  assert.equal(context.businessTruth.deliveryFeesCad.brampton, 0);
});

test("una respuesta informativa nunca conserva acciones de pedido", () => {
  assert.deepEqual(
    normalizePlan({
      kind: "ANSWER",
      inputs: ["1", "12", "SI"],
      reply: "No está disponible.",
      confidence: 0.9,
    }),
    {
      kind: "ANSWER",
      answerType: "NONE",
      productIds: [],
      inputs: [],
      reply: "No está disponible.",
      confidence: 0.9,
      specialRequest: {
        productName: "",
        quantity: 0,
        requestedDate: "",
        fulfillment: "",
        city: "",
        address: "",
        notes: "",
        wantsRequest: false,
      },
      orderChanges: [],
    },
  );
});

test("construye respuestas de catalogo solamente con productos activos", () => {
  assert.match(
    verifiedKnowledgeReply(
      {
        answerType: "CATALOG",
        productIds: ["chocolate", "muerto", "inventado"],
      },
      { step: "MENU" },
      config,
    ),
    /Conchitas Chocolate · \$3\.50/i,
  );
  assert.doesNotMatch(
    verifiedKnowledgeReply(
      {
        answerType: "CATALOG",
        productIds: ["chocolate", "muerto", "inventado"],
      },
      { step: "MENU" },
      config,
    ),
    /pan de muerto|inventado/i,
  );
});

test("que pan tienes se conserva como consulta del catalogo", () => {
  const plan = guardNaturalPlan(
    {
      kind: "ANSWER",
      answerType: "CATALOG",
      productIds: ["chocolate"],
      inputs: [],
      reply: "Claro, te digo lo disponible.",
      confidence: 1,
      specialRequest: {},
      orderChanges: [],
    },
    "Hola, ¿qué pan tienes?",
    { step: "MENU" },
    config,
  );
  assert.equal(plan.kind, "ANSWER");
  assert.equal(plan.answerType, "CATALOG");
});

test("solo acepta una direccion copiada del mensaje del cliente", () => {
  assert.equal(
    validatePlannedInput({
      step: "ADDRESS",
      input: "15 Appleby Dr Brampton L6T 2S7",
      customerMessage: "Mi dirección es 15 Appleby Dr Brampton L6T 2S7",
      session: {},
    }),
    true,
  );
  assert.equal(
    validatePlannedInput({
      step: "ADDRESS",
      input: "99 Invented Street, Brampton",
      customerMessage: "Estoy en Brampton",
      session: {},
    }),
    false,
  );
});

test("la confirmacion debe aparecer explicitamente en el mensaje actual", () => {
  assert.equal(explicitConfirmation("Sí, confirmo mi pedido", "SI"), true);
  assert.equal(explicitConfirmation("Se ve bien", "SI"), false);
  assert.equal(explicitConfirmation("No, mejor conservarlo", "NO"), true);
});

test("rechaza una redaccion que agregue o elimine cifras verificadas", () => {
  const source = "12 Conchitas Vainilla · $3.50 c/u · Total $42.00";
  assert.equal(
    groundedRewrite(
      source,
      "Claro: 12 Conchitas Vainilla · $3.50 c/u · Total $42.00",
    ),
    true,
  );
  assert.equal(
    groundedRewrite(source, "Te agregué 13 piezas por $45.00"),
    false,
  );
  assert.equal(
    groundedRewrite(source, "Conchitas Vainilla listas."),
    false,
  );
});

test("rechaza precios malformados aunque la respuesta pueda ser mas breve", () => {
  assert.equal(
    groundedRewrite(
      "Conchitas Vainilla: $3.50 c/u",
      "Tenemos Conchitas Vainilla a $.50 c/u.",
      { requireAllFacts: false },
    ),
    false,
  );
});

test("usa Responses API con salida estructurada y sin guardar la respuesta", async () => {
  let request;
  const assistant = new OpenAiBusinessAssistant({
    apiKey: "test-key",
    model: "gpt-5.4-mini",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    kind: "ADVANCE",
                    answerType: "NONE",
                    productIds: [],
                    inputs: ["1", "12"],
                    reply: "",
                    confidence: 0.98,
                  }),
                },
              ],
            },
          ],
        }),
      };
    },
  });

  const plan = await assistant.interpretTurn({
    customerMessage: "Quiero una docena de chocolate",
    session: { step: "MENU", quantities: {} },
    config,
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.model, "gpt-5.4-mini");
  assert.equal(request.body.text.format.type, "json_schema");
  assert.deepEqual(plan.inputs, ["1", "12"]);
  assert.equal(assistant.status(config).operational, true);
});

test("abre el circuito temporalmente cuando OpenAI rechaza la cuota", async () => {
  const assistant = new OpenAiBusinessAssistant({
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });

  await assert.rejects(
    () => assistant.testConnection(config),
    /límite de uso/i,
  );
  const status = assistant.status(config);
  assert.equal(status.configured, true);
  assert.equal(status.operational, false);
  assert.match(status.lastError, /límite de uso/i);
  assert.ok(status.suspendedUntil);
  assert.equal(assistant.enabled(config), false);
});
