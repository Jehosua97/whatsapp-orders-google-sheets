"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeProductionWeekdays,
} = require("./product-availability");
const {
  correctProductId,
  correctProductName,
} = require("./product-naming");
const {
  availableReadyInventory,
  normalizeReadyBatch,
  normalizeReadyBatches,
  planReadyAllocation,
} = require("./ready-inventory");

const MAX_PRODUCTS = 10;
const SERVICE_TYPES = ["PICKUP", "DELIVERY"];
const AUTOMATION_MODES = ["NORMAL", "TESTING"];
const DEFAULT_PROMOTIONS = { freeBramptonDelivery: true };
const WEEKDAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function phoneList(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").replace(/\D/g, ""))
        .filter(Boolean),
    ),
  ];
}

function normalizeAutomation(automation = {}) {
  const mode = String(automation.mode || "").toUpperCase();
  if (!AUTOMATION_MODES.includes(mode)) {
    throw new Error("El modo de automatización no es válido.");
  }
  const allowedPhones = phoneList(automation.allowedPhones);
  const blockedPhones = phoneList(automation.blockedPhones);
  const invalid = [...allowedPhones, ...blockedPhones].find(
    (phone) => phone.length < 10 || phone.length > 15,
  );
  if (invalid) {
    throw new Error(
      "Los números deben incluir código de país y tener entre 10 y 15 dígitos.",
    );
  }
  const blocked = new Set(blockedPhones);
  if (allowedPhones.some((phone) => blocked.has(phone))) {
    throw new Error(
      "Un número no puede estar permitido y bloqueado al mismo tiempo.",
    );
  }
  return { mode, allowedPhones, blockedPhones };
}

function normalizeAi(ai = {}, baseConfig = {}) {
  return {
    enabled:
      ai.enabled === undefined
        ? baseConfig.aiEnabledByDefault !== false
        : ai.enabled === true,
  };
}

