const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SESSION_STATES = Object.freeze({
  OPEN: "ABIERTA",
  CLOSED: "CERRADA",
  PAUSED: "PAUSADA",
});

const DEFAULT_PENDING_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRANSCRIPT_TURNS = 12;
const VALID_STATES = new Set(Object.values(SESSION_STATES));
const VALID_FULFILLMENT = new Set(["", "PICKUP", "DELIVERY"]);
const VALID_CITIES = new Set(["", "BRAMPTON", "MISSISSAUGA"]);
const VALID_PREPARATIONS = new Set([
  "FRESCO_PROGRAMADO",
  "PAN_LISTO_INMEDIATO",
]);
const VALID_ADDRESS_TYPES = new Set([
  "",
  "TEXTO",
  "MAPS_LINK",
  "UBICACION",
]);

const LEGACY_CLOSED_STEPS = new Set([
  "COMPLETED",
  "CANCELED",
  "CART_COMPLETED",
  "CART_CANCELED",
]);
const MAX_INTERNAL_ARRAY_ITEMS = 100;
const MAX_INTERNAL_OBJECT_KEYS = 100;
const MAX_INTERNAL_DEPTH = 8;

function isoTimestamp(value, fallback) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

function currentTimestamp(now) {
  const value = now();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError("La función now debe devolver una fecha válida.");
  }
  return new Date(parsed).toISOString();
}

function validIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === text
  );
}

function emptyDraft() {
  return {
    items: [],
    modalidad: "",
    ciudad: "",
    direccion: "",
    direccion_tipo: "",
    fecha: "",
    ventana: "",
    preparacion: "FRESCO_PROGRAMADO",
    origen: "TEXTO",
    order_id: "",
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const normalized = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const productId = String(
      item.product_id ?? item.productId ?? item.id ?? "",
    ).trim();
    const quantity = Number(item.cantidad ?? item.quantity ?? 0);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0) continue;
    normalized.set(productId, {
      product_id: productId,
      cantidad: quantity,
    });
  }
  return [...normalized.values()];
}

function legacyItems(session) {
  const quantities =
    session.quantities && typeof session.quantities === "object"
      ? session.quantities
      : {};
  const preferredOrder = Array.isArray(session.productOrder)
    ? session.productOrder.map(String)
    : [];
  const quantityKeys = Object.keys(quantities);
  const orderedKeys = [
    ...preferredOrder,
    ...quantityKeys.filter((key) => !preferredOrder.includes(key)),
  ];
  const textItems = orderedKeys.map((productId) => ({
    product_id: productId,
    cantidad: quantities[productId],
  }));
  if (textItems.length) return normalizeItems(textItems);

  return normalizeItems(session.cartOrder?.items || []);
}

function normalizeEnum(value, allowed) {
  const normalized = String(value || "").trim().toUpperCase();
  return allowed.has(normalized) ? normalized : "";
}

function normalizeAddressType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "ADDRESS" || normalized === "TEXT") return "TEXTO";
  if (normalized === "LOCATION" || normalized === "LIVE_LOCATION") {
    return "UBICACION";
  }
  return VALID_ADDRESS_TYPES.has(normalized) ? normalized : "";
}

function legacyOrderId(session, estado) {
  if (session.draft && typeof session.draft === "object") {
    return session.draft.order_id;
  }
  const step = String(session.step || "").toUpperCase();
  const belongsToSavedOrder =
    estado === SESSION_STATES.CLOSED ||
    step === "CANCEL_CONFIRMATION" ||
    step === "CART_CANCEL_CONFIRMATION" ||
    step.startsWith("UPDATE_") ||
    step.startsWith("CART_UPDATE_");
  return belongsToSavedOrder ? session.orderId : "";
}

function normalizeDraft(session, estado) {
  const source =
    session.draft &&
    typeof session.draft === "object" &&
    !Array.isArray(session.draft)
      ? session.draft
      : null;
  const fulfillment =
    session.fulfillment && typeof session.fulfillment === "object"
      ? session.fulfillment
      : {};
  const schedule =
    session.schedule && typeof session.schedule === "object"
      ? session.schedule
      : {};
  const address = source?.direccion ?? session.deliveryAddress ?? "";

  return {
    items: normalizeItems(source?.items ?? legacyItems(session)),
    modalidad: normalizeEnum(
      source?.modalidad ?? fulfillment.type ?? session.fulfillment,
      VALID_FULFILLMENT,
    ),
    ciudad: normalizeEnum(
      source?.ciudad ?? fulfillment.city ?? session.deliveryCity,
      VALID_CITIES,
    ),
    direccion: typeof address === "string" ? address : "",
    direccion_tipo: normalizeAddressType(
      source?.direccion_tipo ?? session.addressType,
    ),
    fecha: validIsoDate(source?.fecha ?? schedule.date)
      ? String(source?.fecha ?? schedule.date)
      : "",
    ventana: String(
      source?.ventana ?? schedule.timeWindow ?? "",
    ),
    preparacion:
      normalizeEnum(source?.preparacion, VALID_PREPARATIONS) ||
      "FRESCO_PROGRAMADO",
    origen:
      String(source?.origen ?? session.source ?? "TEXTO").toUpperCase() ===
      "CARRITO" ||
      String(source?.origen ?? session.source ?? "").toUpperCase() === "CART"
        ? "CARRITO"
        : "TEXTO",
    order_id: String(legacyOrderId(session, estado) || ""),
  };
}

