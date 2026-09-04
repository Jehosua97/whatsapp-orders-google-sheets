"use strict";

const crypto = require("node:crypto");

const MODALIDADES = new Set(["PICKUP", "DELIVERY"]);
const CIUDADES_DELIVERY = new Set(["BRAMPTON", "MISSISSAUGA"]);
const DIRECCION_TIPOS = new Set(["TEXTO", "MAPS_LINK", "UBICACION"]);
const ORIGENES = new Set(["TEXTO", "CARRITO"]);
const PREPARACIONES = new Set(["FRESCO_PROGRAMADO", "PAN_LISTO_INMEDIATO"]);
const TOTAL_TOLERANCE = 0.01;

// This is deliberately the only natural-language rule in the order gate.
// It is applied to the real, latest customer message after removing accents.
const SI =
  /\b(si|claro|de acuerdo|dale|ok|okay|va|vale|correcto|perfecto|asi esta|asi queda|confirmo|confirmalo|confirmala|cierralo|reservalo|sirvela|mandala|mandalo|enviala|envialo|adelante|hagale|listo)\b/i;

const EMPTY_DRAFT = Object.freeze({
  items: Object.freeze([]),
  modalidad: "",
  ciudad: "",
  direccion: "",
  direccion_tipo: "",
  fecha: "",
  ventana: "",
  preparacion: "FRESCO_PROGRAMADO",
  origen: "TEXTO",
  order_id: "",
});

function normalizar(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return String(value ?? "").normalize("NFC").trim();
}

function enumValue(value, allowed) {
  const normalized = compact(value).toUpperCase();
  return allowed.has(normalized) ? normalized : "";
}

function cantidadValida(value) {
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

/**
 * Returns a canonical, complete product list. Duplicate ids are combined and
 * zero/invalid quantities are left out. Sorting makes signatures independent
 * from the order in which a model supplied the items.
 */
function normalizarItems(items) {
  const quantities = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const productId = compact(item?.product_id);
    const quantity = cantidadValida(item?.cantidad);
    if (!productId || !quantity) continue;
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([product_id, cantidad]) => ({ product_id, cantidad }));
}

function normalizarBorrador(draft = {}) {
  const modalidad = enumValue(draft.modalidad, MODALIDADES);
  return {
    items: normalizarItems(draft.items),
    modalidad,
    ciudad:
      modalidad === "DELIVERY"
        ? enumValue(draft.ciudad, CIUDADES_DELIVERY)
        : "",
    direccion: modalidad === "DELIVERY" ? compact(draft.direccion) : "",
    direccion_tipo:
      modalidad === "DELIVERY"
        ? enumValue(draft.direccion_tipo, DIRECCION_TIPOS)
        : "",
    fecha: compact(draft.fecha),
    ventana: compact(draft.ventana),
    preparacion:
      enumValue(draft.preparacion, PREPARACIONES) || "FRESCO_PROGRAMADO",
    origen: enumValue(draft.origen, ORIGENES) || "TEXTO",
    order_id: compact(draft.order_id),
  };
}

function crearBorrador(initial = {}) {
  return normalizarBorrador({ ...EMPTY_DRAFT, ...initial });
}

/**
 * Builds a new draft without mutating the current one. When `items` is in the
 * patch it is the complete replacement list, matching actualizar_borrador.
 */
