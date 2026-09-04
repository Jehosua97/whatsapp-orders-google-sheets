"use strict";

const READY_SOURCES = Object.freeze({
  READY: "PAN_LISTO",
  FRESH: "PRODUCCION_NUEVA",
  LOGISTICS: "LOGISTICA",
});

function compact(value) {
  return String(value ?? "").normalize("NFC").trim();
}

function integer(value, label, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} debe ser un número entero de ${minimum} o más.`);
  }
  return parsed;
}

function isoTimestamp(value, label) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} no es una fecha y hora válida.`);
  }
  return parsed.toISOString();
}

function catalogProduct(catalog, productId) {
  return (Array.isArray(catalog) ? catalog : []).find(
    (product) => compact(product?.id) === compact(productId),
  );
}

function normalizeReadyBatch(input = {}, options = {}) {
  const existing = options.existing || {};
  const catalog = options.catalog || [];
  const productId = compact(input.productId ?? existing.productId);
  if (!catalogProduct(catalog, productId)) {
    throw new Error("Selecciona un producto válido del catálogo.");
  }

  const quantityAvailable = integer(
    input.quantityAvailable ?? existing.quantityAvailable,
    "La cantidad disponible",
  );
  const quantityInitial = Math.max(
    integer(existing.quantityInitial ?? quantityAvailable, "La cantidad inicial"),
    quantityAvailable,
  );
  const readyAt = isoTimestamp(
    input.readyAt ?? existing.readyAt ?? options.now ?? new Date(),
    "La hora desde la que está listo",
  );
  const expiresAt = isoTimestamp(
    input.expiresAt ?? existing.expiresAt,
    "La hora límite de calidad",
  );
  if (Date.parse(expiresAt) <= Date.parse(readyAt)) {
    throw new Error("La hora límite debe ser posterior a la hora en que quedó listo.");
  }

  const pickupEnabled =
    input.pickupEnabled === undefined
      ? existing.pickupEnabled !== false
      : input.pickupEnabled === true;
  const deliveryEnabled =
    input.deliveryEnabled === undefined
      ? existing.deliveryEnabled !== false
      : input.deliveryEnabled === true;
  if (!pickupEnabled && !deliveryEnabled) {
    throw new Error("Activa pickup, delivery o ambos para este lote.");
  }

  return {
    id: compact(existing.id || input.id),
    productId,
    quantityInitial,
    quantityAvailable,
    readyAt,
    expiresAt,
    pickupEnabled,
    deliveryEnabled,
    note: compact(input.note ?? existing.note).slice(0, 160),
    createdAt: isoTimestamp(
      existing.createdAt || input.createdAt || options.now || new Date(),
      "La fecha de creación",
    ),
    updatedAt: isoTimestamp(options.now || new Date(), "La fecha de actualización"),
  };
}

function normalizeReadyBatches(items, catalog, now = new Date()) {
  const usedIds = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    try {
      const batch = normalizeReadyBatch(item, {
        catalog,
        existing: item,
        now,
      });
      if (!batch.id || usedIds.has(batch.id)) return [];
      usedIds.add(batch.id);
      return [batch];
    } catch {
      return [];
    }
  });
}

function normalizeReadyRequests(items) {
  const quantities = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const productId = compact(item?.product_id ?? item?.productId);
    const quantity = Number(item?.cantidad ?? item?.quantity);
    if (!productId || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return [...quantities.entries()].map(([productId, quantity]) => ({
    productId,
    quantity,
  }));
}

function batchIsUsable(batch, { now = new Date(), modality = "CUALQUIERA" } = {}) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(at)) return false;
  if (Number(batch?.quantityAvailable || 0) <= 0) return false;
  if (Date.parse(batch.readyAt) > at || Date.parse(batch.expiresAt) <= at) {
    return false;
  }
  if (modality === "PICKUP" && batch.pickupEnabled === false) return false;
  if (modality === "DELIVERY" && batch.deliveryEnabled === false) return false;
  if (
    modality === "CUALQUIERA" &&
    batch.pickupEnabled === false &&
    batch.deliveryEnabled === false
  ) {
    return false;
  }
  return true;
}

function availableReadyInventory(batches, options = {}) {
  const usable = (Array.isArray(batches) ? batches : [])
    .filter((batch) => batchIsUsable(batch, options))
    .sort(
      (left, right) =>
        String(left.expiresAt).localeCompare(String(right.expiresAt)) ||
        String(left.readyAt).localeCompare(String(right.readyAt)),
    );
  const products = new Map();
  for (const batch of usable) {
    const current = products.get(batch.productId) || {
      productId: batch.productId,
      quantityAvailable: 0,
      earliestExpiresAt: batch.expiresAt,
      pickupEnabled: false,
      deliveryEnabled: false,
    };
    current.quantityAvailable += Number(batch.quantityAvailable || 0);
    if (String(batch.expiresAt) < String(current.earliestExpiresAt)) {
      current.earliestExpiresAt = batch.expiresAt;
    }
    current.pickupEnabled ||= batch.pickupEnabled !== false;
    current.deliveryEnabled ||= batch.deliveryEnabled !== false;
    products.set(batch.productId, current);
  }
  return { batches: usable, products: [...products.values()] };
}

function planReadyAllocation(batches, requests, options = {}) {
  const wanted = normalizeReadyRequests(requests);
  if (!wanted.length) {
    return { ok: false, allocations: [], shortages: [] };
  }
  const available = availableReadyInventory(batches, options);
  const shadow = new Map(
    available.batches.map((batch) => [batch.id, Number(batch.quantityAvailable)]),
  );
  const allocations = [];
  const shortages = [];

  for (const request of wanted) {
    let remaining = request.quantity;
    for (const batch of available.batches) {
      if (batch.productId !== request.productId || remaining <= 0) continue;
      const quantity = Math.min(remaining, shadow.get(batch.id) || 0);
      if (!quantity) continue;
      allocations.push({
        batchId: batch.id,
        productId: request.productId,
        quantity,
        expiresAt: batch.expiresAt,
      });
      shadow.set(batch.id, (shadow.get(batch.id) || 0) - quantity);
      remaining -= quantity;
    }
    if (remaining > 0) {
      shortages.push({
        productId: request.productId,
        requested: request.quantity,
        available: request.quantity - remaining,
        missing: remaining,
      });
    }
  }

  return {
    ok: shortages.length === 0,
    allocations: shortages.length ? [] : allocations,
    shortages,
  };
}

module.exports = {
  READY_SOURCES,
  availableReadyInventory,
  batchIsUsable,
  catalogProduct,
  normalizeReadyBatch,
  normalizeReadyBatches,
  normalizeReadyRequests,
  planReadyAllocation,
};