function normalizeOfferedDates(session) {
  const source = Array.isArray(session.fechas_ofrecidas)
    ? session.fechas_ofrecidas
    : Array.isArray(session.scheduleOptions)
      ? session.scheduleOptions
      : [];
  return [
    ...new Set(
      source
        .map((entry) =>
          typeof entry === "string" ? entry : entry?.fecha ?? entry?.date,
        )
        .map((date) => String(date || ""))
        .filter(validIsoDate),
    ),
  ];
}

function normalizeTranscript(transcript, fallbackTimestamp, limit) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter(
      (turn) =>
        turn &&
        typeof turn === "object" &&
        !Array.isArray(turn) &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string",
    )
    .map((turn) => ({
      role: turn.role,
      content: turn.content,
      ts: isoTimestamp(turn.ts, fallbackTimestamp),
    }))
    .slice(-limit);
}

function safeJsonClone(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object" || depth >= MAX_INTERNAL_DEPTH) {
    return undefined;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_INTERNAL_ARRAY_ITEMS)
      .map((item) => safeJsonClone(item, depth + 1, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return undefined;
  }
  const result = {};
  const entries = Object.entries(value).slice(0, MAX_INTERNAL_OBJECT_KEYS);
  for (const [key, entry] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    const cloned = safeJsonClone(entry, depth + 1, seen);
    if (cloned !== undefined) result[key] = cloned;
  }
  seen.delete(value);
  return result;
}

function safeInternalObject(value) {
  const cloned = safeJsonClone(value);
  return cloned && typeof cloned === "object" && !Array.isArray(cloned)
    ? cloned
    : null;
}

function normalizeTurnIndex(value) {
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= -1 ? index : -1;
}

function normalizeDateDetails(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_INTERNAL_ARRAY_ITEMS)
    .filter(
      (detail) =>
        detail &&
        typeof detail === "object" &&
        !Array.isArray(detail) &&
        validIsoDate(detail.fecha),
    )
    .map((detail) => ({
      fecha: String(detail.fecha),
      etiqueta: String(detail.etiqueta || ""),
      origen:
        String(detail.origen || "").toUpperCase() === "PAN_LISTO"
          ? "PAN_LISTO"
          : "PROGRAMADO",
      pickup_disponible: detail.pickup_disponible === true,
      pickup_ventana: String(detail.pickup_ventana || ""),
      delivery_disponible: detail.delivery_disponible === true,
      delivery_ventana: String(detail.delivery_ventana || ""),
    }));
}

function normalizeState(session) {
  const explicit = String(session.estado || "").trim().toUpperCase();
  if (VALID_STATES.has(explicit)) return explicit;
  const legacyStep = String(session.step || "").trim().toUpperCase();
  if (LEGACY_CLOSED_STEPS.has(legacyStep)) return SESSION_STATES.CLOSED;
  if (legacyStep === "PAUSED" || legacyStep === "PAUSADA") {
    return SESSION_STATES.PAUSED;
  }
  return SESSION_STATES.OPEN;
}

function recognizableSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return false;
  }
  return Boolean(
    VALID_STATES.has(String(session.estado || "").toUpperCase()) ||
      (session.draft && typeof session.draft === "object") ||
      typeof session.step === "string" ||
      typeof session.chatId === "string" ||
      Array.isArray(session.transcript),
  );
}

