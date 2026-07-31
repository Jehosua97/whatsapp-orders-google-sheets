"use strict";

const {
  catalogProducts,
  newSession,
  parseDeliveryAddress,
  scheduleOptions,
} = require("./conversation-flow");
const { DEFAULT_PICKUP_ADDRESS } = require("./business-details");
const {
  correctProductId,
  correctProductName,
} = require("./product-naming");

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
    return "Ya anotamos todos tus productos. Estamos revisando la próxima fecha de preparación y te contactaremos para confirmarla.";
  }
  const lines = ["📅 ¿Para qué día quieres tu pedido?"];
  options.slice(0, 2).forEach((schedule, index) => {
    lines.push(
      `${index + 1} - ${schedule.name} (${
        serviceType === "PICKUP"
          ? schedule.pickupWindow
          : schedule.deliveryWindow
      })`,
    );
  });
  return lines.join("\n");
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
    "━━━━━━━━",
    ...cartProductLines(session),
    "━━━━━━━━",
    `📅 Fecha: ${session.schedule.name} ${session.schedule.timeWindow}`,
    `🏪 Tipo: ${type}`,
    ...(session.fulfillment.type === "DELIVERY"
      ? [`📍 Dirección: ${session.deliveryAddress}`]
      : [
          `📍 Dirección de pickup: ${
            session.pickupAddress || DEFAULT_PICKUP_ADDRESS
          }`,
        ]),
    `💵 Subtotal: ${money(subtotal)}`,
    `🚗 Delivery: ${money(fee)}`,
    `💰 TOTAL: ${money(subtotal + fee)}`,
    "━━━━━━━━",
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
    "1 - Actualizar pedido",
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
    "1 - Agregar productos",
    "2 - Quitar productos",
    "3 - Cambiar fecha",
    "4 - Cambiar Pickup / Delivery",
    "5 - Cancelar pedido",
    "6 - No hacer cambios",
  ].join("\n");
}

function canonicalProductName(value) {
  const ignoredWords = new Set(["de", "del", "la", "las", "el", "los"]);
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bconchitas?\b/g, "concha")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !ignoredWords.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s")
        ? word.slice(0, -1)
        : word,
    )
    .join(" ");
}

function productMatchesItem(product, item) {
  const productIds = [product.id, product.productId]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  if (productIds.includes(String(item.productId || "").toLowerCase())) {
    return true;
  }
  const itemName = canonicalProductName(item.productName);
  return [
    product.name,
    product.displayName,
    product.promptName,
    product.sheetName,
  ]
    .filter(Boolean)
    .some((name) => canonicalProductName(name) === itemName);
}

function cartAvailabilityProductKeys(session, config) {
  const items = foodItems(session.cartOrder).filter(
    (item) => Number(item.quantity || 0) > 0,
  );
  return catalogProducts(config)
    .filter((product) =>
      items.some((item) => productMatchesItem(product, item)),
    )
    .map((product) => product.id);
}

function totalCartPieces(session) {
  return foodItems(session.cartOrder).reduce(
    (total, item) => total + Number(item.quantity || 0),
    0,
  );
}

function cartProductChoices(session, action, config) {
  const items = foodItems(session.cartOrder);
  if (action === "REMOVE") {
    return items
      .map((item, itemIndex) => ({
        itemIndex,
        productId: item.productId,
        productName: item.productName,
        promptName: item.productName,
        currentQuantity: Number(item.quantity || 0),
        unitPrice: Number(item.unitPrice || 0),
      }))
      .filter((choice) => choice.currentQuantity > 0);
  }

  return catalogProducts(config)
    .filter((product) => product.active !== false)
    .map((product) => {
      const itemIndex = items.findIndex((item) =>
        productMatchesItem(product, item),
      );
      const existing = itemIndex >= 0 ? items[itemIndex] : null;
      return {
        itemIndex,
        productId:
          existing?.productId || product.productId || product.id,
        productName:
          existing?.productName ||
          product.sheetName ||
          product.name ||
          product.id,
        promptName:
          product.promptName || product.name || product.id,
        currentQuantity: Number(existing?.quantity || 0),
        unitPrice: Number(
          existing?.unitPrice ?? product.price ?? 0,
        ),
      };
    });
}

function cartProductUpdateMenu(session, action, choices) {
  const verb = action === "ADD" ? "agregar" : "quitar";
  if (!choices.length) {
    return `No hay productos disponibles para ${verb}.`;
  }
  return [
    `¿Qué producto deseas ${verb}?`,
    ...choices.map(
      (choice, index) =>
        `${index + 1} - ${choice.promptName} (actual: ${choice.currentQuantity})`,
    ),
  ].join("\n");
}

