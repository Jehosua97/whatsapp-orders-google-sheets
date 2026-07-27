"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AdminConfigStore,
  nextAvailableSchedule,
  normalizeCatalog,
  normalizeSchedules,
} = require("../src/admin-config");

const baseConfig = {
  menuPrices: { chocolate: 3.5, vanilla: 3.5, bolillo: 2.5 },
  pickupTimeWindow: "5:00 p.m. a 6:00 p.m.",
  deliveryWindows: {
    wednesday: "después de las 3:00 PM",
    saturday: "después de las 10:00 AM",
  },
};

test("el catalogo administrativo alimenta la configuracion del bot", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-"));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, baseConfig);

  store.updateCatalog([
    {
      id: "taco-pastor",
      name: "Taco al pastor",
      sheetName: "Taco al pastor",
      emoji: "🌮",
      price: 4.25,
      active: true,
    },
  ]);

  const runtime = store.runtimeConfig();
  assert.equal(runtime.catalog[0].id, "taco-pastor");
  assert.equal(runtime.menuPrices["taco-pastor"], 4.25);
  assert.equal(
    new AdminConfigStore(file, baseConfig).getState().catalog[0].name,
    "Taco al pastor",
  );
});

test("no permite dejar el menu sin productos disponibles", () => {
  assert.throws(
    () =>
      normalizeCatalog([
        { name: "Bolillo", price: 2.5, active: false },
      ]),
    /por lo menos un producto disponible/,
  );
});

test("no permite dos horarios para el mismo dia", () => {
  assert.throws(
    () =>
      normalizeSchedules([
        { name: "Miércoles", weekday: 3 },
        { name: "Otra salida", weekday: 3 },
      ]),
    /Ya existe otro horario/,
  );
});

test("un cierre mueve el pedido a la siguiente fecha habilitada", () => {
  const state = {
    schedules: [
      {
        id: "wednesday",
        name: "Miércoles",
        weekday: 3,
        active: true,
        pickupEnabled: true,
        pickupWindow: "5:00 p.m.",
        deliveryEnabled: true,
        deliveryWindow: "3:00 p.m.",
      },
      {
        id: "saturday",
        name: "Sábado",
        weekday: 6,
        active: true,
        pickupEnabled: true,
        pickupWindow: "10:00 a.m.",
        deliveryEnabled: true,
        deliveryWindow: "10:00 a.m.",
      },
    ],
    closures: [
      {
        date: "2026-07-29",
        services: ["DELIVERY"],
      },
    ],
  };

  assert.deepEqual(
    nextAvailableSchedule(state, "2026-07-27", "DELIVERY"),
    {
      id: "saturday",
      name: "Sábado",
      date: "2026-08-01",
      timeWindow: "10:00 a.m.",
    },
  );
});