function normalizeSession(session, chatId, timestamp, transcriptTurns) {
  const estado = normalizeState(session);
  const lastActivity = isoTimestamp(
    session.lastActivity ?? session.stateUpdatedAt ?? session.createdAt,
    timestamp,
  );
  return {
    chatId: String(chatId || session.chatId || ""),
    customerName: String(session.customerName || ""),
    customerPhone: String(session.customerPhone || ""),
    estado,
    draft: normalizeDraft(session, estado),
    fechas_ofrecidas: normalizeOfferedDates(session),
    fechas_detalle: normalizeDateDetails(session.fechas_detalle),
    firma_resumen: String(session.firma_resumen || ""),
    firma_resumen_turno: normalizeTurnIndex(session.firma_resumen_turno),
    ultima_cotizacion: safeInternalObject(session.ultima_cotizacion),
    pan_listo_consultado: safeInternalObject(
      session.pan_listo_consultado,
    ),
    solicitud_especial: safeInternalObject(session.solicitud_especial),
    firma_resumen_especial: String(
      session.firma_resumen_especial || "",
    ),
    firma_resumen_especial_turno: normalizeTurnIndex(
      session.firma_resumen_especial_turno,
    ),
    modificacion_pendiente: safeInternalObject(
      session.modificacion_pendiente,
    ),
    ultima_ubicacion: String(session.ultima_ubicacion || ""),
    lastMessageId: String(session.lastMessageId || ""),
    motivo_pausa: String(session.motivo_pausa || ""),
    transcript: normalizeTranscript(
      session.transcript,
      lastActivity,
      transcriptTurns,
    ),
    lastActivity,
  };
}

function newSession(chatIdOrOptions, options = {}) {
  const supplied =
    chatIdOrOptions && typeof chatIdOrOptions === "object"
      ? chatIdOrOptions
      : { ...options, chatId: chatIdOrOptions };
  const chatId = String(supplied.chatId || "");
  if (!chatId) throw new TypeError("chatId es obligatorio.");
  const nowValue = supplied.now || new Date();
  const lastActivity = isoTimestamp(nowValue, new Date().toISOString());
  return {
    chatId,
    customerName: String(supplied.customerName || ""),
    customerPhone: String(supplied.customerPhone || ""),
    estado: SESSION_STATES.OPEN,
    draft: emptyDraft(),
    fechas_ofrecidas: [],
    fechas_detalle: [],
    firma_resumen: "",
    firma_resumen_turno: -1,
    ultima_cotizacion: null,
    pan_listo_consultado: null,
    solicitud_especial: null,
    firma_resumen_especial: "",
    firma_resumen_especial_turno: -1,
    modificacion_pendiente: null,
    ultima_ubicacion: "",
    lastMessageId: "",
    motivo_pausa: "",
    transcript: [],
    lastActivity,
  };
}

function cloneSession(session) {
  return JSON.parse(JSON.stringify(session));
}

class ConversationStateStore {
  constructor(file, options = {}) {
    this.file = String(file || "");
    if (!this.file) throw new TypeError("file es obligatorio.");
    this.pendingTimeoutMs =
      Number(options.pendingTimeoutMs) > 0
        ? Number(options.pendingTimeoutMs)
        : Number(options.sessionTimeoutHours) > 0
          ? Number(options.sessionTimeoutHours) * 60 * 60 * 1000
          : DEFAULT_PENDING_SESSION_TIMEOUT_MS;
    this.transcriptTurns =
      Number.isInteger(Number(options.transcriptTurns)) &&
      Number(options.transcriptTurns) > 0
        ? Number(options.transcriptTurns)
        : DEFAULT_TRANSCRIPT_TURNS;
    this.now = options.now || (() => new Date());

    const loaded = this._readSessions();
    this.sessions = loaded.sessions;
    const recovered = this._recoverStale(this.sessions);
    this.sessions = recovered.sessions;
    this.lastRecoveryReport = {
      migratedSessions: loaded.migratedSessions,
      clearedSessions: recovered.clearedSessions,
      removedInvalid: loaded.removedInvalid,
      // Nombre conservado para el registro de arranque de versiones anteriores.
      clearedConversation: recovered.clearedSessions,
    };
    if (loaded.changed || recovered.changed) this.save();
  }