function beginCartProductUpdate(session, action, config) {
  const choices = cartProductChoices(session, action, config);
  const next = {
    ...session,
    step: "CART_UPDATE_PRODUCT",
    updateAction: action,
    updateProductChoices: choices,
    updateBackup: session.updateBackup || updateBackup(session),
  };
  return {
    session: next,
    messages: [cartProductUpdateMenu(next, action, choices)],
  };
}

function recalculateCartOrder(session, items) {
  const activeItems = items
    .filter((item) => Number(item.quantity || 0) > 0)
    .map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      lineTotal:
        Number(item.quantity) * Number(item.unitPrice || 0),
    }));
  const productsTotal = activeItems.reduce(
    (total, item) => total + Number(item.lineTotal || 0),
    0,
  );
  const deliveryFee = Number(session.fulfillment?.deliveryFee || 0);
  return {
    summary: {
      ...session.cartOrder.summary,
      subtotal: productsTotal,
      total: productsTotal,
      grandTotal: productsTotal + deliveryFee,
      productSummary: activeItems
        .map((item) => `${item.quantity} x ${item.productName}`)
        .join(", "),
      updatedAt: new Date().toISOString(),
    },
    items: activeItems,
  };
}

function cleanNormalizedCart(normalized) {
  const items = foodItems(normalized).map((item) => ({
    ...item,
    productId: correctProductId(item.productId),
    productName: correctProductName(item.productName),
  }));
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
    productSummary: items
      .map((item) => `${item.quantity} x ${item.productName}`)
      .join(", "),
  };
  return { summary, items };
}