function defaultState(baseConfig) {
  const configuredAllowedPhones = [
    ...(baseConfig.automationAllowedPhones || []),
  ];
  return {
    version: 4,
    botEnabled: true,
    catalog: [
      {
        id: "chocolate",
        name: "Conchitas Chocolate",
        promptName: "Conchitas de Chocolate",
        sheetName: "Concha de chocolate",
        emoji: "🍫",
        price: Number(baseConfig.menuPrices.chocolate),
        productionWeekdays: [3, 6],
        active: true,
      },
      {
        id: "vanilla",
        name: "Conchitas Vainilla",
        promptName: "Conchitas de Vainilla",
        sheetName: "Concha de Vainilla",
        emoji: "🍦",
        price: Number(baseConfig.menuPrices.vanilla),
        productionWeekdays: [3, 6],
        active: true,
      },
      {
        id: "bolillo",
        name: "Bolillos",
        promptName: "Bolillos",
        sheetName: "Bolillo",
        emoji: "🍞",
        price: Number(baseConfig.menuPrices.bolillo),
        productionWeekdays: [3, 6],
        active: true,
      },
      {
        id: "volovan-pastor",
        name: "Volován de Pastor",
        promptName: "Volovanes de Pastor",
        sheetName: "Volován de Pastor",
        emoji: "🥐",
        price: 6,
        productionWeekdays: [2, 4],
        active: true,
      },
      {
        id: "volovan-chorizo",
        name: "Volován de Chorizo",
        promptName: "Volovanes de Chorizo",
        sheetName: "Volován de Chorizo",
        emoji: "🥐",
        price: 6,
        productionWeekdays: [2, 4],
        active: true,
      },
      {
        id: "rol-tres-leches",
        name: "Rol de 3 Leches",
        promptName: "Roles de 3 Leches",
        sheetName: "Rol de 3 Leches",
        emoji: "🍥",
        price: 10,
        productionWeekdays: [2, 4],
        active: true,
      },
      {
        id: "rol-clasico-glaseado",
        name: "Rol Clásico Glaseado",
        promptName: "Roles Clásicos Glaseados",
        sheetName: "Rol Clásico Glaseado",
        emoji: "🍥",
        price: 10,
        productionWeekdays: [2, 4],
        active: true,
      },
    ],
    schedules: [
      {
        id: "wednesday",
        name: "Miércoles",
        weekday: 3,
        active: true,
        pickupEnabled: true,
        pickupWindow: baseConfig.pickupTimeWindow,
        deliveryEnabled: true,
        deliveryWindow: baseConfig.deliveryWindows.wednesday,
      },
      {
        id: "saturday",
        name: "Sábado",
        weekday: 6,
        active: true,
        pickupEnabled: true,
        pickupWindow: baseConfig.pickupTimeWindow,
        deliveryEnabled: true,
        deliveryWindow: baseConfig.deliveryWindows.saturday,
      },
    ],
    closures: [],
    notifications: [],
    automation: {
      mode: "TESTING",
      allowedPhones: configuredAllowedPhones,
      blockedPhones: [],
    },
    ai: normalizeAi({}, baseConfig),
    promotions: { ...DEFAULT_PROMOTIONS },
    readyInventory: [],
    readyInventoryMovements: [],
    readyReservations: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog) || !catalog.length) {
    throw new Error("El catálogo debe tener por lo menos un producto.");
  }
  if (catalog.length > MAX_PRODUCTS) {
    throw new Error(`El catálogo admite hasta ${MAX_PRODUCTS} productos.`);
  }

  const usedIds = new Set();
  const normalized = catalog.map((item, index) => {
    const name = String(item.name || "").trim();
    const price = Number(item.price);
    if (!name) throw new Error(`Falta el nombre del producto ${index + 1}.`);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`El precio de ${name} no es válido.`);
    }

    let id = slug(item.id || name) || `producto-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const productionWeekdays = normalizeProductionWeekdays(
      item.productionWeekdays === undefined
        ? [3, 6]
        : item.productionWeekdays,
    );
    if (item.active !== false && !productionWeekdays.length) {
      throw new Error(
        `Selecciona por lo menos un día de producción para ${name}.`,
      );
    }
    return {
      id,
      name,
      promptName: String(item.promptName || name).trim(),
      sheetName: name,
      emoji: String(item.emoji || "🥖").trim().slice(0, 8),
      price: Math.round(price * 100) / 100,
      productionWeekdays,
      active: item.active !== false,
    };
  });
  if (!normalized.some((product) => product.active)) {
    throw new Error("Debe quedar por lo menos un producto disponible.");
  }
  return normalized;
}

function repairCatalogEncoding(catalog, defaults) {
  const defaultsById = new Map(
    defaults.map((product) => [product.id, product]),
  );
  return catalog.map((product) => {
    const id = correctProductId(product.id);
    const corrected = {
      ...product,
      id,
      name: correctProductName(product.name),
      promptName: correctProductName(product.promptName),
      sheetName: correctProductName(product.sheetName),
    };
    const fallback = defaultsById.get(id);
    if (!fallback) return corrected;
    const invalidEmoji =
      !corrected.emoji ||
      /^[?]+$/.test(String(corrected.emoji)) ||
      String(corrected.emoji).includes("�");
    const repairText = (value, key) =>
      String(value || "").includes("�") ? fallback[key] : value;
    return {
      ...corrected,
      emoji: invalidEmoji ? fallback.emoji : corrected.emoji,
      name: repairText(corrected.name, "name"),
      promptName: repairText(corrected.promptName, "promptName"),
      sheetName: repairText(corrected.sheetName, "sheetName"),
    };
  });
}

function repairScheduleEncoding(schedules, defaults) {
  const defaultsById = new Map(
    defaults.map((schedule) => [schedule.id, schedule]),
  );
  return schedules.map((schedule) => {
    const fallback = defaultsById.get(schedule.id);
    if (!fallback) return schedule;
    const repairText = (value, key) =>
      String(value || "").includes("�") ? fallback[key] : value;
    return {
      ...schedule,
      pickupWindow: repairText(schedule.pickupWindow, "pickupWindow"),
      deliveryWindow: repairText(
        schedule.deliveryWindow,
        "deliveryWindow",
      ),
    };
  });
}

function normalizeSchedules(schedules) {
  if (!Array.isArray(schedules) || !schedules.length) {
    throw new Error("Debe existir por lo menos un día de servicio.");
  }

  const usedIds = new Set();
  const usedWeekdays = new Set();
  return schedules.map((item, index) => {
    const weekday = Number(item.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`El día del horario ${index + 1} no es válido.`);
    }
    const name = WEEKDAY_NAMES[weekday];
    if (usedWeekdays.has(weekday)) {
      throw new Error(`Ya existe otro horario para ${name}.`);
    }
    usedWeekdays.add(weekday);
    let id = slug(item.id || name) || `horario-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    return {
      id,
      name,
      weekday,
      active: item.active !== false,
      pickupEnabled: item.pickupEnabled !== false,
      pickupWindow: String(item.pickupWindow || "").trim(),
      deliveryEnabled: item.deliveryEnabled !== false,
      deliveryWindow: String(item.deliveryWindow || "").trim(),
    };
  });
}

