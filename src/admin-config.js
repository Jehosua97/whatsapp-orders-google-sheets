"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_PRODUCTS = 10;
const SERVICE_TYPES = ["PICKUP", "DELIVERY"];

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

function defaultState(baseConfig) {
  return {
    version: 1,
    catalog: [
      {
        id: "chocolate",
        name: "Conchitas Chocolate",
        promptName: "Conchitas de Chocolate",
        sheetName: "Concha de chocolate",
        emoji: "🍫",
        price: Number(baseConfig.menuPrices.chocolate),
        active: true,
      },
      {
        id: "vanilla",
        name: "Conchitas Vainilla",
        promptName: "Conchitas de Vainilla",
        sheetName: "Concha de Vainilla",
        emoji: "🍦",
        price: Number(baseConfig.menuPrices.vanilla),
        active: true,
      },
      {
        id: "bolillo",
        name: "Bolillos",
        promptName: "Bolillos",
        sheetName: "Bolillo",
        emoji: "🍞",
        price: Number(baseConfig.menuPrices.bolillo),
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
    return {
      id,
      name,
      promptName: String(item.promptName || name).trim(),
      sheetName: String(item.sheetName || name).trim(),
      emoji: String(item.emoji || "🥖").trim().slice(0, 8),
      price: Math.round(price * 100) / 100,
      active: item.active !== false,
    };
  });
  if (!normalized.some((product) => product.active)) {
    throw new Error("Debe quedar por lo menos un producto disponible.");
  }
  return normalized;
}

function normalizeSchedules(schedules) {
  if (!Array.isArray(schedules) || !schedules.length) {
    throw new Error("Debe existir por lo menos un día de servicio.");
  }

  const usedIds = new Set();
  const usedWeekdays = new Set();
  return schedules.map((item, index) => {
    const name = String(item.name || "").trim();
    const weekday = Number(item.weekday);
    if (!name) throw new Error(`Falta el nombre del horario ${index + 1}.`);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`El día de ${name} no es válido.`);
    }
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
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        ...defaultState(this.baseConfig),
        ...parsed,
        catalog: normalizeCatalog(parsed.catalog),
        schedules: normalizeSchedules(parsed.schedules),
        closures: Array.isArray(parsed.closures) ? parsed.closures : [],
        notifications: Array.isArray(parsed.notifications)
          ? parsed.notifications
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
  MAX_PRODUCTS,
  SERVICE_TYPES,
  addDays,
  dateWeekday,
  defaultState,
  isServiceClosed,
  nextAvailableSchedule,
  normalizeCatalog,
  normalizeSchedules,
  scheduleForDate,
  serviceEnabled,
  serviceWindow,
  validIsoDate,
};
