"use strict";

const { runAgent } = require("./agent");
const {
  guardarSolicitudSuelta,
  orderClosed,
} = require("./agent-tools");
const { crearBorrador, construirBorrador, hashBorrador } = require("./order-draft");
const { normalizeOrder } = require("./order");
const {
  correctProductId,
  correctProductName,
} = require("./product-naming");

const AI_DISCLOSURE = "🤖 Aviso: Mensajes generados con IA";
const SAFE_MODE_REPLY =
  "Ya vi tu mensaje. En este momento no puedo tomar el pedido automáticamente, pero una persona te confirma en cuanto pueda. 🙏";

function nowIso(now = new Date()) {
  return now.toISOString();
}

function withAiDisclosure(message, enabled) {
  const content = String(message || "").trim();
  if (!content || !enabled || content.startsWith(AI_DISCLOSURE)) return content;
  return `${AI_DISCLOSURE}\n\n${content}`;
}

function plainWhatsAppText(value) {
  return String(value || "")
    .replace(/\\([*_`#])/g, "$1")
    .replace(/\*+/g, "")
    .replace(/`+/g, "")
    .replace(/\\+[ \t]*(?=\r?\n|$)/g, "")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .trim();
}

function newAgentSession({ chatId, customerName = "", customerPhone = "", now = new Date() }) {
  const timestamp = nowIso(now);
  return {
    chatId: String(chatId || ""),
    customerName: String(customerName || ""),
    customerPhone: String(customerPhone || ""),
    estado: "ABIERTA",
    draft: crearBorrador(),
    fechas_ofrecidas: [],
    firma_resumen: "",
    transcript: [],
    lastActivity: timestamp,
  };
}

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchCatalogProduct(item, config) {
  const rawId = normalized(correctProductId(item?.productId));
  const rawName = normalized(correctProductName(item?.productName));
  const candidates = (config.catalog || []).filter((product) => {
    if (product.active === false) return false;
    const ids = [product.id, product.productId]
      .map((value) => normalized(correctProductId(value)))
      .filter(Boolean);
    const names = [product.name, product.promptName, product.sheetName]
      .map((value) => normalized(correctProductName(value)))
      .filter(Boolean);
    return (
      (rawId && ids.includes(rawId)) ||
      (rawName && names.includes(rawName))
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function seedCartDraft(session, normalizedOrder, config) {
  const food = (normalizedOrder.items || []).filter((item) => !item.isLogistics);
  const matched = [];
  const unmatched = [];
  for (const item of food) {
    const product = matchCatalogProduct(item, config);
    const quantity = Number(item.quantity);
    if (!product || !Number.isSafeInteger(quantity) || quantity <= 0) {
      unmatched.push(String(item.productName || item.productId || "producto"));
      continue;
    }
    matched.push({ product_id: product.id, cantidad: quantity });
  }
  const previousHash = hashBorrador(session.draft);
  session.draft = construirBorrador(session.draft, {
    items: matched,
    origen: "CARRITO",
    modalidad: normalizedOrder.summary?.fulfillmentType || session.draft.modalidad,
    ciudad: normalizedOrder.summary?.city || session.draft.ciudad,
  });
  if (hashBorrador(session.draft) !== previousHash) {
    session.firma_resumen = "";
    session.firma_resumen_turno = -1;
  }
  return { matched, unmatched };
}

function locationDescription(message) {
  const description =
    message?.location?.description ||
    message?.location?.address ||
    message?.location?.name ||
    "";
  const latitude = message?.location?.latitude;
  const longitude = message?.location?.longitude;
  return (
    description ||
    (latitude !== undefined && longitude !== undefined
      ? `https://maps.google.com/?q=${latitude},${longitude}`
      : "ubicación sin descripción")
  );
}

function pushTurn(session, role, content, now = new Date(), maxTurns = 24) {
  session.transcript = Array.isArray(session.transcript) ? session.transcript : [];
  session.transcript.push({ role, content: String(content || ""), ts: nowIso(now) });
  const limit = Math.max(12, Number(maxTurns) || 24) * 2;
  if (session.transcript.length > limit) {
    session.transcript = session.transcript.slice(-limit);
  }
  session.lastActivity = nowIso(now);
}

async function ingestEvent({
  message,
  session,
  config,
  customer,
  loadOrder,
  now = new Date(),
}) {
  session.customerName = customer?.name || session.customerName || "";
  session.customerPhone = customer?.phone || session.customerPhone || "";
  session.lastMessageId = String(message?.id?._serialized || "");
  if (message.type === "order") {
    const rawOrder = await loadOrder(message);
    const normalizedOrder = normalizeOrder({
      message,
      order: rawOrder,
      customerName: session.customerName,
      customerPhone: session.customerPhone,
      priceDivisor: config.whatsappPriceDivisor,
      deliveryFees: config.deliveryFees,
      pickupTimeWindow: config.pickupTimeWindow,
    });
    const seeded = seedCartDraft(session, normalizedOrder, config);
    const details = [
      `[El cliente envió un carrito del catálogo: ${
        normalizedOrder.summary.productSummary || "sin productos reconocibles"
      }]`,
      normalizedOrder.summary.fulfillmentType &&
        `[Modalidad incluida en el carrito: ${normalizedOrder.summary.fulfillmentType}${
          normalizedOrder.summary.city
            ? ` en ${normalizedOrder.summary.city}`
            : ""
        }]`,
      seeded.unmatched.length &&
        `[Productos del carrito no reconocidos en el catálogo semanal: ${seeded.unmatched.join(
          ", ",
        )}]`,
    ]
      .filter(Boolean)
      .join("\n");
    pushTurn(session, "user", details, now, config.agentTranscriptTurns);
    return { type: "order", normalizedOrder, seeded };
  }
  if (message.type === "location") {
    const description = locationDescription(message);
    session.ultima_ubicacion = description;
    pushTurn(
      session,
      "user",
      `[El cliente compartió su ubicación: ${description}]`,
      now,
      config.agentTranscriptTurns,
    );
    return { type: "location", description };
  }
  pushTurn(
    session,
    "user",
    String(message.body || ""),
    now,
    config.agentTranscriptTurns,
  );
  return { type: "chat" };
}

async function resetIfClosedInSheets({ session, store, customer, now, logger = console }) {
  const id = session?.draft?.order_id;
  if (session?.estado !== "CERRADA" || !id || !store?.getOrder) return session;
  try {
    if (typeof store.syncKitchenView === "function") {
      await store.syncKitchenView();
    }
    const order = await store.getOrder(id);
    if (!orderClosed(order)) return session;
    logger.log(`Nueva conversación: el pedido ${id} ya está cerrado en Excel.`);
    return newAgentSession({
      chatId: session.chatId,
      customerName: customer?.name || session.customerName,
      customerPhone: customer?.phone || session.customerPhone,
      now,
    });
  } catch (error) {
    logger.error(`No se pudo comprobar el pedido ${id} en Excel:`, error);
    return session;
  }
}

async function safeMode({ message, session, store, sessionStore, now, logger }) {
  try {
    await guardarSolicitudSuelta(store, session, latestCustomerText(session), now);
  } catch (error) {
    logger.error("No se pudo registrar la solicitud de revisión manual:", error);
  }
  pushTurn(session, "assistant", SAFE_MODE_REPLY, now);
  sessionStore.set(message.from, session);
  await message.reply(SAFE_MODE_REPLY);
  return { handled: true, safeMode: true, reply: SAFE_MODE_REPLY };
}

function latestCustomerText(session) {
  for (let index = (session.transcript || []).length - 1; index >= 0; index -= 1) {
    if (session.transcript[index]?.role === "user") {
      return String(session.transcript[index].content || "");
    }
  }
  return "";
}

async function handleAgentMessage({
  message,
  customer,
  config,
  sessionStore,
  aiAssistant,
  store,
  inventoryStore,
  pauseState,
  loadOrder,
  logger = console,
  now = new Date(),
}) {
  let session = sessionStore.get(message.from);
  if (!session) {
    session = newAgentSession({
      chatId: message.from,
      customerName: customer?.name,
      customerPhone: customer?.phone,
      now,
    });
  }
  session = await resetIfClosedInSheets({
    session,
    store,
    customer,
    now,
    logger,
  });
  if (session.estado === "PAUSADA") session.estado = "ABIERTA";
  const isFirstTurn = !(session.transcript || []).some(
    (turn) => turn.role === "assistant",
  );
  await ingestEvent({
    message,
    session,
    config,
    customer,
    loadOrder,
    now,
  });
  // Persist the real customer event before any network call, so even a process
  // interruption cannot make the message disappear.
  sessionStore.set(message.from, session);

  if (!aiAssistant?.enabled?.(config) || aiAssistant?.circuitOpen?.()) {
    return safeMode({
      message,
      session,
      store,
      inventoryStore,
      sessionStore,
      now,
      logger,
    });
  }

  try {
    const result = await runAgent({
      session,
      config,
      store,
      inventoryStore,
      aiAssistant,
      pauseState,
      logger,
      now,
    });
    const reply = plainWhatsAppText(result.reply) || SAFE_MODE_REPLY;
    pushTurn(session, "assistant", reply, now, config.agentTranscriptTurns);
    sessionStore.set(message.from, session);
    const customerReply = withAiDisclosure(reply, isFirstTurn);
    await message.reply(customerReply);
    return { handled: true, reply: customerReply, session, result };
  } catch (error) {
    logger.error("El agente de ventas no pudo completar el turno:", error);
    if (session.estado === "CERRADA" && session.draft?.order_id) {
      const reply =
        "Tu solicitud ya quedó registrada. Una persona puede ayudarte si necesitas revisar algún detalle. 🙏";
      pushTurn(session, "assistant", reply, now, config.agentTranscriptTurns);
      sessionStore.set(message.from, session);
      await message.reply(reply);
      return { handled: true, safeMode: true, reply, session };
    }
    return safeMode({
      message,
      session,
      store,
      sessionStore,
      now,
      logger,
    });
  }
}

module.exports = {
  AI_DISCLOSURE,
  SAFE_MODE_REPLY,
  handleAgentMessage,
  ingestEvent,
  latestCustomerText,
  locationDescription,
  matchCatalogProduct,
  newAgentSession,
  plainWhatsAppText,
  pushTurn,
  resetIfClosedInSheets,
  seedCartDraft,
  withAiDisclosure,
};
