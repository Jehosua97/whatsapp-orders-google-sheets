"use strict";

const { TOOL_SCHEMAS, executeTool } = require("./agent-tools");
const { businessSnapshot } = require("./openai-client");
const { primerCampoFaltante } = require("./order-draft");
const { SALES_PROMPT } = require("./sales-prompt");

const MAX_TOOL_OUTPUT_LENGTH = 12000;
const AGENT_LIMIT_REPLY = "Dame un momento y te confirmo. 🙏";

function transcriptInput(session, limit = 12) {
  const turns = Array.isArray(session?.transcript) ? session.transcript : [];
  return turns
    .slice(-Math.max(2, Number(limit) || 12))
    .filter(
      (turn) =>
        ["user", "assistant"].includes(turn?.role) &&
        String(turn?.content || "").trim(),
    )
    .map((turn) => ({
      role: turn.role,
      content: String(turn.content),
    }));
}

function sessionSnapshot(session) {
  return {
    estado: session?.estado || "ABIERTA",
    borrador: session?.draft || {},
    fechas_ofrecidas: session?.fechas_ofrecidas || [],
    pan_listo_consultado: session?.pan_listo_consultado || null,
    solicitud_especial_pendiente: session?.solicitud_especial || null,
    modificacion_pendiente: session?.modificacion_pendiente
      ? {
          order_id: session.modificacion_pendiente.order_id,
          accion: session.modificacion_pendiente.accion,
          requiere_segunda_confirmacion:
            Number(
              session.modificacion_pendiente.primera_confirmacion_turno,
            ) >= 0,
        }
      : null,
  };
}

function functionCalls(output) {
  return (Array.isArray(output) ? output : []).filter(
    (item) => item?.type === "function_call",
  );
}

function toolOutput(value) {
  const encoded = JSON.stringify(value ?? null);
  return encoded.length > MAX_TOOL_OUTPUT_LENGTH
    ? JSON.stringify({ error: "La salida de la herramienta fue demasiado grande." })
    : encoded;
}

function parseArguments(call) {
  try {
    const parsed = JSON.parse(String(call?.arguments || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Los argumentos no son un objeto.");
    }
    return parsed;
  } catch (error) {
    return { __parseError: String(error.message || error) };
  }
}

function prematureConfirmation(reply, session, config) {
  const text = String(reply || "");
  if (!/\bconfirm/i.test(text)) return "";
  if (!Array.isArray(session?.draft?.items) || !session.draft.items.length) {
    return "";
  }
  return primerCampoFaltante(session.draft, config);
}

async function runAgent(options, configArg, storeArg) {
  const params =
    options?.session
      ? options
      : {
          session: options,
          config: configArg,
          store: storeArg,
          aiAssistant: configArg?.aiAssistant,
        };
  const {
    session,
    config,
    store,
    inventoryStore,
    aiAssistant,
    pauseState,
    logger = console,
    now = new Date(),
  } = params;
  if (!session || !config || !store || !aiAssistant) {
    throw new Error("Faltan dependencias para ejecutar el agente.");
  }

  const input = transcriptInput(session, config.agentTranscriptTurns);
  const maxSteps = Math.max(1, Math.min(12, Number(config.agentMaxSteps) || 6));
  for (let step = 0; step < maxSteps; step += 1) {
    const response = await aiAssistant.requestWithTools({
      instructions: SALES_PROMPT,
      system: [
        `SNAPSHOT DEL NEGOCIO:\n${JSON.stringify(
          businessSnapshot(config, now),
        )}`,
        `ESTADO DE LA CONVERSACIÓN:\n${JSON.stringify(
          sessionSnapshot(session),
        )}`,
      ],
      input,
      tools: TOOL_SCHEMAS,
    });
    const calls = functionCalls(response.output);
    if (!calls.length) {
      const reply = String(response.text || "").trim();
      const missing = prematureConfirmation(reply, session, config);
      if (missing && step + 1 < maxSteps) {
        input.push(...response.output);
        input.push({
          role: "developer",
          content:
            `VALIDACIÓN DEL SERVIDOR: no puedes enviar todavía un resumen para confirmar porque falta ${missing}. ` +
            "La respuesta anterior no se enviará al cliente. Usa las herramientas para aplicar cualquier dato ya aportado u obtenido; si el cliente no lo dio, pregunta solamente por ese dato. No afirmes una fecha, modalidad, dirección o total que no esté en el borrador verificado.",
        });
        continue;
      }
      return { reply: reply || AGENT_LIMIT_REPLY, steps: step + 1 };
    }

    // Preserve output items in the local Responses conversation. This includes
    // function_call identifiers (and reasoning items when the model returns
    // them) so each function_call_output is attached to the correct call.
    input.push(...response.output);
    for (const call of calls) {
      const args = parseArguments(call);
      let result;
      if (args.__parseError) {
        result = { error: `Argumentos inválidos: ${args.__parseError}` };
      } else {
        try {
          result = await executeTool(call.name, args, {
            session,
            config,
            store,
            inventoryStore,
            pauseState,
            now,
          });
        } catch (error) {
          logger.error(`Falló la herramienta ${call.name}:`, error);
          result = { error: String(error?.message || error) };
        }
      }
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: toolOutput(result),
      });
    }
  }
  return { reply: AGENT_LIMIT_REPLY, steps: maxSteps, limitReached: true };
}

module.exports = {
  AGENT_LIMIT_REPLY,
  functionCalls,
  parseArguments,
  prematureConfirmation,
  runAgent,
  sessionSnapshot,
  toolOutput,
  transcriptInput,
};
