"use strict";

const path = require("node:path");
const express = require("express");
const { deliveryFeeFor } = require("./fulfillment");
const { formatMoney } = require("./order");

const EDITABLE_FIELDS = new Set([
  "fulfillmentType",
  "city",
  "address",
  "postalCode",
  "requestedDate",
  "timeWindow",
  "deliveryFee",
  "scheduleStatus",
  "status",
  "customerNotes",
]);

function editablePatch(body) {
  return Object.fromEntries(
    Object.entries(body || {}).filter(([key]) => EDITABLE_FIELDS.has(key)),
  );
}

function calculateTotals(order, patch, fees) {
  const fulfillmentType =
    patch.fulfillmentType ?? order.fulfillmentType ?? "";
  const city = patch.city ?? order.city ?? "";
  let deliveryFee = patch.deliveryFee;

  if (fulfillmentType === "PICKUP") deliveryFee = 0;
  if (
    fulfillmentType === "DELIVERY" &&
    (deliveryFee === "" || deliveryFee === undefined)
  ) {
    deliveryFee = deliveryFeeFor(city, fees);
  }

  const productsTotal = Number(order.total);
  const numericFee = Number(deliveryFee);
  return {
    ...patch,
    deliveryFee,
    grandTotal:
      Number.isFinite(productsTotal) && Number.isFinite(numericFee)
        ? productsTotal + numericFee
        : order.total,
  };
}

function validateConfirmation(order) {
  const missing = [];
  if (!order.fulfillmentType) missing.push("modalidad");
  if (!order.requestedDate) missing.push("fecha");
  if (!order.timeWindow) missing.push("horario");
  if (order.fulfillmentType === "DELIVERY") {
    if (!order.city) missing.push("ciudad");
    if (!order.address && !order.latitude) missing.push("direccion o ubicacion");
  }
  return missing;
}

function confirmationMessage(order, items) {
  const mode =
    order.fulfillmentType === "PICKUP"
      ? "Recogida"
      : `Entrega en ${order.city === "BRAMPTON" ? "Brampton" : "Mississauga"}`;
  const products = items
    .map((item) => `${item.quantity} x ${item.productName}`)
    .join("\n");

  return [
    `Pedido ${order.orderId} confirmado`,
    "",
    products,
    "",
    `${mode}: ${order.requestedDate}, ${order.timeWindow}`,
    `Productos: ${formatMoney(order.total, order.currency)}`,
    `Entrega: ${formatMoney(order.deliveryFee || 0, order.currency)}`,
    `Total: ${formatMoney(order.grandTotal, order.currency)}`,
  ].join("\n");
}

function createAdminServer({ config, store, whatsapp, logger = console }) {
  const app = express();
  app.use(express.json());

  app.get("/", (_request, response) => {
    response.sendFile(path.join(__dirname, "admin.html"));
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/orders", async (_request, response, next) => {
    try {
      response.json(await store.listOrders());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/orders/:orderId/items", async (request, response, next) => {
    try {
      response.json(await store.getOrderItems(request.params.orderId));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/orders/:orderId", async (request, response, next) => {
    try {
      const order = await store.getOrder(request.params.orderId);
      if (!order) {
        return response.status(404).json({ error: "Pedido no encontrado" });
      }
      const patch = calculateTotals(
        order,
        editablePatch(request.body),
        config.deliveryFees,
      );
      response.json(await store.updateOrder(order.orderId, patch));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/orders/:orderId/confirm", async (request, response, next) => {
    try {
      const current = await store.getOrder(request.params.orderId);
      if (!current) {
        return response.status(404).json({ error: "Pedido no encontrado" });
      }
      if (current.status === "CONFIRMADO") {
        return response
          .status(409)
          .json({ error: "El pedido ya esta confirmado" });
      }

      const prepared = calculateTotals(
        current,
        editablePatch(request.body),
        config.deliveryFees,
      );
      const candidate = { ...current, ...prepared };
      const missing = validateConfirmation(candidate);
      if (missing.length) {
        return response.status(400).json({
          error: `Falta completar: ${missing.join(", ")}`,
        });
      }
      if (!candidate.chatId) {
        return response.status(400).json({
          error:
            "Este pedido se creo antes de guardar el ID del chat. Confirma este primer pedido manualmente.",
        });
      }

      const items = await store.getOrderItems(candidate.orderId);
      await whatsapp.sendMessage(
        candidate.chatId,
        confirmationMessage(candidate, items),
      );
      const confirmed = await store.updateOrder(candidate.orderId, {
        ...prepared,
        status: "CONFIRMADO",
        scheduleStatus: "CONFIRMADO",
      });
      response.json(confirmed);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    logger.error("Error en el panel administrativo:", error);
    response.status(500).json({ error: error.message || "Error interno" });
  });

  const server = app.listen(config.adminPort, config.adminHost, () => {
    logger.log(
      `Panel administrativo: http://${config.adminHost}:${config.adminPort}`,
    );
  });
  return server;
}

module.exports = {
  calculateTotals,
  confirmationMessage,
  createAdminServer,
  editablePatch,
  validateConfirmation,
};
