"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AdminConfigStore } = require("../src/admin-config");
const {
  planReadyAllocation,
} = require("../src/ready-inventory");

const baseConfig = {
  menuPrices: { chocolate: 3.5, vanilla: 3.5, bolillo: 2.5 },
  deliveryFees: { brampton: 5, mississauga: 8 },
  pickupTimeWindow: "5:00 p.m. a 6:00 p.m.",
  deliveryWindows: {
    wednesday: "después de las 3:00 PM",
    saturday: "después de las 10:00 AM",
  },
};

test("la asignación es completa o no descuenta nada y respeta la modalidad", () => {
  const now = new Date("2026-08-28T16:00:00.000Z");
  const batches = [
    {
      id: "pickup",
      productId: "chocolate",
      quantityAvailable: 3,
      readyAt: "2026-08-28T14:00:00.000Z",
      expiresAt: "2026-08-28T20:00:00.000Z",
      pickupEnabled: true,
      deliveryEnabled: false,
    },
    {
      id: "delivery",
      productId: "chocolate",
      quantityAvailable: 5,
      readyAt: "2026-08-28T14:00:00.000Z",
      expiresAt: "2026-08-28T22:00:00.000Z",
      pickupEnabled: false,
      deliveryEnabled: true,
    },
  ];

  const pickup = planReadyAllocation(
    batches,
    [{ product_id: "chocolate", cantidad: 4 }],
    { now, modality: "PICKUP" },
  );
  assert.equal(pickup.ok, false);
  assert.deepEqual(pickup.allocations, []);
  assert.equal(pickup.shortages[0].available, 3);

  const delivery = planReadyAllocation(
    batches,
    [{ product_id: "chocolate", cantidad: 4 }],
    { now, modality: "DELIVERY" },
  );
  assert.equal(delivery.ok, true);
  assert.deepEqual(delivery.allocations.map((item) => item.batchId), [
    "delivery",
  ]);
});

test("reserva de forma atómica, persiste y revierte solamente si falla el guardado", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ready-bread-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "admin.json");
  const store = new AdminConfigStore(file, baseConfig);
  const now = new Date("2026-08-28T16:00:00.000Z");
  const batch = store.addReadyInventory(
    {
      productId: "chocolate",
      quantityAvailable: 7,
      expiresAt: "2026-08-28T23:00:00.000Z",
      pickupEnabled: true,
      deliveryEnabled: true,
      note: "Lote de prueba",
    },
    now,
  );

  const first = store.reserveReadyInventory(
    [{ product_id: "chocolate", cantidad: 5 }],
    "ORDER-1",
    { now, modality: "PICKUP" },
  );
  assert.equal(first.ok, true);
  assert.equal(store.getState().readyInventory[0].quantityAvailable, 2);

  const second = store.reserveReadyInventory(
    [{ product_id: "chocolate", cantidad: 3 }],
    "ORDER-2",
    { now, modality: "PICKUP" },
  );
  assert.equal(second.ok, false);
  assert.equal(store.getState().readyInventory[0].quantityAvailable, 2);

  const reloaded = new AdminConfigStore(file, baseConfig);
  assert.equal(reloaded.getState().readyInventory[0].id, batch.id);
  assert.equal(reloaded.getState().readyInventory[0].quantityAvailable, 2);
  assert.equal(reloaded.rollbackReadyInventory("ORDER-1", now), true);
  assert.equal(reloaded.getState().readyInventory[0].quantityAvailable, 7);
  assert.equal(reloaded.rollbackReadyInventory("ORDER-1", now), false);
});

test("los lotes vencidos nunca se asignan", () => {
  const plan = planReadyAllocation(
    [
      {
        id: "expired",
        productId: "vanilla",
        quantityAvailable: 20,
        readyAt: "2026-08-27T14:00:00.000Z",
        expiresAt: "2026-08-28T15:59:59.000Z",
        pickupEnabled: true,
        deliveryEnabled: true,
      },
    ],
    [{ product_id: "vanilla", cantidad: 5 }],
    {
      now: new Date("2026-08-28T16:00:00.000Z"),
      modality: "PICKUP",
    },
  );
  assert.equal(plan.ok, false);
  assert.equal(plan.shortages[0].available, 0);
});
