"use strict";

const {
  newSession,
  parseDeliveryAddress,
  scheduleOptions,
} = require("./conversation-flow");

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function foodItems(order) {
  return order.items.filter((item) => !item.isLogistics);
}

function cartProductLines(session, includePrices = false) {
  return foodItems(session.cartOrder).map((item) => {
    const price = includePrices ? ` x ${money(item.unitPrice)}` : "";
    return `• ${item.quantity} ${item.productName}${price}`;
  });
}

function fulfillmentPrompt() {
  return [
    "🚗 ¿Cómo prefieres recibir tu pedido?",
    "1 - Pickup GRATIS (lo recoges tú)",
    "2 - Delivery a domicilio",
    "",
    "Responde con 1 o 2.",
  ].join("\n");
}

function cityPrompt(config) {
  return [
    "🚗 ¿En qué ciudad necesitas delivery?",
    `1 - Brampton (${money(config.deliveryFees.brampton)})`,
    `2 - Mississauga (${money(config.deliveryFees.mississauga)})`,
  ].join("\n");
}

function addressPrompt() {
  return [
    "📍 Comparte la dirección de entrega.",
    "Puedes escribirla, pegar una liga de Google Maps o compartir tu ubicación.",
  ].join("\n");
}

function schedulePrompt(options, serviceType) {
  if (!options.length) {
    return "Por el momento no tenemos fechas disponibles para esta modalidad.";
  }
  return [
    "📅 ¿Para qué día quieres tu pedido?",
    ...options.map(
      (schedule, index) =>
        `${index + 1} - ${schedule.name} (${
          serviceType === "PICKUP"
            ? schedule.pickupWindow
            : schedule.deliveryWindow
        })`,
    ),
  ].join("\n");
}

function cartFinalSummary(session) {
  const subtotal = Number(session.cartOrder.summary.total || 0);
  const fee = Number(session.fulfillment.deliveryFee || 0);
  const type =
    session.fulfillment.type === "PICKUP"
      ? "Pickup GRATIS"
      : `Delivery en ${
          session.fulfillment.city === "BRAMPTON"
            ? "Brampton"
            : "Mississauga"
        }`;
  return [
    "📋 RESUMEN FINAL DE TU PEDIDO:",
    "━━━━━━━━━━",
    ...cartProductLines(session),
    "━━━━━━━━━━",
    `📅 Fecha: ${session.schedule.name} ${session.schedule.timeWindow}`,
    `🏪 Tipo: ${type}`,
    ...(session.fulfillment.type === "DELIVERY"
      ? [`📍 Dirección: ${session.deliveryAddress}`]
      : []),
    `💵 Subtotal: ${money(subtotal)}`,
    `🚗 Delivery: ${money(fee)}`,
    `💰 TOTAL: ${money(subtotal + fee)}`,
    "━━━━━━━━━━",
  ].join("\n");
}

function cartConfirmationPrompt(session) {
  return [
    cartFinalSummary(session),
    "",
    "¿Confirmas tu pedido?",
    "✅ Escribe SI para confirmar",
    "❌ Escribe NO para cancelar",
  ].join("\n");
}

function cartUpdateConfirmationPrompt(session) {
  return [
    cartFinalSummary(session),
    "",
    "¿Quieres guardar estos cambios?",
    "✅ Escribe SI para actualizar",
    "❌ Escribe NO para conservar el pedido anterior",
  ].join("\n");
}

function cartReceivedMessage(session, config) {
  return [
    "✅ Recibimos tu carrito.",
    "",
    "Tu pedido:",
    ...cartProductLines(session, true),
    "",
    `💵 Subtotal: ${money(session.cartOrder.summary.total)}`,
    "",
    fulfillmentPrompt(),
  ].join("\n");
}

function cartConfirmedMessage(session) {
  return [
    "🎉 ¡Tu pedido fue confirmado!",
    "",
    cartFinalSummary(session),
    "",
    "Para consultar tu pedido escribe HOLA.",
  ].join("\n");
}

