"use strict";

const ACTIVE_STATUSES = new Set([
  "ESPERANDO_DATOS",
  "ESPERANDO_HORARIO",
  "NUEVO",
]);

function normalizedText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function detectCity(value) {
  const normalized = normalizedText(value);
  if (/\bbrampton\b/.test(normalized)) return "BRAMPTON";
  if (/\bmississauga\b|\bmissisauga\b|\bmississuga\b/.test(normalized)) {
    return "MISSISSAUGA";
  }
  return "";
}

function detectPostalCode(value) {
  const match = String(value || "").match(
    /\b([A-Z]\d[A-Z])[\s-]?(\d[A-Z]\d)\b/i,
  );
  return match ? `${match[1].toUpperCase()} ${match[2].toUpperCase()}` : "";
}

function deliveryFeeFor(city, fees) {
  if (city === "BRAMPTON") return fees.brampton;
  if (city === "MISSISSAUGA") return fees.mississauga;
  return "";
}

function parseFulfillmentText(value, fees) {
  const original = String(value || "").trim();
  const normalized = normalizedText(original);
  const city = detectCity(original);
  const pickup =
    /\b(recoger|recojo|recogida|pickup|pick up|paso por|voy por)\b/.test(
      normalized,
    );
  const delivery =
    /\b(entrega|entregar|delivery|domicilio|envio|enviar|mandar)\b/.test(
      normalized,
    ) || Boolean(city);

  if (!pickup && !delivery) return null;

  const fulfillmentType = pickup ? "PICKUP" : "DELIVERY";
  const deliveryFee =
    fulfillmentType === "PICKUP" ? 0 : deliveryFeeFor(city, fees);

  return {
    fulfillmentType,
    city: fulfillmentType === "DELIVERY" ? city : "",
    postalCode: detectPostalCode(original),
    deliveryFee,
    scheduleStatus: "PENDIENTE",
    status:
      fulfillmentType === "PICKUP" || city
        ? "ESPERANDO_HORARIO"
        : "ESPERANDO_DATOS",
    customerNotes: original,
    updatedAt: new Date().toISOString(),
  };
}

function isActiveOrder(order) {
  return ACTIVE_STATUSES.has(order.status);
}

module.exports = {
  ACTIVE_STATUSES,
  deliveryFeeFor,
  detectCity,
  detectPostalCode,
  isActiveOrder,
  parseFulfillmentText,
};