function createCartSession(normalized, config = {}) {
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
    pickupAddress:
      config.pickupAddress || DEFAULT_PICKUP_ADDRESS,
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
          : session.pickupAddress || DEFAULT_PICKUP_ADDRESS,
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
  delete restored.updateAction;
  delete restored.updateProductChoices;
  delete restored.updateProductChoice;
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
  delete finished.updateAction;
  delete finished.updateProductChoices;
  delete finished.updateProductChoice;
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
    if (/\b(AGREGAR|ANADIR)\b/.test(answer)) {
      return beginCartProductUpdate(session, "ADD", config);
    }
    if (/\b(QUITAR|ELIMINAR)\b/.test(answer)) {
      return beginCartProductUpdate(session, "REMOVE", config);
    }
    if (answer === "1" || /\b(ACTUALIZAR|CAMBIAR|MODIFICAR)\b/.test(answer)) {
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
    return {
      session,
      messages: [cartCompletedReminder(session)],
    };
  }

  if (
    String(session.step).startsWith("CART_UPDATE") &&
    session.step !== "CART_CANCEL_CONFIRMATION" &&
    /\b(CANCELAR|CANCELACION)\b/.test(answer)
  ) {
    return {
      session: { ...session, step: "CART_CANCEL_CONFIRMATION" },
      messages: [
        "⚠️ ¿Seguro que deseas cancelar todo el pedido?\nEscribe SI para cancelarlo o NO para conservarlo.",
      ],
    };
  }

  if (session.step === "CART_UPDATE_MENU") {
    let option = answer;
    if (/\b(AGREGAR|ANADIR)\b/.test(answer)) option = "1";
    if (/\b(QUITAR|ELIMINAR)\b/.test(answer)) option = "2";
    if (/\b(FECHA|DIA)\b/.test(answer)) option = "3";
    if (/\b(PICKUP|DELIVERY|ENTREGA|RECOGER)\b/.test(answer)) {
      option = "4";
    }
    if (/\b(CANCELAR|CANCELACION)\b/.test(answer)) option = "5";

    if (option === "1" || option === "2") {
      return beginCartProductUpdate(
        session,
        option === "1" ? "ADD" : "REMOVE",
        config,
      );
    }
    if (option === "3") {
      const choices = scheduleOptions(
        config,
        now,
        session.fulfillment.type,
        cartAvailabilityProductKeys(session, config),
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
    if (option === "4") {
      return {
        session: {
          ...session,
          step: "CART_FULFILLMENT",
          updateMode: true,
        },
        messages: [fulfillmentPrompt()],
      };
    }
    if (option === "5") {
      return {
        session: { ...session, step: "CART_CANCEL_CONFIRMATION" },
        messages: [
          "⚠️ ¿Seguro que deseas cancelar todo el pedido?\nEscribe SI para cancelarlo o NO para conservarlo.",
        ],
      };
    }
    if (option === "6" || answer === "NO") {
      const restored = restoreUpdate(session);
      return {
        session: restored,
        messages: ["Conservamos tu pedido sin cambios."],
      };
    }
    return { session, messages: [cartUpdateMenu(session)] };
  }

  if (session.step === "CART_UPDATE_PRODUCT") {
    const index = Number(answer) - 1;
    const choice = Number.isInteger(index)
      ? session.updateProductChoices?.[index]
      : null;
    if (!choice) {
      return {
        session,
        messages: [
          cartProductUpdateMenu(
            session,
            session.updateAction,
            session.updateProductChoices || [],
          ),
        ],
      };
    }
    const verb =
      session.updateAction === "ADD" ? "agregar" : "quitar";
    return {
      session: {
        ...session,
        step: "CART_UPDATE_QUANTITY",
        updateProductChoice: choice,
      },
      messages: [
        `¿Cuántas ${choice.promptName} deseas ${verb}?`,
      ],
    };
  }

  if (session.step === "CART_UPDATE_QUANTITY") {
    if (!/^\d{1,3}$/.test(answer) || Number(answer) < 1) {
      return {
        session,
        messages: ["Escribe una cantidad mayor a 0 usando números."],
      };
    }
    const quantity = Number(answer);
    const choice = session.updateProductChoice;
    const currentQuantity = Number(choice.currentQuantity || 0);
    if (
      session.updateAction === "REMOVE" &&
      quantity > currentQuantity
    ) {
      return {
        session,
        messages: [
          `Tu pedido tiene ${currentQuantity} ${choice.promptName}. Escribe una cantidad menor o igual.`,
        ],
      };
    }
    const nextQuantity =
      session.updateAction === "ADD"
        ? currentQuantity + quantity
        : currentQuantity - quantity;
    const items = foodItems(session.cartOrder).map((item) => ({ ...item }));
    if (choice.itemIndex >= 0) {
      items[choice.itemIndex] = {
        ...items[choice.itemIndex],
        quantity: nextQuantity,
      };
    } else {
      items.push({
        receivedAt: session.cartOrder.summary.receivedAt,
        orderId: session.orderId,
        productId: choice.productId,
        productName: choice.productName,
        quantity: nextQuantity,
        unitPrice: choice.unitPrice,
        currency: session.cartOrder.summary.currency || "CAD",
        lineTotal: nextQuantity * choice.unitPrice,
        isLogistics: false,
      });
    }
    const cartOrder = recalculateCartOrder(session, items);
    const next = {
      ...session,
      step: "CART_DAY",
      cartOrder,
      updateMode: true,
    };
    if (totalCartPieces(next) < config.minimumOrderPieces) {
      return {
        session,
        messages: [
          `El pedido debe conservar al menos ${config.minimumOrderPieces} piezas. Puedes quitar menos o cancelar todo el pedido.`,
        ],
      };
    }
    const availabilitySession = { ...next, cartOrder };
    const compatibleDates = scheduleOptions(
      config,
      now,
      session.fulfillment?.type || "",
      cartAvailabilityProductKeys(availabilitySession, config),
    );
    return {
      session: {
        ...next,
        scheduleOptions: compatibleDates,
      },
      messages: [
        [
          "✅ Productos anotados. Estas son las próximas fechas en que estarán listos:",
          "",
          schedulePrompt(compatibleDates, session.fulfillment.type),
        ].join("\n"),
      ],
    };
  }

  if (session.step === "CART_FULFILLMENT") {
    if (answer === "1") {
      const choices = scheduleOptions(
        config,
        now,
        "PICKUP",
        cartAvailabilityProductKeys(session, config),
      );
      const next = {
        ...session,
        step: "CART_DAY",
        fulfillment: {
          type: "PICKUP",
          city: "",
          deliveryFee: 0,
          pickupAddress:
            session.pickupAddress || DEFAULT_PICKUP_ADDRESS,
        },
        deliveryAddress: "",
        addressType: "",
        scheduleOptions: choices,
      };
      return {
        session: next,
        messages: [
          [
            "✅ Pickup GRATIS seleccionado.",
            `📍 Dirección de pickup: ${
              session.pickupAddress || DEFAULT_PICKUP_ADDRESS
            }`,
            "",
            schedulePrompt(choices, "PICKUP"),
          ].join("\n"),
        ],
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
    const choices = scheduleOptions(
      config,
      now,
      "DELIVERY",
      cartAvailabilityProductKeys(session, config),
    );
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
