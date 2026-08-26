"use strict";

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return compact(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function explicitYes(value) {
  return /\b(SI|YES|CLARO|OK|DALE|CONFIRMO|REGISTRALA|REGISTRALO)\b/.test(
    normalized(value),
  );
}

function explicitNo(value) {
  return /\b(NO|CANCELAR|CANCELO|DEJALO|GRACIAS)\b/.test(normalized(value));
}

function orderIntent(value) {
  const message = normalized(value);
  return (
    /\b(QUIERO|QUISIERA|DAME|AGREGA|AGREGAR|ANADIR|ORDENAR|PEDIR|NECESITO|APARTAR)\b/.test(
      message,
    ) || /\b\d+\b/.test(message)
  );
}

function quantityEvidence(value) {
  return (
    /\b\d+\b/.test(String(value || "")) ||
    /\b(UNA?\s+DOCENA|MEDIA\s+DOCENA|UNO|DOS|TRES|CUATRO|CINCO|SEIS|SIETE|OCHO|NUEVE|DIEZ|ONCE|DOCE|QUINCE|VEINTE)\b/.test(
      normalized(value),
    )
  );
}

function fallbackProductName(value) {
  const text = compact(value);
  const match = text.match(
    /\b(pan(?:es)?(?:\s+de\s+[\p{L}0-9]+(?:\s+[\p{L}0-9]+)?)?|rol(?:es)?(?:\s+de\s+[\p{L}0-9]+(?:\s+[\p{L}0-9]+)?)?|croissants?|pasteles?|galletas?|tamales?|empanadas?|donas?|bisquets?|baguettes?|muffins?|cupcakes?)\b/iu,
  );
  return compact(match?.[0] || text);
}

function fallbackQuantity(value) {
  const text = normalized(value);
  const numeric = text.match(/\b(\d+)\b/);
  if (numeric) return Number(numeric[1]);
  if (/\bMEDIA DOCENA\b/.test(text)) return 6;
  if (/\b(UNA? DOCENA|DOCE)\b/.test(text)) return 12;
  const words = {
    UNO: 1,
    DOS: 2,
    TRES: 3,
    CUATRO: 4,
    CINCO: 5,
    SEIS: 6,
    SIETE: 7,
    OCHO: 8,
    NUEVE: 9,
    DIEZ: 10,
    ONCE: 11,
    QUINCE: 15,
    VEINTE: 20,
  };
  return Object.entries(words).find(([word]) =>
    new RegExp(`\\b${word}\\b`).test(text),
  )?.[1] || 0;
}

function copiedFromMessage(value, customerMessage) {
  const candidate = normalized(value);
  return candidate && normalized(customerMessage).includes(candidate);
}

function cleanRequest(request = {}, customerMessage = "") {
  const productName = copiedFromMessage(request.productName, customerMessage)
    ? compact(request.productName)
    : fallbackProductName(customerMessage);
  const quantity =
    Number(request.quantity) > 0 && quantityEvidence(customerMessage)
      ? Math.floor(Number(request.quantity))
      : fallbackQuantity(customerMessage);
  return {
    productName,
    quantity,
    requestedDate: copiedFromMessage(request.requestedDate, customerMessage)
      ? compact(request.requestedDate)
      : "",
    fulfillment: ["PICKUP", "DELIVERY"].includes(request.fulfillment)
      ? request.fulfillment
      : "",
    city: ["BRAMPTON", "MISSISSAUGA", "OTHER"].includes(request.city)
      ? request.city
      : "",
    address: copiedFromMessage(request.address, customerMessage)
      ? compact(request.address)
      : "",
    notes: copiedFromMessage(request.notes, customerMessage)
      ? compact(request.notes)
      : "",
    wantsRequest: request.wantsRequest === true || orderIntent(customerMessage),
  };
}

function mergeRequest(current = {}, incoming = {}, customerMessage = "") {
  const clean = cleanRequest(incoming, customerMessage);
  const next = { ...current };
  for (const key of [
    "productName",
    "requestedDate",
    "fulfillment",
    "city",
    "address",
    "notes",
  ]) {
    if (clean[key]) next[key] = clean[key];
  }
  if (clean.quantity > 0) next.quantity = clean.quantity;
  next.wantsRequest = Boolean(current.wantsRequest || clean.wantsRequest);
  return next;
}

function withoutSpecialState(session) {
  if (!session) return null;
  const restored = { ...session };
  delete restored.specialRequest;
  delete restored.specialReturnSession;
  return restored;
}

function startSpecialSession({
  session,
  request,
  customerMessage,
  createdSession = false,
  now = new Date(),
}) {
  const draft = mergeRequest(
    {
      orderId: `SPECIAL-${now.getTime()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`,
    },
    request,
    customerMessage,
  );
  return {
    ...session,
    step: draft.wantsRequest ? "SPECIAL_DETAILS" : "SPECIAL_OFFER",
    specialRequest: draft,
    specialReturnSession: createdSession ? null : withoutSpecialState(session),
  };
}

function missingField(draft) {
  if (!compact(draft.productName)) return "PRODUCT";
  if (!(Number(draft.quantity) > 0)) return "QUANTITY";
  if (!compact(draft.requestedDate)) return "DATE";
  if (!draft.fulfillment) return "FULFILLMENT";
  if (draft.fulfillment === "DELIVERY" && !draft.city) return "CITY";
  if (draft.fulfillment === "DELIVERY" && !compact(draft.address)) {
    return "ADDRESS";
  }
  return "";
}

function specialQuestion(draft) {
  const missing = missingField(draft);
  if (missing === "PRODUCT") return "¿Qué producto especial deseas solicitar?";
  if (missing === "QUANTITY") {
    return `Claro, puedo tomar la solicitud de ${draft.productName}. ¿Cuántas piezas necesitas?`;
  }
  if (missing === "DATE") return "¿Para qué fecha lo necesitas?";
  if (missing === "FULFILLMENT") return "¿Prefieres pickup o delivery?";
  if (missing === "CITY") return "¿La entrega sería en Brampton o Mississauga?";
  if (missing === "ADDRESS") return "¿Cuál es la dirección completa de entrega?";
  return "";
}

function fulfillmentLabel(draft) {
  if (draft.fulfillment === "PICKUP") return "Pickup";
  if (draft.city) return `Delivery en ${draft.city === "BRAMPTON" ? "Brampton" : draft.city === "MISSISSAUGA" ? "Mississauga" : "otra ciudad"}`;
  return "Delivery";
}

function specialSummary(draft) {
  return [
    "📝 Solicitud de pedido especial",
    `Producto: ${draft.productName}`,
    `Cantidad: ${draft.quantity}`,
    `Fecha solicitada: ${draft.requestedDate}`,
    `Modalidad: ${fulfillmentLabel(draft)}`,
    draft.address && `Dirección: ${draft.address}`,
    "Precio, disponibilidad y horario: por confirmar por el administrador.",
    "",
    "¿Deseas enviar esta solicitud? Responde SI o NO.",
  ]
    .filter(Boolean)
    .join("\n");
}

function restoreAfterSpecial(session) {
  return session.specialReturnSession
    ? withoutSpecialState(session.specialReturnSession)
    : null;
}

function advanceSpecialSession({ session, request, customerMessage }) {
  let current = session;
  if (current.step === "SPECIAL_OFFER") {
    if (explicitNo(customerMessage)) {
      return {
        canceled: true,
        session: restoreAfterSpecial(current),
        reply: "Entendido. Puedo ayudarte con cualquier producto disponible esta semana.",
      };
    }
    if (!explicitYes(customerMessage) && request?.wantsRequest !== true) {
      return {
        session: current,
        reply: `Ese producto no aparece entre los disponibles esta semana, pero puedo registrar una solicitud especial para revisión. ¿Quieres que la tome?`,
      };
    }
    current = { ...current, step: "SPECIAL_DETAILS" };
  }

  if (current.step === "SPECIAL_CONFIRMATION") {
    if (explicitNo(customerMessage)) {
      return {
        canceled: true,
        session: restoreAfterSpecial(current),
        reply: "Listo, no envié la solicitud especial.",
      };
    }
    if (explicitYes(customerMessage)) {
      return {
        save: true,
        session: current,
        nextSession: restoreAfterSpecial(current),
      };
    }
  }

  const draft = mergeRequest(
    current.specialRequest,
    request,
    customerMessage,
  );
  const missing = missingField(draft);
  if (missing) {
    return {
      session: { ...current, step: "SPECIAL_DETAILS", specialRequest: draft },
      reply: specialQuestion(draft),
    };
  }
  return {
    session: {
      ...current,
      step: "SPECIAL_CONFIRMATION",
      specialRequest: draft,
    },
    reply: specialSummary(draft),
  };
}

function slug(value) {
  return normalized(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildSpecialOrder(session, confirmationMessage) {
  const draft = session.specialRequest;
  const receivedAt = new Date().toISOString();
  const productName = compact(draft.productName);
  const quantity = Number(draft.quantity);
  return {
    summary: {
      receivedAt,
      orderId: draft.orderId,
      phone: session.customerPhone || "",
      customerName: session.customerName || "",
      currency: "CAD",
      subtotal: "",
      total: "",
      status: "REVISION_MANUAL",
      messageId: String(confirmationMessage?.id?._serialized || ""),
      chatId: session.chatId || "",
      fulfillmentType: draft.fulfillment,
      city: draft.city || "",
      address: draft.address || "",
      postalCode: "",
      requestedDate: draft.requestedDate,
      timeWindow: "",
      deliveryFee: "",
      grandTotal: "",
      scheduleStatus: "PENDIENTE_ADMIN",
      latitude: "",
      longitude: "",
      updatedAt: receivedAt,
      customerNotes: [
        "Solicitud especial tomada por IA",
        "Precio, disponibilidad y horario pendientes de confirmación",
        draft.notes,
      ]
        .filter(Boolean)
        .join(" | "),
      productSummary: `${quantity} x ${productName}`,
      fulfillmentConflict: false,
      kitchenStatus: "Por confirmar",
    },
    items: [
      {
        receivedAt,
        orderId: draft.orderId,
        productId: `especial-${slug(productName) || "producto"}`,
        productName,
        quantity,
        unitPrice: "",
        currency: "CAD",
        lineTotal: "",
        isLogistics: false,
      },
    ],
  };
}

function isSpecialSession(session) {
  return String(session?.step || "").startsWith("SPECIAL_");
}

module.exports = {
  advanceSpecialSession,
  buildSpecialOrder,
  cleanRequest,
  isSpecialSession,
  specialSummary,
  startSpecialSession,
};
