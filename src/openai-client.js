"use strict";

const {
  DEFAULT_MODEL,
  OpenAiBusinessAssistant: LegacyOpenAiBusinessAssistant,
  responseText,
} = require("./ai-assistant");
const { torontoToday, WEEKDAY_NAMES } = require("./product-availability");

function safeErrorMessage(status) {
  if (status === 401) return "La llave de OpenAI fue rechazada.";
  if (status === 429) return "OpenAI alcanzó temporalmente su límite de uso.";
  if (status >= 500) return "OpenAI no está disponible temporalmente.";
  return `OpenAI respondió con estado ${status}.`;
}

function businessSnapshot(config = {}, now = new Date()) {
  const catalog = Array.isArray(config.catalog) ? config.catalog : [];
  const product = (item) => ({
    id: String(item.id || ""),
    nombre: String(item.name || item.promptName || item.id || ""),
    nombre_pedido: String(item.promptName || item.name || item.id || ""),
    precio: Number(item.price || 0),
    dias_produccion: (item.productionWeekdays || []).map(
      (weekday) => WEEKDAY_NAMES[Number(weekday)] || String(weekday),
    ),
  });

  return {
    fecha_hoy_toronto: torontoToday(now),
    moneda: "CAD",
    minimo_piezas: Number(config.minimumOrderPieces || 0),
    direccion_pickup: String(config.pickupAddress || ""),
    tarifas_envio: {
      brampton: Number(config.deliveryFees?.brampton || 0),
      mississauga: Number(config.deliveryFees?.mississauga || 0),
    },
    promo_envio_gratis_brampton:
      config.promotions?.freeBramptonDelivery === true,
    catalogo: catalog
      .filter((item) => item.active !== false)
      .map(product),
    capacidades: catalog.map((item) => ({
      ...product(item),
      disponible_esta_semana: item.active !== false,
    })),
    servicio_semanal: (config.schedules || [])
      .filter((schedule) => schedule.active !== false)
      .map((schedule) => ({
        dia:
          WEEKDAY_NAMES[Number(schedule.weekday)] ||
          String(schedule.name || ""),
        pickup: {
          activo: schedule.pickupEnabled !== false,
          ventana: String(schedule.pickupWindow || ""),
        },
        delivery: {
          activo: schedule.deliveryEnabled !== false,
          ventana: String(schedule.deliveryWindow || ""),
        },
      })),
    cierres: (config.closures || []).map((closure) => ({
      fecha: String(closure.date || ""),
      servicios: Array.isArray(closure.services) ? closure.services : [],
    })),
  };
}

function systemText(values) {
  return (Array.isArray(values) ? values : [values])
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) =>
      typeof value === "string" ? value : JSON.stringify(value),
    )
    .join("\n\n");
}

class OpenAiBusinessAssistant extends LegacyOpenAiBusinessAssistant {
  circuitOpen() {
    return Date.now() < Number(this.suspendedUntil || 0);
  }

  async requestWithTools({
    instructions,
    system = [],
    input = [],
    tools = [],
    maxOutputTokens = 1200,
  }) {
    if (!this.configured()) throw new Error("Falta OPENAI_API_KEY.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const extraSystem = systemText(system);
      const response = await this.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model || DEFAULT_MODEL,
          store: false,
          reasoning: { effort: "low" },
          include: ["reasoning.encrypted_content"],
          max_output_tokens: Math.max(200, Number(maxOutputTokens) || 1200),
          instructions: [String(instructions || "").trim(), extraSystem]
            .filter(Boolean)
            .join("\n\n"),
          input,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(safeErrorMessage(response.status));
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = "";
      this.suspendedUntil = 0;
      return {
        ...payload,
        text: responseText(payload),
        output: Array.isArray(payload.output) ? payload.output : [],
      };
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "OpenAI excedió el tiempo máximo de respuesta."
          : String(error?.message || error);
      this.lastFailureAt = new Date().toISOString();
      this.lastError = message;
      const status = Number(error?.status || 0);
      const cooldownMs =
        status === 401
          ? 60 * 60 * 1000
          : status === 429
            ? 15 * 60 * 1000
            : status >= 500 || error?.name === "AbortError"
              ? 60 * 1000
              : 30 * 1000;
      this.suspendedUntil = Date.now() + cooldownMs;
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  DEFAULT_MODEL,
  OpenAiBusinessAssistant,
  businessSnapshot,
  systemText,
};