  _readSessions() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {
        sessions: {},
        migratedSessions: 0,
        removedInvalid: 0,
        changed: false,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        sessions: {},
        migratedSessions: 0,
        removedInvalid: 1,
        changed: true,
      };
    }

    const timestamp = currentTimestamp(this.now);
    const sessions = {};
    let migratedSessions = 0;
    let removedInvalid = 0;
    for (const [chatId, session] of Object.entries(parsed)) {
      if (!recognizableSession(session)) {
        removedInvalid += 1;
        continue;
      }
      const normalized = normalizeSession(
        session,
        chatId,
        timestamp,
        this.transcriptTurns,
      );
      sessions[chatId] = normalized;
      if (JSON.stringify(normalized) !== JSON.stringify(session)) {
        migratedSessions += 1;
      }
    }
    return {
      sessions,
      migratedSessions,
      removedInvalid,
      changed: migratedSessions > 0 || removedInvalid > 0,
    };
  }

  _recoverStale(sessions) {
    const nowMs = Date.parse(currentTimestamp(this.now));
    const recovered = { ...sessions };
    let clearedSessions = 0;
    for (const [chatId, session] of Object.entries(sessions)) {
      if (session.estado === SESSION_STATES.CLOSED) continue;
      const lastActivity = Date.parse(session.lastActivity);
      if (
        Number.isFinite(lastActivity) &&
        nowMs - lastActivity <= this.pendingTimeoutMs
      ) {
        continue;
      }
      delete recovered[chatId];
      clearedSessions += 1;
    }
    return {
      sessions: recovered,
      clearedSessions,
      changed: clearedSessions > 0,
    };
  }

  load() {
    return this._readSessions().sessions;
  }

  get(chatId) {
    this.recoverSession(chatId);
    return this.sessions[String(chatId)] || null;
  }

  set(chatId, session) {
    const key = String(chatId || "");
    if (!key) throw new TypeError("chatId es obligatorio.");
    const nextSessions = { ...this.sessions };
    if (session === null || session === undefined) {
      if (!Object.hasOwn(nextSessions, key)) return null;
      delete nextSessions[key];
      this._persist(nextSessions);
      this.sessions = nextSessions;
      return null;
    }
    if (typeof session !== "object" || Array.isArray(session)) {
      throw new TypeError("session debe ser un objeto.");
    }
    const timestamp = currentTimestamp(this.now);
    const normalized = normalizeSession(
      { ...session, lastActivity: timestamp },
      key,
      timestamp,
      this.transcriptTurns,
    );
    nextSessions[key] = normalized;
    this._persist(nextSessions);
    this.sessions = nextSessions;
    return normalized;
  }

  delete(chatId) {
    return this.set(chatId, null);
  }

  updateByOrderId(orderId, updater) {
    const wanted = String(orderId || "");
    if (!wanted) return false;
    if (typeof updater !== "function") {
      throw new TypeError("updater debe ser una función.");
    }

    const timestamp = currentTimestamp(this.now);
    const replacements = [];
    for (const [chatId, session] of Object.entries(this.sessions)) {
      if (String(session.draft?.order_id || "") !== wanted) continue;
      const updated = updater(cloneSession(session));
      if (!updated || typeof updated !== "object" || Array.isArray(updated)) {
        throw new TypeError("updater debe devolver una sesión.");
      }
      replacements.push([
        chatId,
        normalizeSession(
          { ...updated, lastActivity: timestamp },
          chatId,
          timestamp,
          this.transcriptTurns,
        ),
      ]);
    }
    if (!replacements.length) return false;

    const nextSessions = { ...this.sessions };
    for (const [chatId, session] of replacements) {
      nextSessions[chatId] = session;
    }
    this._persist(nextSessions);
    this.sessions = nextSessions;
    return true;
  }

  recoverSession(chatId) {
    const key = String(chatId || "");
    const session = this.sessions[key];
    if (!session) return "unchanged";
    if (!recognizableSession(session)) {
      const nextSessions = { ...this.sessions };
      delete nextSessions[key];
      this._persist(nextSessions);
      this.sessions = nextSessions;
      return "removedInvalid";
    }
    if (session.estado === SESSION_STATES.CLOSED) return "unchanged";
    const nowMs = Date.parse(currentTimestamp(this.now));
    const lastActivity = Date.parse(session.lastActivity);
    if (
      Number.isFinite(lastActivity) &&
      nowMs - lastActivity <= this.pendingTimeoutMs
    ) {
      return "unchanged";
    }
    const nextSessions = { ...this.sessions };
    delete nextSessions[key];
    this._persist(nextSessions);
    this.sessions = nextSessions;
    return "clearedSession";
  }

  recoverStaleSessions() {
    const recovered = this._recoverStale(this.sessions);
    if (recovered.changed) {
      this._persist(recovered.sessions);
      this.sessions = recovered.sessions;
    }
    const report = {
      migratedSessions: 0,
      clearedSessions: recovered.clearedSessions,
      removedInvalid: 0,
      clearedConversation: recovered.clearedSessions,
    };
    this.lastRecoveryReport = report;
    return report;
  }

  healthSummary() {
    const sessions = Object.values(this.sessions);
    return {
      total: sessions.length,
      pending: sessions.filter(
        (session) => session.estado !== SESSION_STATES.CLOSED,
      ).length,
    };
  }

  _persist(sessions) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporaryFile, "wx");
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify(sessions, null, 2)}\n`,
        "utf8",
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryFile, this.file);
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
  }

  save() {
    this._persist(this.sessions);
  }
}

module.exports = {
  ConversationStateStore,
  DEFAULT_PENDING_SESSION_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_TURNS,
  SESSION_STATES,
  createSession: newSession,
  emptyDraft,
  newSession,
};