function cartCompletedReminder(session) {
  return [
    "Este es tu pedido confirmado:",
    "",
    cartFinalSummary(session),
    "",
    "¿Qué deseas hacer?",
    "1 - Actualizar fecha o modalidad",
    "2 - Crear un pedido nuevo",
    "",
    "También puedes escribir ACTUALIZAR PEDIDO o NUEVO PEDIDO.",
  ].join("\n");
}

function cartUpdateMenu(session) {
  return [
    cartFinalSummary(session),
    "",
    "¿Qué deseas actualizar?",
    "1 - Cambiar fecha",
    "2 - Cambiar Pickup / Delivery",
    "3 - Cancelar pedido",
    "4 - No hacer cambios",
  ].join("\n");
}

function cleanNormalizedCart(normalized) {
  const items = foodItems(normalized);
  if (!items.length) {
    throw new Error("El carrito no contiene productos para cocina.");
  }
  const summary = {
    ...normalized.summary,
    fulfillmentType: "",
    city: "",
    address: "",
    postalCode: "",
    requestedDate: "",
    timeWindow: "",
    deliveryFee: 0,
    grandTotal: Number(normalized.summary.total || 0),
    scheduleStatus: "PENDIENTE",
    fulfillmentConflict: false,
    kitchenStatus: "Confirmado",
  };
  return { summary, items };
}

function createCartSession(normalized) {
  const cartOrder = cleanNormalizedCart(normalized);
  return {
    source: "CART",
    orderId: cartOrder.summary.orderId,
    chatId: cartOrder.summary.chatId,
    customerName: cartOrder.summary.customerName,
    customerPhone: cartOrder.summary.phone,
    step: "CART_FULFILLMENT",
    cartOrder,
    fulfillment: null,
    deliveryAddress: "",
    addressType: "",
    schedule: null,
    scheduleOptions: [],
    updateMode: false,
    createdAt: cartOrder.summary.receivedAt,
  };
}

function finalizedCartOrder(session) {
  const deliveryFee = Number(session.fulfillment.deliveryFee || 0);
  const total = Number(session.cartOrder.summary.total || 0);
  return {
    summary: {
      ...session.cartOrder.summary,
      fulfillmentType: session.fulfillment.type,
      city: session.fulfillment.city || "",
      address:
        session.fulfillment.type === "DELIVERY"
          ? session.deliveryAddress
          : "",
      requestedDate: session.schedule.date,
      timeWindow: session.schedule.timeWindow,
      deliveryFee,
      grandTotal: total + deliveryFee,
      status: "CONFIRMADO",
      scheduleStatus: "CONFIRMADO",
      fulfillmentConflict: false,
      kitchenStatus: "Confirmado",
      updatedAt: new Date().toISOString(),
    },
    items: foodItems(session.cartOrder),
  };
}

function updateBackup(session) {
  return {
    fulfillment: { ...session.fulfillment },
    deliveryAddress: session.deliveryAddress,
    addressType: session.addressType,
    schedule: { ...session.schedule },
    cartOrder: JSON.parse(JSON.stringify(session.cartOrder)),
  };
}

function restoreUpdate(session) {
  const backup = session.updateBackup;
  const restored = {
    ...session,
    step: "CART_COMPLETED",
    fulfillment: backup.fulfillment,
    deliveryAddress: backup.deliveryAddress,
    addressType: backup.addressType,
    schedule: backup.schedule,
    cartOrder: backup.cartOrder,
    updateMode: false,
  };
  delete restored.updateBackup;
  return restored;
}

function finishCart(session, step = "CART_COMPLETED") {
  const cartOrder = finalizedCartOrder(session);
  const finished = {
    ...session,
    step,
    cartOrder,
    updateMode: false,
  };
  delete finished.updateBackup;
  return finished;
}

function scheduleSelection(session, answer) {
  const index = Number(answer) - 1;
  if (!Number.isInteger(index)) return null;
  return session.scheduleOptions[index] || null;
}

