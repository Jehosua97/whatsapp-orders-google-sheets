"use strict";

const path = require("node:path");
const express = require("express");
const {
  addDays,
  isServiceClosed,
  nextAvailableSchedule,
  scheduleForDate,
  serviceEnabled,
  serviceWindow,
  validIsoDate,
} = require("./admin-config");
const { kitchenStatus } = require("./google-sheets");

function torontoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function isActiveOrder(order) {
  return (
    String(order.status || "").toUpperCase() !== "CANCELADO" &&
    kitchenStatus(order) === "Confirmado"
  );
}

function orderService(order) {
  return order.fulfillmentType === "PICKUP" ? "PICKUP" : "DELIVERY";
}

function canNotifyOrder(order, config) {
  const chatId = String(order.chatId || "");
  const phone = String(order.phone || "").replace(/\D/g, "");
  if (!chatId) return false;
  if (config.automationBlockedPhones?.has(phone)) return false;
  if (config.automationMode === "NORMAL") return true;
  return Boolean(
    config.automationAllowedChatIds?.has(chatId) ||
      config.automationAllowedPhones?.has(phone),
  );
}

function affectedOrders(orders, closure, state, config) {
  const notifications = new Map(
    state.notifications.map((item) => [
      `${item.orderId}:${item.fromDate}`,
      item,
    ]),
  );
  return orders
    .filter(
      (order) =>
        isActiveOrder(order) &&
        order.requestedDate === closure.date &&
        closure.services.includes(orderService(order)),
    )
    .map((order) => {
      const serviceType = orderService(order);
      const next = nextAvailableSchedule(
        state,
        closure.date,
        serviceType,
      );
      return {
        orderId: String(order.orderId),
        customerName: String(order.customerName || "Cliente"),
        productSummary: String(order.productSummary || ""),
        serviceType,
        city: String(order.city || ""),
        fromDate: closure.date,
        fromTimeWindow: String(order.timeWindow || ""),
        next,
        canNotify: canNotifyOrder(order, config),
        notification:
          notifications.get(`${order.orderId}:${closure.date}`) || null,
      };
    });
}

function upcomingDates(state, orders, days = 35) {
  const today = torontoToday();
  const result = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDays(today, offset);
    const schedule = scheduleForDate(state, date);
    if (!schedule) continue;
    const pickupAvailable =
      serviceEnabled(schedule, "PICKUP") &&
      !isServiceClosed(state, date, "PICKUP");
    const deliveryAvailable =
      serviceEnabled(schedule, "DELIVERY") &&
      !isServiceClosed(state, date, "DELIVERY");
    result.push({
      id: `${schedule.id}:${date}`,
      scheduleId: schedule.id,
      name: schedule.name,
      date,
      dateLabel: formatDate(date),
      pickupAvailable,
      pickupWindow: serviceWindow(schedule, "PICKUP"),
      deliveryAvailable,
      deliveryWindow: serviceWindow(schedule, "DELIVERY"),
      confirmedOrders: orders.filter(
        (order) =>
          isActiveOrder(order) && order.requestedDate === date,
      ).length,
    });
  }
  return result;
}

function basicAuthMiddleware(password) {
  return (request, response, next) => {
    if (!password) return next();
    const supplied = request.get("x-admin-password") || "";
    if (supplied === password) return next();
    return response.status(401).json({
      error: "Se requiere la contraseña del panel.",
    });
  };
}

