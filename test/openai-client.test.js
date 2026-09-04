"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OpenAiBusinessAssistant,
  businessSnapshot,
} = require("../src/openai-client");

test("requestWithTools usa Responses API con funciones y una sola redacción", async () => {
  let request;
  const assistant = new OpenAiBusinessAssistant({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          output: [
            {
              type: "function_call",
              name: "consultar_fechas",
              call_id: "call-1",
              arguments: '{"product_ids":["vainilla"],"modalidad":"CUALQUIERA"}',
            },
          ],
        }),
      };
    },
  });
  const tool = {
    type: "function",
    name: "consultar_fechas",
    description: "Consulta fechas",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        product_ids: { type: "array", items: { type: "string" } },
        modalidad: { type: "string" },
      },
      required: ["product_ids", "modalidad"],
    },
  };

  const result = await assistant.requestWithTools({
    instructions: "Vende",
    system: [{ catalogo: [] }],
    input: [{ role: "user", content: "Quiero vainilla" }],
    tools: [tool],
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.body.store, false);
  assert.equal(request.body.tool_choice, "auto");
  assert.equal(request.body.parallel_tool_calls, false);
  assert.deepEqual(request.body.tools, [tool]);
  assert.equal(request.body.text, undefined);
  assert.match(request.body.instructions, /catalogo/);
  assert.equal(result.output[0].type, "function_call");
});

test("businessSnapshot separa catálogo semanal de capacidades", () => {
  const snapshot = businessSnapshot(
    {
      minimumOrderPieces: 5,
      pickupAddress: "154 Royal Palm Dr",
      deliveryFees: { brampton: 0, mississauga: 8 },
      promotions: { freeBramptonDelivery: true },
      catalog: [
        {
          id: "vainilla",
          name: "Concha de vainilla",
          price: 3.5,
          productionWeekdays: [3],
          active: true,
        },
        {
          id: "muerto",
          name: "Pan de muerto",
          price: 4,
          productionWeekdays: [6],
          active: false,
        },
      ],
      schedules: [],
      closures: [],
    },
    new Date("2026-08-28T16:00:00Z"),
  );

  assert.deepEqual(snapshot.catalogo.map((item) => item.id), ["vainilla"]);
  assert.deepEqual(snapshot.capacidades.map((item) => item.id), [
    "vainilla",
    "muerto",
  ]);
  assert.equal(snapshot.tarifas_envio.brampton, 0);
  assert.equal(snapshot.fecha_hoy_toronto, "2026-08-28");
});