function normalizeServices(services) {
  const selected = new Set(
    (Array.isArray(services) ? services : [])
      .map((value) => String(value).toUpperCase())
      .filter((value) => SERVICE_TYPES.includes(value)),
  );
  if (!selected.size) throw new Error("Selecciona Pickup o Delivery.");
  return SERVICE_TYPES.filter((value) => selected.has(value));
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function dateWeekday(date) {
  if (!validIsoDate(date)) return -1;
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function scheduleForDate(state, date) {
  const weekday = dateWeekday(date);
  return state.schedules.find(
    (schedule) => schedule.active && schedule.weekday === weekday,
  );
}

function isServiceClosed(state, date, serviceType) {
  return state.closures.some(
    (closure) =>
      closure.date === date &&
      closure.services.includes(String(serviceType).toUpperCase()),
  );
}

function serviceWindow(schedule, serviceType) {
  return serviceType === "PICKUP"
    ? schedule.pickupWindow
    : schedule.deliveryWindow;
}

function serviceEnabled(schedule, serviceType) {
  return serviceType === "PICKUP"
    ? schedule.pickupEnabled
    : schedule.deliveryEnabled;
}

function nextAvailableSchedule(state, afterDate, serviceType, limit = 90) {
  for (let offset = 1; offset <= limit; offset += 1) {
    const date = addDays(afterDate, offset);
    const schedule = scheduleForDate(state, date);
    if (
      schedule &&
      serviceEnabled(schedule, serviceType) &&
      !isServiceClosed(state, date, serviceType)
    ) {
      return {
        id: schedule.id,
        name: schedule.name,
        date,
        timeWindow: serviceWindow(schedule, serviceType),
      };
    }
  }
  return null;
}

class AdminConfigStore {
  constructor(file, baseConfig) {
    this.file = file;
    this.baseConfig = baseConfig;
    this.state = this.load();
    this.persist(this.state);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const defaults = defaultState(this.baseConfig);
      return {
        ...defaults,
        ...parsed,
        version: 4,
        botEnabled: parsed.botEnabled !== false,
        catalog: normalizeCatalog(
          repairCatalogEncoding(parsed.catalog, defaults.catalog),
        ),
        schedules: normalizeSchedules(
          repairScheduleEncoding(parsed.schedules, defaults.schedules),
        ),
        closures: Array.isArray(parsed.closures) ? parsed.closures : [],
        notifications: Array.isArray(parsed.notifications)
          ? parsed.notifications
          : [],
        automation: normalizeAutomation(
          parsed.automation || defaults.automation,
        ),
        ai: normalizeAi(parsed.ai || defaults.ai, this.baseConfig),
        promotions: {
          ...DEFAULT_PROMOTIONS,
          ...(parsed.promotions || {}),
          freeBramptonDelivery:
            parsed.promotions?.freeBramptonDelivery !== false,
        },
        readyInventory: normalizeReadyBatches(
          parsed.readyInventory,
          normalizeCatalog(
            repairCatalogEncoding(parsed.catalog, defaults.catalog),
          ),
        ),
        readyInventoryMovements: Array.isArray(parsed.readyInventoryMovements)
          ? parsed.readyInventoryMovements.slice(-1000)
          : [],
        readyReservations: Array.isArray(parsed.readyReservations)
          ? parsed.readyReservations.slice(-1000)
          : [],
      };
    } catch {
      const state = defaultState(this.baseConfig);
      this.persist(state);
      return state;
    }
  }

  persist(nextState = this.state) {
    const state = {
      ...nextState,
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporaryFile = `${this.file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryFile, this.file);
    this.state = state;
    return this.getState();
  }

  getState() {
    return clone(this.state);
  }

  runtimeConfig() {
    const state = this.getState();
    return {
      ...this.baseConfig,
      catalog: state.catalog,
      schedules: state.schedules,
      closures: state.closures,
      menuPrices: Object.fromEntries(
        state.catalog.map((product) => [product.id, product.price]),
      ),
      automationMode: state.automation.mode,
      botEnabled: state.botEnabled,
      aiEnabled: state.ai.enabled,
      aiRewriteResponses: this.baseConfig.aiRewriteResponses !== false,
      automationAllowedChatIds: new Set(),
      automationAllowedPhones: new Set(state.automation.allowedPhones),
      automationBlockedPhones: new Set(state.automation.blockedPhones),
      promotions: state.promotions,
      readyInventory: state.readyInventory,
      deliveryFees: {
        ...this.baseConfig.deliveryFees,
        brampton: state.promotions.freeBramptonDelivery
          ? 0
          : this.baseConfig.deliveryFees.brampton,
      },
    };
  }

  updateCatalog(catalog) {
    const normalizedCatalog = normalizeCatalog(catalog);
    const ids = new Set(normalizedCatalog.map((product) => product.id));
    return this.persist({
      ...this.state,
      catalog: normalizedCatalog,
      readyInventory: this.state.readyInventory.filter((batch) =>
        ids.has(batch.productId),
      ),
    });
  }

  updateSchedules(schedules) {
    return this.persist({
      ...this.state,
      schedules: normalizeSchedules(schedules),
    });
  }

  updateAutomation(automation) {
    return this.persist({
      ...this.state,
      automation: normalizeAutomation(automation),
    });
  }

  updateBotEnabled(enabled) {
    return this.persist({
      ...this.state,
      botEnabled: enabled === true,
    });
  }

  updateAi(ai) {
    return this.persist({
      ...this.state,
      ai: normalizeAi(ai, this.baseConfig),
    });
  }

  updatePromotions(promotions = {}) {
    return this.persist({
      ...this.state,
      promotions: {
        ...this.state.promotions,
        freeBramptonDelivery:
          promotions.freeBramptonDelivery === true,
      },
    });
  }

  addReadyInventory(input, now = new Date()) {
    const timestamp = now.toISOString();
    const batch = normalizeReadyBatch(
      {
        ...input,
        id: `listo-${crypto.randomUUID()}`,
        readyAt: input?.readyAt || timestamp,
        createdAt: timestamp,
      },
      { catalog: this.state.catalog, now },
    );
    if (batch.quantityAvailable <= 0) {
      throw new Error("Agrega por lo menos una pieza disponible.");
    }
    const movement = {
      id: `mov-${crypto.randomUUID()}`,
      type: "ALTA",
      batchId: batch.id,
      productId: batch.productId,
      quantity: batch.quantityAvailable,
      orderId: "",
      note: batch.note,
      at: timestamp,
    };
    this.persist({
      ...this.state,
      readyInventory: [...this.state.readyInventory, batch],
      readyInventoryMovements: [
        ...this.state.readyInventoryMovements,
        movement,
      ].slice(-1000),
    });
    return clone(batch);
  }

  updateReadyInventory(id, patch, now = new Date()) {
    const current = this.state.readyInventory.find((batch) => batch.id === id);
    if (!current) throw new Error("No se encontró ese lote de pan listo.");
    const updated = normalizeReadyBatch(patch, {
      catalog: this.state.catalog,
      existing: current,
      now,
    });
    const difference = updated.quantityAvailable - current.quantityAvailable;
    const movements = [...this.state.readyInventoryMovements];
    if (difference) {
      movements.push({
        id: `mov-${crypto.randomUUID()}`,
        type: "AJUSTE_ADMIN",
        batchId: updated.id,
        productId: updated.productId,
        quantity: difference,
        orderId: "",
        note: updated.note,
        at: now.toISOString(),
      });
    }
    this.persist({
      ...this.state,
      readyInventory: this.state.readyInventory.map((batch) =>
        batch.id === id ? updated : batch,
      ),
      readyInventoryMovements: movements.slice(-1000),
    });
    return clone(updated);
  }

  removeReadyInventory(id, now = new Date()) {
    const current = this.state.readyInventory.find((batch) => batch.id === id);
    if (!current) throw new Error("No se encontró ese lote de pan listo.");
    this.persist({
      ...this.state,
      readyInventory: this.state.readyInventory.filter(
        (batch) => batch.id !== id,
      ),
      readyInventoryMovements: [
        ...this.state.readyInventoryMovements,
        {
          id: `mov-${crypto.randomUUID()}`,
          type: "BAJA_ADMIN",
          batchId: current.id,
          productId: current.productId,
          quantity: -Number(current.quantityAvailable || 0),
          orderId: "",
          note: current.note,
          at: now.toISOString(),
        },
      ].slice(-1000),
    });
    return clone(current);
  }

  readyAvailability({ now = new Date(), modality = "CUALQUIERA" } = {}) {
    return clone(
      availableReadyInventory(this.state.readyInventory, { now, modality }),
    );
  }

  reserveReadyInventory(requests, orderId, options = {}) {
    const wantedOrderId = String(orderId || "").trim();
    if (!wantedOrderId) throw new Error("El ID del pedido es obligatorio.");
    const previous = this.state.readyReservations.find(
      (reservation) =>
        reservation.orderId === wantedOrderId &&
        ["PENDIENTE", "RESERVADO"].includes(reservation.status),
    );
    if (previous) {
      return { ok: true, allocations: clone(previous.allocations), repeated: true };
    }

    const now = options.now || new Date();
    const modality = options.modality || "CUALQUIERA";
    const plan = planReadyAllocation(this.state.readyInventory, requests, {
      now,
      modality,
    });
    if (!plan.ok) return clone(plan);

    const quantitiesByBatch = new Map();
    for (const allocation of plan.allocations) {
      quantitiesByBatch.set(
        allocation.batchId,
        (quantitiesByBatch.get(allocation.batchId) || 0) + allocation.quantity,
      );
    }
    const inventory = this.state.readyInventory.map((batch) => {
      const reserved = quantitiesByBatch.get(batch.id) || 0;
      return reserved
        ? {
            ...batch,
            quantityAvailable: batch.quantityAvailable - reserved,
            updatedAt: now.toISOString(),
          }
        : batch;
    });
    const reservation = {
      orderId: wantedOrderId,
      modality,
      status: "PENDIENTE",
      allocations: plan.allocations,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const movements = plan.allocations.map((allocation) => ({
      id: `mov-${crypto.randomUUID()}`,
      type: "RESERVA_PEDIDO",
      batchId: allocation.batchId,
      productId: allocation.productId,
      quantity: -allocation.quantity,
      orderId: wantedOrderId,
      note: "",
      at: now.toISOString(),
    }));
    this.persist({
      ...this.state,
      readyInventory: inventory,
      readyReservations: [...this.state.readyReservations, reservation].slice(
        -1000,
      ),
      readyInventoryMovements: [
        ...this.state.readyInventoryMovements,
        ...movements,
      ].slice(-1000),
    });
    return { ok: true, allocations: clone(plan.allocations), repeated: false };
  }

  pendingReadyReservations() {
    return clone(
      this.state.readyReservations.filter((reservation) =>
        ["PENDIENTE", "RESERVADO"].includes(reservation.status),
      ),
    );
  }

  commitReadyInventory(orderId, now = new Date()) {
    const wantedOrderId = String(orderId || "").trim();
    let changed = false;
    const reservations = this.state.readyReservations.map((reservation) => {
      if (
        reservation.orderId !== wantedOrderId ||
        !["PENDIENTE", "RESERVADO"].includes(reservation.status)
      ) {
        return reservation;
      }
      changed = true;
      return {
        ...reservation,
        status: "CONFIRMADO",
        updatedAt: now.toISOString(),
      };
    });
    if (!changed) return false;
    this.persist({ ...this.state, readyReservations: reservations });
    return true;
  }

  rollbackReadyInventory(orderId, now = new Date()) {
    const wantedOrderId = String(orderId || "").trim();
    const reservation = this.state.readyReservations.find(
      (item) =>
        item.orderId === wantedOrderId &&
        ["PENDIENTE", "RESERVADO"].includes(item.status),
    );
    if (!reservation) return false;
    const returnedByBatch = new Map();
    for (const allocation of reservation.allocations || []) {
      returnedByBatch.set(
        allocation.batchId,
        (returnedByBatch.get(allocation.batchId) || 0) + allocation.quantity,
      );
    }
    const inventory = this.state.readyInventory.map((batch) => {
      const returned = returnedByBatch.get(batch.id) || 0;
      return returned
        ? {
            ...batch,
            quantityAvailable: batch.quantityAvailable + returned,
            quantityInitial: Math.max(
              batch.quantityInitial,
              batch.quantityAvailable + returned,
            ),
            updatedAt: now.toISOString(),
          }
        : batch;
    });
    const reservations = this.state.readyReservations.map((item) =>
      item === reservation
        ? { ...item, status: "REVERTIDO", updatedAt: now.toISOString() }
        : item,
    );
    const movements = (reservation.allocations || []).map((allocation) => ({
      id: `mov-${crypto.randomUUID()}`,
      type: "REVERSA_ERROR",
      batchId: allocation.batchId,
      productId: allocation.productId,
      quantity: allocation.quantity,
      orderId: wantedOrderId,
      note: "El pedido no pudo guardarse en Excel",
      at: now.toISOString(),
    }));
    this.persist({
      ...this.state,
      readyInventory: inventory,
      readyReservations: reservations,
      readyInventoryMovements: [
        ...this.state.readyInventoryMovements,
        ...movements,
      ].slice(-1000),
    });
    return true;
  }

  upsertClosure({ date, services, reason }) {
    if (!validIsoDate(date)) throw new Error("La fecha no es válida.");
    const normalizedServices = normalizeServices(services);
    const existing = this.state.closures.find(
      (closure) => closure.date === date,
    );
    const closure = {
      id: existing?.id || `cierre-${date}`,
      date,
      services: normalizedServices,
      reason: String(reason || "").trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    const closures = this.state.closures
      .filter((item) => item.date !== date)
      .concat(closure)
      .sort((left, right) => left.date.localeCompare(right.date));
    this.persist({ ...this.state, closures });
    return clone(closure);
  }

  removeClosure(id) {
    const closures = this.state.closures.filter(
      (closure) => closure.id !== id,
    );
    if (closures.length === this.state.closures.length) {
      throw new Error("No se encontró el cierre.");
    }
    return this.persist({ ...this.state, closures });
  }

  recordNotification(notification) {
    const notifications = this.state.notifications
      .filter(
        (item) =>
          !(
            item.orderId === notification.orderId &&
            item.fromDate === notification.fromDate
          ),
      )
      .concat({
        ...notification,
        sentAt: new Date().toISOString(),
      })
      .slice(-500);
    return this.persist({ ...this.state, notifications });
  }
}

module.exports = {
  AdminConfigStore,
  AUTOMATION_MODES,
  MAX_PRODUCTS,
  SERVICE_TYPES,
  WEEKDAY_NAMES,
  addDays,
  dateWeekday,
  defaultState,
  isServiceClosed,
  nextAvailableSchedule,
  normalizeAi,
  normalizeCatalog,
  normalizeAutomation,
  normalizeSchedules,
  repairCatalogEncoding,
  repairScheduleEncoding,
  scheduleForDate,
  serviceEnabled,
  serviceWindow,
  validIsoDate,
};