function construirBorrador(current = {}, patch = {}) {
  return normalizarBorrador({
    ...normalizarBorrador(current),
    ...patch,
    items:
      Object.prototype.hasOwnProperty.call(patch, "items")
        ? patch.items
        : current.items,
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function hashBorrador(draft) {
  const canonical = stableValue(normalizarBorrador(draft));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function firmarResumen(session) {
  const signature = hashBorrador(session?.draft);
  if (session && typeof session === "object") {
    session.firma_resumen = signature;
  }
  return signature;
}

function toCents(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`${label} no es valido.`);
  }
  return Math.round((amount + Number.EPSILON) * 100);
}

function fromCents(value) {
  return Math.round(value) / 100;
}

function totalPiezas(draft) {
  return normalizarItems(draft?.items).reduce(
    (total, item) => total + item.cantidad,
    0,
  );
}

function catalogoActivo(config = {}) {
  return (Array.isArray(config.catalog) ? config.catalog : []).filter(
    (product) => product && product.active !== false,
  );
}

function productoPorId(config, productId, includeInactive = false) {
  const catalog = includeInactive
    ? Array.isArray(config.catalog)
      ? config.catalog
      : []
    : catalogoActivo(config);
  return catalog.find(
    (product) => compact(product.id) === compact(productId),
  );
}

function tarifaDelivery(ciudad, config = {}) {
  const key = String(ciudad || "").toLowerCase();
  if (!key) return 0;
  const fees = config.deliveryFees || {};
  return fromCents(toCents(fees[key], `La tarifa de ${ciudad}`));
}

/**
 * Server-authoritative quote. All arithmetic is performed in cents and only
 * active catalog products may be quoted.
 */
function cotizarInterno(draft, config = {}) {
  const normalized = normalizarBorrador(draft);
  let subtotalCents = 0;
  const lineas = normalized.items.map((item) => {
    const product = productoPorId(
      config,
      item.product_id,
      normalized.preparacion === "PAN_LISTO_INMEDIATO",
    );
    if (!product) {
      throw new Error(
        `El producto ${item.product_id} no existe o no esta disponible.`,
      );
    }
    const unitPriceCents = toCents(
      product.price,
      `El precio de ${item.product_id}`,
    );
    const lineTotalCents = unitPriceCents * item.cantidad;
    subtotalCents += lineTotalCents;
    return {
      product_id: item.product_id,
      nombre: compact(product.name || product.promptName || product.id),
      cantidad: item.cantidad,
      precio_unitario: fromCents(unitPriceCents),
      subtotal: fromCents(lineTotalCents),
    };
  });

  const shippingCents =
    normalized.modalidad === "DELIVERY" && normalized.ciudad
      ? toCents(
          tarifaDelivery(normalized.ciudad, config),
          `La tarifa de ${normalized.ciudad}`,
        )
      : 0;
  const pieces = totalPiezas(normalized);
  const minimum = Math.max(
    0,
    Number.isFinite(Number(config.minimumOrderPieces))
      ? Math.trunc(Number(config.minimumOrderPieces))
      : 0,
  );

  return {
    lineas,
    piezas: pieces,
    minimo: minimum,
    minimo_ok: pieces >= minimum,
    subtotal: fromCents(subtotalCents),
    envio: fromCents(shippingCents),
    total: fromCents(subtotalCents + shippingCents),
    moneda: compact(config.currency || config.currencyCode || "CAD").toUpperCase(),
  };
}

function fechaIsoValida(value) {
  const text = compact(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Ordered exactly as the sales policy: items, minimum, date, fulfillment,
 * then the delivery-only fields.
 */
function primerCampoFaltante(draft, config = {}) {
  const normalized = normalizarBorrador(draft);
  if (!normalized.items.length) return "ITEMS";

  if (Array.isArray(config.catalog) && config.catalog.length) {
    const hasUnavailableProduct = normalized.items.some(
      (item) =>
        !productoPorId(
          config,
          item.product_id,
          normalized.preparacion === "PAN_LISTO_INMEDIATO",
        ),
    );
    if (hasUnavailableProduct) return "ITEMS";
  }

  const minimum = Math.max(
    0,
    Number.isFinite(Number(config.minimumOrderPieces))
      ? Math.trunc(Number(config.minimumOrderPieces))
      : 0,
  );
  if (totalPiezas(normalized) < minimum) return "MINIMO";
  if (!fechaIsoValida(normalized.fecha)) return "FECHA";
  if (!MODALIDADES.has(normalized.modalidad)) return "MODALIDAD";
  if (normalized.modalidad === "DELIVERY") {
    if (!CIUDADES_DELIVERY.has(normalized.ciudad)) return "CIUDAD";
    if (!normalized.direccion) return "DIRECCION";
  }
  return "";
}

function esSiExplicito(ultimoMensajeCliente) {
  return SI.test(normalizar(ultimoMensajeCliente));
}

function err(motivo) {
  return { ok: false, motivo };
}

function puedeGuardar(session, ultimoMensajeCliente, cotizacionModel, config = {}) {
  if (!esSiExplicito(ultimoMensajeCliente)) {
    return err("SIN_CONFIRMACION_EXPLICITA");
  }

  const missing = primerCampoFaltante(session?.draft, config);
  if (missing) return err(`FALTA_${missing}`);

  // When this property is present, even an empty array means no valid date was
  // offered. Legacy callers without the property still receive ISO validation.
  if (Array.isArray(session?.fechas_ofrecidas)) {
    const selectedDate = normalizarBorrador(session?.draft).fecha;
    if (!session.fechas_ofrecidas.map(compact).includes(selectedDate)) {
      return err("FALTA_FECHA");
    }
  }

  if (hashBorrador(session?.draft) !== compact(session?.firma_resumen)) {
    return err("RESUMEN_DESACTUALIZADO");
  }

  let real;
  try {
    real = cotizarInterno(session?.draft, config);
  } catch {
    return err("COTIZACION_INVALIDA");
  }
  const modelTotal = Number(cotizacionModel?.total);
  if (
    !Number.isFinite(modelTotal) ||
    // A tiny epsilon prevents binary floating point from rejecting exactly
    // one cent (for example, 21.01 - 21).
    Math.abs(real.total - modelTotal) > TOTAL_TOLERANCE + 1e-9
  ) {
    return err("TOTAL_NO_COINCIDE");
  }
  return { ok: true };
}

module.exports = {
  CIUDADES_DELIVERY,
  DIRECCION_TIPOS,
  EMPTY_DRAFT,
  MODALIDADES,
  ORIGENES,
  PREPARACIONES,
  SI,
  TOTAL_TOLERANCE,
  catalogoActivo,
  construirBorrador,
  cotizarInterno,
  crearBorrador,
  esSiExplicito,
  fechaIsoValida,
  firmarResumen,
  hashBorrador,
  normalizar,
  normalizarBorrador,
  normalizarItems,
  primerCampoFaltante,
  productoPorId,
  puedeGuardar,
  tarifaDelivery,
  totalPiezas,

  // English aliases keep the module straightforward to consume from the new
  // agent layer while its domain payload remains in Spanish.
  canSave: puedeGuardar,
  createDraft: crearBorrador,
  draftHash: hashBorrador,
  firstMissingField: primerCampoFaltante,
  internalQuote: cotizarInterno,
  isExplicitYes: esSiExplicito,
  normalizeDraft: normalizarBorrador,
  updateDraft: construirBorrador,
};
