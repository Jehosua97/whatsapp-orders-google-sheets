"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  prematureConfirmation,
  runAgent,
  transcriptInput,
} = require("../src/agent");
const { crearBorrador } = require("../src/order-draft");

const config = {
  agentMaxSteps: 6,
  agentTranscriptTurns: 12,
  minimumOrderPieces: 5,
  pickupAddress: "154 Royal Palm Dr",
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
  ],
  schedules: [
    {
      weekday: 6,
      active: true,
      pickupEnabled: true,
      pickupWindow: "5:00 p.m. a 6:00 p.m.",
      deliveryEnabled: true,
      deliveryWindow: "después de las 10:00 a.m.",
    },
  ],
  closures: [],
};

function session() {
  return {
    chatId: "customer@lid",
    estado: "ABIERTA",
    draft: crearBorrador(),
    fechas_ofrecidas: ["2026-08-29"],
    fechas_detalle: [
      {
        fecha: "2026-08-29",
        pickup_ventana: "5:00 p.m. a 6:00 p.m.",
        delivery_ventana: "después de las 10:00 a.m.",
      },
    ],
    transcript: [
      {
        role: "user",
        content: "Quiero 6 conchas de chocolate para pickup el sábado",
        ts: "2026-08-28T15:00:00Z",
      },
    ],
  };
}

test("el agente ejecuta herramientas y usa su salida antes de redactar", async () => {
  const current = session();
  const requests = [];
  const aiAssistant = {
    requestWithTools: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              name: "actualizar_borrador",
              call_id: "draft-1",
              arguments: JSON.stringify({
                items: [{ product_id: "chocolate", cantidad: 6 }],
                modalidad: "PICKUP",
                ciudad: "",
                direccion: "",
                fecha: "2026-08-29",
                preparacion: "FRESCO_PROGRAMADO",
              }),
            },
          ],
        };
      }
      return {
        text: "Perfecto: son 6 conchitas para pickup el sábado. ¿Te lo confirmo así?",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Perfecto: son 6 conchitas para pickup el sábado. ¿Te lo confirmo así?",
              },
            ],
          },
        ],
      };
    },
  };

  const result = await runAgent({
    session: current,
    config,
    store: {},
    aiAssistant,
    now: new Date("2026-08-28T16:00:00Z"),
    logger: { error() {} },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length, 8);
  const output = requests[1].input.at(-1);
  assert.equal(output.type, "function_call_output");
  assert.equal(output.call_id, "draft-1");
  assert.equal(JSON.parse(output.output).completo, true);
  assert.equal(current.draft.items[0].cantidad, 6);
  assert.match(result.reply, /confirmo así/i);
});

test("la transcripción enviada no incluye timestamps y respeta el límite", () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `turno ${index}`,
    ts: "secreto-interno",
  }));
  const input = transcriptInput({ transcript: turns }, 4);
  assert.equal(input.length, 4);
  assert.equal(input[0].content, "turno 16");
  assert.equal(input[0].ts, undefined);
});

test("argumentos de herramienta inválidos regresan al modelo como error", async () => {
  const requests = [];
  const aiAssistant = {
    requestWithTools: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              name: "actualizar_borrador",
              call_id: "bad-1",
              arguments: "{no-es-json",
            },
          ],
        };
      }
      return { text: "¿Me confirmas qué producto deseas?", output: [] };
    },
  };
  const result = await runAgent({
    session: session(),
    config,
    store: {},
    aiAssistant,
    logger: { error() {} },
  });
  assert.match(
    JSON.parse(requests[1].input.at(-1).output).error,
    /Argumentos inválidos/i,
  );
  assert.match(result.reply, /qué producto/i);
});

test("no envía un resumen para confirmar mientras el borrador verificado esté incompleto", async () => {
  const current = session();
  current.draft = crearBorrador();
  const requests = [];
  const aiAssistant = {
    requestWithTools: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              name: "actualizar_borrador",
              call_id: "incomplete",
              arguments: JSON.stringify({
                items: [{ product_id: "chocolate", cantidad: 6 }],
                modalidad: "PICKUP",
                ciudad: "",
                direccion: "",
                fecha: "",
                preparacion: "FRESCO_PROGRAMADO",
              }),
            },
          ],
        };
      }
      if (requests.length === 2) {
        return {
          text: "Total $21 CAD. ¿Te lo confirmo así?",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Total $21 CAD. ¿Te lo confirmo así?",
                },
              ],
            },
          ],
        };
      }
      if (requests.length === 3) {
        return {
          text: "",
          output: [
            {
              type: "function_call",
              name: "actualizar_borrador",
              call_id: "complete",
              arguments: JSON.stringify({
                items: [{ product_id: "chocolate", cantidad: 6 }],
                modalidad: "PICKUP",
                ciudad: "",
                direccion: "",
                fecha: "2026-08-29",
                preparacion: "FRESCO_PROGRAMADO",
              }),
            },
          ],
        };
      }
      return {
        text: "Son 6 para pickup el sábado, total $21 CAD. ¿Te lo confirmo así?",
        output: [],
      };
    },
  };

  const result = await runAgent({
    session: current,
    config,
    store: {},
    aiAssistant,
    now: new Date("2026-08-28T16:00:00Z"),
    logger: { error() {} },
  });

  assert.equal(requests.length, 4);
  const correction = requests[2].input.find(
    (item) => item.role === "developer",
  );
  assert.ok(correction);
  assert.match(correction.content, /falta FECHA/i);
  assert.equal(current.draft.fecha, "2026-08-29");
  assert.match(result.reply, /pickup el sábado/i);
  assert.equal(
    prematureConfirmation("¿Te lo confirmo así?", current, config),
    "",
  );
});
