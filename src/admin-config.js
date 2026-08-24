"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeProductionWeekdays,
} = require("./product-availability");
const {
  correctProductId,
  correctProductName,
} = require("./product-naming");

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

function defaultState(baseConfig) {
  const configuredAllowedPhones = [
    ...(baseConfig.automationAllowedPhones || []),
  ];
  return {
    version: 2,
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
    promotions: { ...DEFAULT_PROMOTIONS },
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
        version: 2,
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
        promotions: {
          ...DEFAULT_PROMOTIONS,
          ...(parsed.promotions || {}),
          freeBramptonDelivery:
            parsed.promotions?.freeBramptonDelivery !== false,
        },
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
      automationAllowedChatIds: new Set(),
      automationAllowedPhones: new Set(state.automation.allowedPhones),
      automationBlockedPhones: new Set(state.automation.blockedPhones),
      promotions: state.promotions,
      deliveryFees: {
        ...this.baseConfig.deliveryFees,
        brampton: state.promotions.freeBramptonDelivery
          ? 0
          : this.baseConfig.deliveryFees.brampton,
      },
    };
  }

  updateCatalog(catalog) {
    return this.persist({
      ...this.state,
      catalog: normalizeCatalog(catalog),
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
