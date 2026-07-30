"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  affectedOrders,
  canNotifyOrder,
} = require("../src/admin-server");

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
      id: "cierre-2026-07-29",
      date: "2026-07-29",
      services: ["DELIVERY"],
    },
  ],
  notifications: [],
};

const config = {
  automationAllowedChatIds: new Set(),
  automationAllowedPhones: new Set(["14370000000"]),
};

test("muestra pedidos afectados y calcula su siguiente entrega", () => {
  const closure = state.closures[0];
  const affected = affectedOrders(
    [
      {
        orderId: "WA-1",
        customerName: "Ana",
        phone: "14370000000",
        chatId: "lid@lid",
        requestedDate: closure.date,
        fulfillmentType: "DELIVERY",
        kitchenStatus: "Confirmado",
        status: "CONFIRMADO",
      },
      {
        orderId: "WA-2",
        requestedDate: closure.date,
        fulfillmentType: "DELIVERY",
        kitchenStatus: "Cancelado",
        status: "CANCELADO",
      },
    ],
    closure,
    state,
    config,
  );

  assert.equal(affected.length, 1);
  assert.equal(affected[0].canNotify, true);
  assert.equal(affected[0].next.date, "2026-08-01");
});

test("bloquea notificaciones fuera de la lista de pruebas", () => {
  assert.equal(
    canNotifyOrder(
      {
        phone: "19050000000",
        chatId: "otro@lid",
      },
      config,
    ),
    false,
  );
});

test("en modo normal permite todos excepto la lista negra", () => {
  const normalConfig = {
    automationMode: "NORMAL",
    automationAllowedChatIds: new Set(),
    automationAllowedPhones: new Set(),
    automationBlockedPhones: new Set(["19050000000"]),
  };

  assert.equal(
    canNotifyOrder(
      { phone: "14370000000", chatId: "cliente@lid" },
      normalConfig,
    ),
    true,
  );
  assert.equal(
    canNotifyOrder(
      { phone: "19050000000", chatId: "bloqueado@lid" },
      normalConfig,
    ),
    false,
  );
});
