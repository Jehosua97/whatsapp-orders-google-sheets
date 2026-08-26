"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  AdminConfigStore,
  nextAvailableSchedule,
  normalizeAutomation,
  normalizeCatalog,
  normalizeSchedules,
} = require("../src/admin-config");

const baseConfig = {
  menuPrices: { chocolate: 3.5, vanilla: 3.5, bolillo: 2.5 },
  deliveryFees: { brampton: 5, mississauga: 8 },
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
      productionWeekdays: [2, 4],
      active: true,
    },
  ]);

  const runtime = store.runtimeConfig();
  assert.equal(runtime.catalog[0].id, "taco-pastor");
  assert.equal(runtime.catalog[0].sheetName, "Taco al pastor");
  assert.deepEqual(runtime.catalog[0].productionWeekdays, [2, 4]);
  assert.equal(runtime.menuPrices["taco-pastor"], 4.25);
  assert.equal(
    new AdminConfigStore(file, baseConfig).getState().catalog[0].name,
    "Taco al pastor",
  );
});

test("la promocion de Brampton cambia la tarifa del bot y se puede desactivar", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-promo-"));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, baseConfig);

  assert.equal(store.runtimeConfig().deliveryFees.brampton, 0);
  assert.equal(store.runtimeConfig().deliveryFees.mississauga, 8);

  store.updatePromotions({ freeBramptonDelivery: false });
  assert.equal(store.runtimeConfig().deliveryFees.brampton, 5);
  assert.equal(store.getState().promotions.freeBramptonDelivery, false);
});

test("usa el mismo nombre del producto en la hoja de cocina", () => {
  const product = normalizeCatalog([
    {
      name: "Concha especial",
      sheetName: "Nombre anterior",
      price: 4,
      active: true,
    },
  ])[0];

  assert.equal(product.name, "Concha especial");
  assert.equal(product.sheetName, "Concha especial");
  assert.deepEqual(product.productionWeekdays, [3, 6]);
});

test("migra el nombre anterior del volovan en catalogos guardados", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-"));
  const file = path.join(directory, "admin.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      catalog: [
        {
          id: "bolobon-pastor",
          name: "Bolobón de Pastor",
          promptName: "Bolobones de Pastor",
          sheetName: "Bolobón de Pastor",
          emoji: "🥐",
          price: 6,
          productionWeekdays: [2, 4],
          active: true,
        },
      ],
      schedules: [
        {
          id: "tuesday",
          name: "Martes",
          weekday: 2,
          active: true,
          pickupEnabled: true,
          pickupWindow: "5:00 p.m.",
          deliveryEnabled: true,
          deliveryWindow: "3:00 p.m.",
        },
      ],
      closures: [],
      notifications: [],
    }),
  );

  const product = new AdminConfigStore(file, baseConfig).getState().catalog[0];

  assert.equal(product.id, "volovan-pastor");
  assert.equal(product.name, "Volován de Pastor");
  assert.equal(product.promptName, "Volovanes de Pastor");
  assert.equal(product.sheetName, "Volován de Pastor");
});

test("exige produccion para cada producto disponible", () => {
  assert.throws(
    () =>
      normalizeCatalog([
        {
          name: "Producto sin fecha",
          price: 4,
          productionWeekdays: [],
          active: true,
        },
      ]),
    /día de producción/i,
  );
});

test("guarda los modos de automatizacion y sus listas de telefonos", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-"));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, {
    ...baseConfig,
    automationAllowedPhones: new Set(["14378781645"]),
    automationAllowedChatIds: new Set(),
  });

  assert.equal(store.getState().automation.mode, "TESTING");
  assert.deepEqual(store.getState().automation.allowedPhones, [
    "14378781645",
  ]);

  store.updateAutomation({
    mode: "NORMAL",
    allowedPhones: ["14378781645"],
    blockedPhones: ["16470000000"],
  });
  const runtime = store.runtimeConfig();
  assert.equal(runtime.automationMode, "NORMAL");
  assert.equal(runtime.automationAllowedPhones.has("14378781645"), true);
  assert.equal(runtime.automationBlockedPhones.has("16470000000"), true);
});

test("el control global del bot se guarda y llega a la configuracion activa", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-bot-control-"));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, baseConfig);

  assert.equal(store.runtimeConfig().botEnabled, true);
  store.updateBotEnabled(false);
  assert.equal(store.runtimeConfig().botEnabled, false);
  assert.equal(new AdminConfigStore(file, baseConfig).getState().botEnabled, false);
});

test("la activacion de IA se guarda sin persistir la llave secreta", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-ai-config-"));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, {
    ...baseConfig,
    aiEnabledByDefault: true,
    aiRewriteResponses: true,
    openaiApiKey: "secret-test-key",
  });

  assert.equal(store.runtimeConfig().aiEnabled, true);
  store.updateAi({ enabled: false });
  assert.equal(store.runtimeConfig().aiEnabled, false);
  assert.equal(new AdminConfigStore(file, baseConfig).getState().ai.enabled, false);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /secret-test-key/);
});

test("un numero no puede estar permitido y bloqueado", () => {
  assert.throws(
    () =>
      normalizeAutomation({
        mode: "TESTING",
        allowedPhones: ["14378781645"],
        blockedPhones: ["+1 (437) 878-1645"],
      }),
    /permitido y bloqueado/,
  );
});

test("repara emojis y nombres de dias dañados por codificacion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lacenaduria-"));
  const file = path.join(directory, "admin.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      catalog: [
        {
          id: "chocolate",
          name: "Conchitas Chocolate",
          sheetName: "Concha de chocolate",
          emoji: "??",
          price: 3.5,
          active: true,
        },
      ],
      schedules: [
        {
          id: "wednesday",
          name: "Mi�rcoles",
          weekday: 3,
          active: true,
          pickupEnabled: true,
          pickupWindow: "5:00 p.m.",
          deliveryEnabled: true,
          deliveryWindow: "despu�s de las 3:00 p.m.",
        },
      ],
      closures: [],
      notifications: [],
    }),
  );

  const store = new AdminConfigStore(file, baseConfig);

  assert.equal(store.getState().catalog[0].emoji, "🍫");
  assert.equal(store.getState().schedules[0].name, "Miércoles");
  assert.equal(
    store.getState().schedules[0].deliveryWindow,
    "después de las 3:00 PM",
  );
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.catalog[0].emoji, "🍫");
  assert.equal(persisted.schedules[0].name, "Miércoles");
  assert.equal(
    persisted.schedules[0].deliveryWindow,
    "después de las 3:00 PM",
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