function advanceCartConversation(session, input, config, now = new Date()) {
  const answer = normalizeAnswer(input);

  if (session.step === "CART_COMPLETED") {
    if (
      answer === "2" ||
      ["NUEVO PEDIDO", "NUEVA ORDEN", "HACER PEDIDO"].includes(answer)
    ) {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        config,
        now,
      });
      return { session: next, startTextOrder: true, messages: [] };
    }
    if (
      answer === "1" ||
      /\b(ACTUALIZAR|CAMBIAR|MODIFICAR)\b/.test(answer)
    ) {
      const next = {
        ...session,
        step: "CART_UPDATE_MENU",
        updateBackup: updateBackup(session),
      };
      return { session: next, messages: [cartUpdateMenu(next)] };
    }
    if (/\b(CANCELAR|CANCELACION)\b/.test(answer)) {
      return {
        session: {
          ...session,
          step: "CART_CANCEL_CONFIRMATION",
          updateBackup: updateBackup(session),
        },
        messages: [
          "⚠️ ¿Seguro que deseas cancelar todo el pedido?\nEscribe SI para cancelarlo o NO para conservarlo.",
        ],
      };
    }
    if (
      ["HOLA", "MENU", "PEDIDO", "ORDEN", "BUENOS DIAS", "BUENAS TARDES"].includes(
        answer,
      )
    ) {
      return {
        session,
        messages: [cartCompletedReminder(session)],
      };
    }
    if (/\b(AGREGAR|QUITAR|ELIMINAR|PRODUCTO)\b/.test(answer)) {
      return {
        session,
        messages: [
          "Para cambiar los productos envía un carrito nuevo desde el catálogo.",
        ],
      };
    }
    return { session, messages: [] };
  }

  if (session.step === "CART_UPDATE_MENU") {
    if (answer === "1" || /\b(FECHA|DIA)\b/.test(answer)) {
      const choices = scheduleOptions(
        config,
        now,
        session.fulfillment.type,
      );
      return {
        session: {
          ...session,
          step: "CART_DAY",
          scheduleOptions: choices,
          updateMode: true,
        },
        messages: [schedulePrompt(choices, session.fulfillment.type)],
      };
    }
    if (
      answer === "2" ||
      /\b(PICKUP|DELIVERY|ENTREGA|RECOGER)\b/.test(answer)
    ) {
      return {
        session: {
          ...session,
          step: "CART_FULFILLMENT",
          updateMode: true,
        },
        messages: [fulfillmentPrompt()],
      };
    }
    if (answer === "3" || /\b(CANCELAR|CANCELACION)\b/.test(answer)) {
      return {
        session: { ...session, step: "CART_CANCEL_CONFIRMATION" },
        messages: [
          "⚠️ ¿Seguro que deseas cancelar todo el pedido?\nEscribe SI para cancelarlo o NO para conservarlo.",
        ],
      };
    }
    if (answer === "4" || answer === "NO") {
      const restored = restoreUpdate(session);
      return {
        session: restored,
        messages: ["Conservamos tu pedido sin cambios."],
      };
    }
    return { session, messages: [cartUpdateMenu(session)] };
  }

  if (session.step === "CART_FULFILLMENT") {
    if (answer === "1") {
      const choices = scheduleOptions(config, now, "PICKUP");
      const next = {
        ...session,
        step: "CART_DAY",
        fulfillment: { type: "PICKUP", city: "", deliveryFee: 0 },
        deliveryAddress: "",
        addressType: "",
        scheduleOptions: choices,
      };
      return {
        session: next,
        messages: [schedulePrompt(choices, "PICKUP")],
      };
    }
    if (answer === "2") {
      return {
        session: { ...session, step: "CART_CITY" },
        messages: [cityPrompt(config)],
      };
    }
    return { session, messages: [fulfillmentPrompt()] };
  }

  if (session.step === "CART_CITY") {
    const city =
      answer === "1"
        ? "BRAMPTON"
        : answer === "2"
          ? "MISSISSAUGA"
          : "";
    if (!city) {
      return { session, messages: [cityPrompt(config)] };
    }
    const deliveryFee =
      city === "BRAMPTON"
        ? config.deliveryFees.brampton
        : config.deliveryFees.mississauga;
    return {
      session: {
        ...session,
        step: "CART_ADDRESS",
        fulfillment: { type: "DELIVERY", city, deliveryFee },
      },
      messages: [addressPrompt()],
    };
  }

  if (session.step === "CART_ADDRESS") {
    const address = parseDeliveryAddress(input);
    if (!address) {
      return {
        session,
        messages: [
          "Escribe una dirección completa, pega una liga de Google Maps o comparte tu ubicación.",
        ],
      };
    }
    const choices = scheduleOptions(config, now, "DELIVERY");
    return {
      session: {
        ...session,
        step: "CART_DAY",
        deliveryAddress: address.value,
        addressType: address.type,
        scheduleOptions: choices,
      },
      messages: [schedulePrompt(choices, "DELIVERY")],
    };
  }

  if (session.step === "CART_DAY") {
    const schedule = scheduleSelection(session, answer);
    if (!schedule) {
      return {
        session,
        messages: [
          schedulePrompt(
            session.scheduleOptions,
            session.fulfillment.type,
          ),
        ],
      };
    }
    const timeWindow =
      session.fulfillment.type === "PICKUP"
        ? schedule.pickupWindow
        : schedule.deliveryWindow;
    const next = {
      ...session,
      step: session.updateMode
        ? "CART_UPDATE_CONFIRMATION"
        : "CART_CONFIRMATION",
      schedule: { ...schedule, timeWindow },
    };
    return {
      session: next,
      messages: [
        session.updateMode
          ? cartUpdateConfirmationPrompt(next)
          : cartConfirmationPrompt(next),
      ],
    };
  }

  if (session.step === "CART_CONFIRMATION") {
    if (answer === "SI") {
      return {
        session: finishCart(session),
        messages: [],
        completed: true,
      };
    }
    if (answer === "NO") {
      return {
        session: null,
        messages: [
          "Pedido cancelado. No se agregó a producción.",
        ],
        canceled: true,
      };
    }
    return {
      session,
      messages: ["Responde SI para confirmar o NO para cancelar."],
    };
  }

  if (session.step === "CART_UPDATE_CONFIRMATION") {
    if (answer === "SI") {
      return {
        session: finishCart(session),
        messages: [],
        updated: true,
      };
    }
    if (answer === "NO") {
      return {
        session: restoreUpdate(session),
        messages: ["Conservamos tu pedido anterior sin cambios."],
      };
    }
    return {
      session,
      messages: ["Responde SI para actualizar o NO para conservarlo."],
    };
  }

  if (session.step === "CART_CANCEL_CONFIRMATION") {
    if (answer === "SI" || answer === "SI CANCELAR") {
      return {
        session: { ...session, step: "CART_CANCELED" },
        messages: [],
        orderCanceled: true,
      };
    }
    if (answer === "NO") {
      return {
        session: restoreUpdate(session),
        messages: ["Tu pedido sigue confirmado."],
      };
    }
    return {
      session,
      messages: ["Responde SI para cancelar o NO para conservarlo."],
    };
  }

  if (session.step === "CART_CANCELED") {
    if (
      ["NUEVO PEDIDO", "NUEVA ORDEN", "HACER PEDIDO", "HOLA"].includes(
        answer,
      )
    ) {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        config,
        now,
      });
      return { session: next, startTextOrder: true, messages: [] };
    }
    return {
      session,
      messages: [
        "Este pedido está cancelado. Escribe NUEVO PEDIDO para iniciar otro.",
      ],
    };
  }

  return { session, messages: [] };
}

module.exports = {
  advanceCartConversation,
  cartCompletedReminder,
  cartConfirmedMessage,
  cartFinalSummary,
  cartReceivedMessage,
  cleanNormalizedCart,
  createCartSession,
  finalizedCartOrder,
};