function createAdminServer({
  config,
  configStore,
  conversationState,
  store,
  whatsapp,
  logger = console,
}) {
  const app = express();
  const publicDirectory = path.resolve(__dirname, "..", "public");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      whatsapp: whatsapp.lacenaduriaStatus || "CONNECTING",
      uptimeSeconds: Math.floor(process.uptime()),
      conversations: conversationState.healthSummary(),
    });
  });
  app.use("/api", basicAuthMiddleware(config.adminPassword));
  app.get("/vendor/lucide.js", (_request, response) => {
    response.sendFile(
      path.resolve(
        __dirname,
        "..",
        "node_modules",
        "lucide",
        "dist",
        "umd",
        "lucide.js",
      ),
    );
  });
  app.use(express.static(publicDirectory));

  app.get("/api/dashboard", async (_request, response, next) => {
    try {
      const state = configStore.getState();
      const runtimeConfig = configStore.runtimeConfig();
      const orders = await store.listOrders();
      const closures = state.closures.map((closure) => ({
        ...closure,
        dateLabel: formatDate(closure.date),
        affectedCount: affectedOrders(
          orders,
          closure,
          state,
          runtimeConfig,
        ).length,
      }));
      response.json({
        catalog: state.catalog,
        schedules: state.schedules,
        closures,
        notifications: state.notifications.slice(-50).reverse(),
        automation: state.automation,
        upcomingDates: upcomingDates(state, orders),
        testMode: state.automation.mode === "TESTING",
        whatsappStatus: whatsapp.lacenaduriaStatus || "CONNECTING",
        today: torontoToday(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/catalog", (request, response, next) => {
    try {
      const state = configStore.updateCatalog(request.body.catalog);
      response.json({ catalog: state.catalog });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/schedules", (request, response, next) => {
    try {
      const state = configStore.updateSchedules(request.body.schedules);
      response.json({ schedules: state.schedules });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/automation", (request, response, next) => {
    try {
      const state = configStore.updateAutomation(request.body.automation);
      response.json({ automation: state.automation });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/closures", async (request, response, next) => {
    try {
      const closure = configStore.upsertClosure(request.body);
      const state = configStore.getState();
      const runtimeConfig = configStore.runtimeConfig();
      const orders = await store.listOrders();
      response.status(201).json({
        closure,
        affected: affectedOrders(
          orders,
          closure,
          state,
          runtimeConfig,
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/closures/:closureId", (request, response, next) => {
    try {
      configStore.removeClosure(request.params.closureId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/closures/:closureId/affected",
    async (request, response, next) => {
      try {
        const state = configStore.getState();
        const runtimeConfig = configStore.runtimeConfig();
        const closure = state.closures.find(
          (item) => item.id === request.params.closureId,
        );
        if (!closure) {
          return response.status(404).json({
            error: "No se encontró el cierre.",
          });
        }
        const orders = await store.listOrders();
        return response.json({
          closure,
          affected: affectedOrders(
            orders,
            closure,
            state,
            runtimeConfig,
          ),
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  app.post(
    "/api/closures/:closureId/orders/:orderId/notify",
    async (request, response, next) => {
      try {
        const state = configStore.getState();
        const runtimeConfig = configStore.runtimeConfig();
        const closure = state.closures.find(
          (item) => item.id === request.params.closureId,
        );
        if (!closure) {
          return response.status(404).json({
            error: "No se encontró el cierre.",
          });
        }
        const order = await store.getOrder(request.params.orderId);
        if (
          !order ||
          !isActiveOrder(order) ||
          order.requestedDate !== closure.date ||
          !closure.services.includes(orderService(order))
        ) {
          return response.status(409).json({
            error: "El pedido ya no está afectado por este cierre.",
          });
        }
        if (!canNotifyOrder(order, runtimeConfig)) {
          return response.status(403).json({
            error:
              "La política de automatización no permite enviar mensajes a este cliente.",
          });
        }
        const serviceType = orderService(order);
        const nextSchedule = nextAvailableSchedule(
          state,
          closure.date,
          serviceType,
        );
        if (!nextSchedule) {
          return response.status(409).json({
            error: "No existe otra fecha disponible para reprogramar.",
          });
        }

        const serviceLabel =
          serviceType === "PICKUP" ? "recogida" : "entrega";
        const message = [
          `Hola ${order.customerName || ""}.`,
          "",
          `Por un cambio de disponibilidad no podremos realizar tu ${serviceLabel} del ${formatDate(closure.date)}.`,
          `Tu pedido será reprogramado para el ${formatDate(nextSchedule.date)}, ${nextSchedule.timeWindow}.`,
          "",
          "Si necesitas otra opción, responde a este mensaje y con gusto te ayudamos.",
          "",
          "La Cenaduría Brampton",
        ].join("\n");

        await whatsapp.sendMessage(order.chatId, message);
        const note = `Reprogramado de ${closure.date} a ${nextSchedule.date}; notificación enviada por WhatsApp`;
        await store.updateOrder(order.orderId, {
          requestedDate: nextSchedule.date,
          timeWindow: nextSchedule.timeWindow,
          scheduleStatus: "REPROGRAMADO",
          customerNotes: [order.customerNotes, note]
            .filter(Boolean)
            .join(" | "),
        });
        conversationState.updateByOrderId(order.orderId, (session) => ({
          ...session,
          schedule: {
            ...session.schedule,
            id: nextSchedule.id,
            name: nextSchedule.name,
            date: nextSchedule.date,
            timeWindow: nextSchedule.timeWindow,
          },
        }));
        configStore.recordNotification({
          orderId: String(order.orderId),
          customerName: String(order.customerName || "Cliente"),
          fromDate: closure.date,
          toDate: nextSchedule.date,
          serviceType,
        });
        logger.log(
          `Pedido reprogramado y notificado: ${order.orderId} -> ${nextSchedule.date}`,
        );
        return response.json({
          orderId: order.orderId,
          nextSchedule,
          sent: true,
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  app.use((error, _request, response, _next) => {
    logger.error("Error en el panel administrativo:", error);
    response.status(400).json({
      error: error.message || "No se pudo completar la operación.",
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const server = app
          .listen(config.adminPort, config.adminHost, () => resolve(server))
          .once("error", reject);
      });
    },
  };
}

module.exports = {
  affectedOrders,
  canNotifyOrder,
  createAdminServer,
  formatDate,
  isActiveOrder,
  torontoToday,
  upcomingDates,
};
