"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeOrder } = require("./order");

const PRODUCTS = {
  chocolate: {
    emoji: "🍫",
    displayName: "Conchitas Chocolate",
    promptName: "Conchitas de Chocolate",
    sheetName: "Concha de chocolate",
    productId: "concha-chocolate",
  },
  vanilla: {
    emoji: "🍦",
    displayName: "Conchitas Vainilla",
    promptName: "Conchitas de Vainilla",
    sheetName: "Concha de Vainilla",
    productId: "concha-vainilla",
  },
  bolillo: {
    emoji: "🍞",
    displayName: "Bolillos",
    promptName: "Bolillos",
    sheetName: "Bolillo",
    productId: "bolillo",
  },
};

const PRODUCT_ORDERS = {
  "1": ["chocolate", "vanilla", "bolillo"],
  "2": ["vanilla", "chocolate", "bolillo"],
  "3": ["bolillo", "chocolate", "vanilla"],
  "4": ["chocolate", "vanilla", "bolillo"],
};

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function updateKeyword(value) {
  const answer = normalizeAnswer(value);
  return /\b(ACTUALIZAR|AGREGAR|ANADIR|QUITAR|ELIMINAR|CAMBIAR|MODIFICAR|CANCELAR|CANCELACION)\b/.test(
    answer,
  );
}

function cancelKeyword(value) {
  return /\b(CANCELAR|CANCELACION)\b/.test(normalizeAnswer(value));
}

function parseDeliveryAddress(value) {
  const original = String(value || "").trim();
  const url = original.match(/https?:\/\/[^\s]+/i)?.[0] || "";
  if (
    url &&
    /(?:google\.[^/]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(
      url,
    )
  ) {
    return { type: "MAPS_LINK", value: url };
  }
  if (
    original.length >= 8 &&
    /[A-Za-zÀ-ÿ]/.test(original) &&
    !/^\d+$/.test(original)
  ) {
    return { type: "ADDRESS", value: original };
  }
  return null;
}

function addressPrompt() {
  return [
    "📍 Comparte la dirección de entrega.",
    "Puedes escribir la dirección completa o pegar una liga de Google Maps.",
  ].join("\n");
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function customerLabel(name) {
  return String(name || "").trim() || "cliente";
}

function menuMessage(name, config) {
  return [
    `Mucho gusto, ${customerLabel(name)} 😊`,
    "",
    "📋 NUESTRO MENU:",
    "",
    `🍫 Conchita Chocolate - ${money(config.menuPrices.chocolate)} c/u`,
    `🍦 Conchita Vainilla - ${money(config.menuPrices.vanilla)} c/u`,
    `🍞 Bolillo - ${money(config.menuPrices.bolillo)} c/u`,
    "",
    `⚠️ Pedido mínimo: ${config.minimumOrderPieces} piezas`,
    "",
    "¿Qué deseas ordenar? Escribe:",
    "1️⃣ - Conchitas Chocolate",
    "2️⃣ - Conchitas Vainilla",
    "3️⃣ - Bolillos",
    "4️⃣ - Combinación (de todo)",
    "",
    "Responde con el número de tu elección:",
  ].join("\n");
}

function quantityPrompt(productKey, first, minimumPieces) {
  const product = PRODUCTS[productKey];
  if (first) {
    return [
      `${product.emoji} ${product.promptName}`,
      "",
      "¿Cuántas piezas deseas?",
      `(Recuerda: mínimo ${minimumPieces} piezas en total)`,
    ].join("\n");
  }

  return [
    `${product.emoji} ¿Cuántas ${product.promptName} deseas?`,
    "(Escribe 0 si no quieres)",
  ].join("\n");
}

function quantityAcknowledgement(productKey, quantity) {
  const product = PRODUCTS[productKey];
  return `✅ ${quantity} ${product.promptName} anotadas!`;
}

function totalPieces(quantities) {
  return Object.values(quantities || {}).reduce(
    (total, quantity) => total + Number(quantity || 0),
    0,
  );
}

function subtotal(quantities, prices) {
  return Object.entries(quantities || {}).reduce(
    (total, [productKey, quantity]) =>
      total + Number(quantity || 0) * Number(prices[productKey] || 0),
    0,
  );
}

function productLines(quantities, prices, includePrices) {
  return ["chocolate", "vanilla", "bolillo"].map((productKey) => {
    const product = PRODUCTS[productKey];
    const quantity = Number(quantities?.[productKey] || 0);
    const price = includePrices
      ? ` x ${money(prices[productKey])}`
      : "";
    return `${product.emoji} ${product.displayName}: ${quantity}${price}`;
  });
}

function orderSummary(session, config) {
  const pieces = totalPieces(session.quantities);
  const orderSubtotal = subtotal(session.quantities, config.menuPrices);
  return [
    "✅ Resumen de tu pedido:",
    ...productLines(session.quantities, config.menuPrices, true),
    "━━━━━━━━━━━━━━━━━━",
    `📦 Total piezas: ${pieces}`,
    `💵 Subtotal: ${money(orderSubtotal)}`,
    "",
    "📅 ¿Para qué día quieres tu entrega?",
    `1️⃣ - Miércoles (${config.deliveryWindows.wednesday})`,
    `2️⃣ - Sábado (${config.deliveryWindows.saturday})`,
  ].join("\n");
}

function nextWeekdayDate(now, targetWeekday) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((value) => value.type === type)?.value;
  const date = new Date(
    Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))),
  );
  const daysUntil = (targetWeekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntil);
  return date.toISOString().slice(0, 10);
}

function scheduleFromAnswer(answer, config, now) {
  if (answer === "1") {
    return {
      name: "Miércoles",
      date: nextWeekdayDate(now, 3),
      timeWindow: config.deliveryWindows.wednesday,
    };
  }
  if (answer === "2") {
    return {
      name: "Sábado",
      date: nextWeekdayDate(now, 6),
      timeWindow: config.deliveryWindows.saturday,
    };
  }
  return null;
}

function finalSummary(session, config) {
  const pieces = totalPieces(session.quantities);
  const orderSubtotal = subtotal(session.quantities, config.menuPrices);
  const deliveryFee = Number(session.fulfillment.deliveryFee || 0);
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
    "━━━━━━━━━━━━━━━━━━",
    ...productLines(session.quantities, config.menuPrices, false),
    "━━━━━━━━━━━━━━━━━━",
    `📦 Total piezas: ${pieces}`,
    `📅 Entrega: ${session.schedule.name} ${session.schedule.timeWindow}`,
    `🏪 Tipo: ${type}`,
    ...(session.fulfillment.type === "DELIVERY"
      ? [`📍 Dirección: ${session.deliveryAddress || "Por confirmar"}`]
      : []),
    `💵 Subtotal: ${money(orderSubtotal)}`,
    `🚗 Delivery: ${money(deliveryFee)}`,
    `💰 TOTAL: ${money(orderSubtotal + deliveryFee)}`,
    "━━━━━━━━━━━━━━━━━━",
    "",
    "¿Confirmas tu pedido?",
    "✅ Escribe SI para confirmar",
    "❌ Escribe NO para cancelar",
  ].join("\n");
}

function currentOrderMessage(session, config) {
  const details = finalSummary(session, config)
    .split("\n")
    .slice(0, -4);
  return [
    "📋 ESTE ES TU PEDIDO ACTUAL:",
    ...details.slice(1),
    "",
    "¿Qué deseas hacer?",
    "1️⃣ - Agregar productos",
    "2️⃣ - Quitar productos",
    "3️⃣ - Cambiar día de entrega",
    "4️⃣ - Cambiar Pickup / Delivery",
    "5️⃣ - Cancelar pedido",
    "6️⃣ - No hacer cambios",
    "",
    "También puedes escribir: agregar, quitar, cambiar o cancelar.",
  ].join("\n");
}

function updateConfirmationMessage(session, config) {
  const details = finalSummary(session, config)
    .split("\n")
    .slice(0, -4);
  return [
    "📝 ASÍ QUEDARÍA TU PEDIDO:",
    ...details.slice(1),
    "",
    "¿Quieres guardar estos cambios?",
    "✅ Escribe SI para actualizar",
    "❌ Escribe NO para conservar el pedido anterior",
  ].join("\n");
}

function productUpdateMenu(session, action) {
  const verb = action === "ADD" ? "agregar" : "quitar";
  return [
    `¿Qué producto deseas ${verb}?`,
    `1️⃣ - Conchitas Chocolate (actual: ${Number(session.quantities.chocolate || 0)})`,
    `2️⃣ - Conchitas Vainilla (actual: ${Number(session.quantities.vanilla || 0)})`,
    `3️⃣ - Bolillos (actual: ${Number(session.quantities.bolillo || 0)})`,
  ].join("\n");
}

function updateBackup(session) {
  return {
    quantities: { ...session.quantities },
    schedule: { ...session.schedule },
    fulfillment: { ...session.fulfillment },
    deliveryAddress: session.deliveryAddress || "",
    addressType: session.addressType || "",
  };
}

function restoreUpdate(session) {
  const backup = session.updateBackup;
  if (!backup) return { ...session, step: "COMPLETED" };
  const restored = {
    ...session,
    step: "COMPLETED",
    quantities: { ...backup.quantities },
    schedule: { ...backup.schedule },
    fulfillment: { ...backup.fulfillment },
    deliveryAddress: backup.deliveryAddress,
    addressType: backup.addressType,
  };
  delete restored.updateBackup;
  delete restored.updateAction;
  delete restored.updateProductKey;
  return restored;
}

function finishUpdate(session) {
  const finished = { ...session, step: "COMPLETED" };
  delete finished.updateBackup;
  delete finished.updateAction;
  delete finished.updateProductKey;
  return finished;
}

function confirmedMessage(session) {
  const lines = [
    `🎉 ¡Pedido confirmado, ${customerLabel(session.customerName)}!`,
    "",
    "Gracias por elegir La Cenaduria Brampton 🥖❤️",
    "",
    `Tu pedido estará listo el ${session.schedule.name} ${session.schedule.timeWindow}.`,
    "",
  ];
  if (session.fulfillment.type === "DELIVERY") {
    lines.push(
      `📍 Dirección de entrega: ${session.deliveryAddress || "Por confirmar"}`,
      "",
    );
  }
  lines.push(
    "📱 Te contactaremos si hay algún cambio.",
    "",
    "¡Que los disfrutes mucho! 😊",
    "",
    "📝 Para cambiar tu orden escribe ACTUALIZAR PEDIDO.",
    "También puedes escribir agregar, quitar o cancelar.",
  );
  return lines.join("\n");
}

function updatedMessage(session, config) {
  const details = finalSummary(session, config)
    .split("\n")
    .slice(0, -4);
  const lines = [
    "✅ ¡Tu pedido fue actualizado!",
    "",
    ...details,
  ];
  if (session.fulfillment.type === "DELIVERY") {
    lines.push(
      "",
      "📍 Comparte tu ubicación si también cambió la dirección de entrega.",
    );
  }
  lines.push(
    "",
    "Para hacer otro cambio escribe ACTUALIZAR PEDIDO.",
  );
  return lines.join("\n");
}

function newSession({ chatId, customerName, customerPhone, now = new Date() }) {
  return {
    orderId: `CHAT-${now.getTime()}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`,
    chatId,
    customerName,
    customerPhone,
    step: "MENU",
    quantities: {},
    productOrder: [],
    productIndex: 0,
    schedule: null,
    fulfillment: null,
    deliveryAddress: "",
    addressType: "",
    createdAt: now.toISOString(),
  };
}

function advanceConversation(session, input, config, now = new Date()) {
  const answer = normalizeAnswer(input);
  const restartCommands = ["HOLA", "MENU", "PEDIDO", "ORDEN"];

  if (session.step === "COMPLETED") {
    if (restartCommands.includes(answer)) {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        now,
      });
      return {
        session: next,
        messages: [menuMessage(next.customerName, config)],
      };
    }
    if (updateKeyword(answer)) {
      const next = {
        ...session,
        step: "UPDATE_MENU",
        updateBackup: updateBackup(session),
      };
      return {
        session: next,
        messages: [currentOrderMessage(next, config)],
      };
    }
    return { session, messages: [] };
  }

  if (session.step === "CANCELED") {
    if (restartCommands.includes(answer)) {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        now,
      });
      return {
        session: next,
        messages: [menuMessage(next.customerName, config)],
      };
    }
    return {
      session,
      messages: [
        "Este pedido está cancelado. Escribe HOLA para iniciar uno nuevo.",
      ],
    };
  }

  if (
    cancelKeyword(answer) &&
    String(session.step).startsWith("UPDATE")
  ) {
    return {
      session: { ...session, step: "CANCEL_CONFIRMATION" },
      messages: [
        [
          "⚠️ ¿Seguro que deseas cancelar todo el pedido?",
          "Escribe SI para cancelarlo o NO para conservarlo.",
        ].join("\n"),
      ],
    };
  }

  if (
    cancelKeyword(answer) &&
    !String(session.step).startsWith("UPDATE") &&
    session.step !== "CANCEL_CONFIRMATION"
  ) {
    return {
      session: null,
      messages: [
        "Pedido cancelado. Escribe HOLA cuando quieras iniciar uno nuevo.",
      ],
      canceled: true,
    };
  }

  if (session.step === "MENU") {
    const productOrder = PRODUCT_ORDERS[answer];
    if (!productOrder) {
      return {
        session,
        messages: [
          "Por favor responde 1, 2, 3 o 4 para elegir una opción del menú.",
        ],
      };
    }
    const next = {
      ...session,
      step: "QUANTITY",
      productOrder,
      productIndex: 0,
      quantities: {},
    };
    return {
      session: next,
      messages: [
        quantityPrompt(
          productOrder[0],
          true,
          config.minimumOrderPieces,
        ),
      ],
    };
  }

  if (session.step === "QUANTITY") {
    if (!/^\d{1,3}$/.test(answer)) {
      return {
        session,
        messages: [
          "Escribe una cantidad usando solamente números, por ejemplo: 5.",
        ],
      };
    }
    const quantity = Number(answer);
    const productKey = session.productOrder[session.productIndex];
    const quantities = { ...session.quantities, [productKey]: quantity };
    const nextIndex = session.productIndex + 1;
    const acknowledgement = quantityAcknowledgement(productKey, quantity);

    if (nextIndex < session.productOrder.length) {
      return {
        session: {
          ...session,
          quantities,
          productIndex: nextIndex,
        },
        messages: [
          [
            acknowledgement,
            "",
            quantityPrompt(
              session.productOrder[nextIndex],
              false,
              config.minimumOrderPieces,
            ),
          ].join("\n"),
        ],
      };
    }

    if (totalPieces(quantities) < config.minimumOrderPieces) {
      return {
        session: {
          ...session,
          quantities: {},
          productIndex: 0,
        },
        messages: [
          [
            acknowledgement,
            "",
            `⚠️ El pedido mínimo es de ${config.minimumOrderPieces} piezas.`,
            "Vamos a capturar nuevamente las cantidades.",
            "",
            quantityPrompt(
              session.productOrder[0],
              true,
              config.minimumOrderPieces,
            ),
          ].join("\n"),
        ],
      };
    }

    const next = {
      ...session,
      step: "DAY",
      quantities,
      productIndex: nextIndex,
    };
    return {
      session: next,
      messages: [orderSummary(next, config)],
    };
  }

  if (session.step === "DAY") {
    const schedule = scheduleFromAnswer(answer, config, now);
    if (!schedule) {
      return {
        session,
        messages: ["Responde 1 para Miércoles o 2 para Sábado."],
      };
    }
    return {
      session: { ...session, step: "FULFILLMENT", schedule },
      messages: [
        [
          `✅ ${schedule.name} anotado!`,
          "",
          "🚗 ¿Cómo prefieres recibir tu pedido?",
          "1️⃣ - Pickup GRATIS (lo recojo yo)",
          "2️⃣ - Delivery a domicilio",
        ].join("\n"),
      ],
    };
  }

  if (session.step === "FULFILLMENT") {
    if (answer === "1") {
      const next = {
        ...session,
        step: "CONFIRMATION",
        fulfillment: { type: "PICKUP", city: "", deliveryFee: 0 },
      };
      return {
        session: next,
        messages: [
          ["✅ Pickup GRATIS seleccionado!", "", finalSummary(next, config)].join(
            "\n",
          ),
        ],
      };
    }
    if (answer === "2") {
      return {
        session: { ...session, step: "CITY" },
        messages: [
          [
            "🚗 ¿En qué ciudad necesitas delivery?",
            `1️⃣ - Brampton (${money(config.deliveryFees.brampton)})`,
            `2️⃣ - Mississauga (${money(config.deliveryFees.mississauga)})`,
          ].join("\n"),
        ],
      };
    }
    return {
      session,
      messages: ["Responde 1 para Pickup o 2 para Delivery."],
    };
  }

  if (session.step === "CITY") {
    const city =
      answer === "1"
        ? "BRAMPTON"
        : answer === "2"
          ? "MISSISSAUGA"
          : "";
    if (!city) {
      return {
        session,
        messages: ["Responde 1 para Brampton o 2 para Mississauga."],
      };
    }
    const deliveryFee =
      city === "BRAMPTON"
        ? config.deliveryFees.brampton
        : config.deliveryFees.mississauga;
    const next = {
      ...session,
      step: "ADDRESS",
      fulfillment: { type: "DELIVERY", city, deliveryFee },
      deliveryAddress: "",
      addressType: "",
    };
    const cityName = city === "BRAMPTON" ? "Brampton" : "Mississauga";
    return {
      session: next,
      messages: [
        [
          `✅ Delivery en ${cityName} seleccionado!`,
          "",
          addressPrompt(),
        ].join("\n"),
      ],
    };
  }

  if (session.step === "ADDRESS") {
    const address = parseDeliveryAddress(input);
    if (!address) {
      return {
        session,
        messages: [
          "Escribe una dirección completa o pega una liga válida de Google Maps.",
        ],
      };
    }
    const next = {
      ...session,
      step: "CONFIRMATION",
      deliveryAddress: address.value,
      addressType: address.type,
    };
    return {
      session: next,
      messages: [
        ["✅ Dirección recibida!", "", finalSummary(next, config)].join(
          "\n",
        ),
      ],
    };
  }

  if (session.step === "UPDATE_MENU") {
    let option = answer;
    if (/\b(AGREGAR|ANADIR)\b/.test(answer)) option = "1";
    if (/\b(QUITAR|ELIMINAR)\b/.test(answer)) option = "2";
    if (/\b(DIA|FECHA)\b/.test(answer)) option = "3";
    if (/\b(PICKUP|DELIVERY|ENTREGA|RECOGER)\b/.test(answer)) option = "4";
    if (/\b(CANCELAR|CANCELACION)\b/.test(answer)) option = "5";

    if (option === "1" || option === "2") {
      const updateAction = option === "1" ? "ADD" : "REMOVE";
      const next = {
        ...session,
        step: "UPDATE_PRODUCT",
        updateAction,
      };
      return {
        session: next,
        messages: [productUpdateMenu(next, updateAction)],
      };
    }
    if (option === "3") {
      return {
        session: { ...session, step: "UPDATE_DAY" },
        messages: [
          [
            "📅 ¿Para qué día quieres cambiar tu pedido?",
            `1️⃣ - Miércoles (${config.deliveryWindows.wednesday})`,
            `2️⃣ - Sábado (${config.deliveryWindows.saturday})`,
          ].join("\n"),
        ],
      };
    }
    if (option === "4") {
      return {
        session: { ...session, step: "UPDATE_FULFILLMENT" },
        messages: [
          [
            "🚗 ¿Cómo prefieres recibir tu pedido?",
            "1️⃣ - Pickup GRATIS (lo recojo yo)",
            "2️⃣ - Delivery a domicilio",
          ].join("\n"),
        ],
      };
    }
    if (option === "5") {
      return {
        session: { ...session, step: "CANCEL_CONFIRMATION" },
        messages: [
          [
            "⚠️ ¿Seguro que deseas cancelar todo el pedido?",
            "Escribe SI para cancelarlo o NO para conservarlo.",
          ].join("\n"),
        ],
      };
    }
    if (option === "6") {
      return {
        session: restoreUpdate(session),
        messages: ["Perfecto, conservamos tu pedido sin cambios."],
      };
    }
    return {
      session,
      messages: [
        "Responde del 1 al 6 para elegir qué deseas actualizar.",
      ],
    };
  }

  if (session.step === "UPDATE_PRODUCT") {
    const productKey =
      answer === "1"
        ? "chocolate"
        : answer === "2"
          ? "vanilla"
          : answer === "3"
            ? "bolillo"
            : "";
    if (!productKey) {
      return {
        session,
        messages: ["Responde 1, 2 o 3 para elegir el producto."],
      };
    }
    const actionText =
      session.updateAction === "ADD" ? "agregar" : "quitar";
    return {
      session: {
        ...session,
        step: "UPDATE_QUANTITY",
        updateProductKey: productKey,
      },
      messages: [
        `¿Cuántas ${PRODUCTS[productKey].promptName} deseas ${actionText}?`,
      ],
    };
  }

  if (session.step === "UPDATE_QUANTITY") {
    if (!/^\d{1,3}$/.test(answer) || Number(answer) < 1) {
      return {
        session,
        messages: ["Escribe una cantidad mayor a 0 usando números."],
      };
    }
    const quantity = Number(answer);
    const productKey = session.updateProductKey;
    const currentQuantity = Number(session.quantities[productKey] || 0);
    if (
      session.updateAction === "REMOVE" &&
      quantity > currentQuantity
    ) {
      return {
        session,
        messages: [
          `Tu pedido tiene ${currentQuantity} ${PRODUCTS[productKey].promptName}. Escribe una cantidad menor o igual.`,
        ],
      };
    }
    const newQuantity =
      session.updateAction === "ADD"
        ? currentQuantity + quantity
        : currentQuantity - quantity;
    const quantities = {
      ...session.quantities,
      [productKey]: newQuantity,
    };
    if (totalPieces(quantities) < config.minimumOrderPieces) {
      return {
        session,
        messages: [
          `El pedido debe conservar al menos ${config.minimumOrderPieces} piezas. Puedes quitar menos o cancelar todo el pedido.`,
        ],
      };
    }
    const next = {
      ...session,
      step: "UPDATE_CONFIRMATION",
      quantities,
    };
    return {
      session: next,
      messages: [updateConfirmationMessage(next, config)],
    };
  }

  if (session.step === "UPDATE_DAY") {
    const schedule = scheduleFromAnswer(answer, config, now);
    if (!schedule) {
      return {
        session,
        messages: ["Responde 1 para Miércoles o 2 para Sábado."],
      };
    }
    const next = {
      ...session,
      step: "UPDATE_CONFIRMATION",
      schedule,
    };
    return {
      session: next,
      messages: [updateConfirmationMessage(next, config)],
    };
  }

  if (session.step === "UPDATE_FULFILLMENT") {
    if (answer === "1") {
      const next = {
        ...session,
        step: "UPDATE_CONFIRMATION",
        fulfillment: { type: "PICKUP", city: "", deliveryFee: 0 },
        deliveryAddress: "",
        addressType: "",
      };
      return {
        session: next,
        messages: [updateConfirmationMessage(next, config)],
      };
    }
    if (answer === "2") {
      return {
        session: { ...session, step: "UPDATE_CITY" },
        messages: [
          [
            "🚗 ¿En qué ciudad necesitas delivery?",
            `1️⃣ - Brampton (${money(config.deliveryFees.brampton)})`,
            `2️⃣ - Mississauga (${money(config.deliveryFees.mississauga)})`,
          ].join("\n"),
        ],
      };
    }
    return {
      session,
      messages: ["Responde 1 para Pickup GRATIS o 2 para Delivery."],
    };
  }

  if (session.step === "UPDATE_CITY") {
    const city =
      answer === "1"
        ? "BRAMPTON"
        : answer === "2"
          ? "MISSISSAUGA"
          : "";
    if (!city) {
      return {
        session,
        messages: ["Responde 1 para Brampton o 2 para Mississauga."],
      };
    }
    const next = {
      ...session,
      step: "UPDATE_ADDRESS",
      fulfillment: {
        type: "DELIVERY",
        city,
        deliveryFee:
          city === "BRAMPTON"
            ? config.deliveryFees.brampton
            : config.deliveryFees.mississauga,
      },
      deliveryAddress: "",
      addressType: "",
    };
    return {
      session: next,
      messages: [addressPrompt()],
    };
  }

  if (session.step === "UPDATE_ADDRESS") {
    const address = parseDeliveryAddress(input);
    if (!address) {
      return {
        session,
        messages: [
          "Escribe una dirección completa o pega una liga válida de Google Maps.",
        ],
      };
    }
    const next = {
      ...session,
      step: "UPDATE_CONFIRMATION",
      deliveryAddress: address.value,
      addressType: address.type,
    };
    return {
      session: next,
      messages: [updateConfirmationMessage(next, config)],
    };
  }

  if (session.step === "UPDATE_CONFIRMATION") {
    if (
      session.fulfillment?.type === "DELIVERY" &&
      !session.deliveryAddress
    ) {
      const next = { ...session, step: "UPDATE_ADDRESS" };
      return {
        session: next,
        messages: [
          [
            "Antes de actualizar el pedido necesitamos la dirección de entrega.",
            "",
            addressPrompt(),
          ].join("\n"),
        ],
      };
    }
    if (answer === "SI") {
      return {
        session: finishUpdate(session),
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

  if (session.step === "CANCEL_CONFIRMATION") {
    if (answer === "SI" || answer === "SI CANCELAR") {
      const canceled = finishUpdate(session);
      canceled.step = "CANCELED";
      return {
        session: canceled,
        messages: [],
        orderCanceled: true,
      };
    }
    if (answer === "NO") {
      return {
        session: restoreUpdate(session),
        messages: ["Perfecto, tu pedido sigue confirmado."],
      };
    }
    return {
      session,
      messages: ["Responde SI para cancelar o NO para conservarlo."],
    };
  }

  if (session.step === "CONFIRMATION") {
    if (
      session.fulfillment?.type === "DELIVERY" &&
      !session.deliveryAddress
    ) {
      const next = { ...session, step: "ADDRESS" };
      return {
        session: next,
        messages: [
          [
            "Antes de confirmar necesitamos la dirección de entrega.",
            "",
            addressPrompt(),
          ].join("\n"),
        ],
      };
    }
    if (answer === "SI") {
      return {
        session: { ...session, step: "COMPLETED" },
        messages: [],
        completed: true,
      };
    }
    if (answer === "NO") {
      return {
        session: null,
        messages: [
          "Pedido cancelado. Escribe HOLA cuando quieras iniciar uno nuevo.",
        ],
        canceled: true,
      };
    }
    return {
      session,
      messages: ["Responde SI para confirmar o NO para cancelar."],
    };
  }

  return { session: null, messages: [] };
}

function buildTextOrder(session, confirmationMessage, config) {
  const products = Object.entries(session.quantities)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([productKey, quantity]) => ({
      id: PRODUCTS[productKey].productId,
      name: PRODUCTS[productKey].sheetName,
      quantity,
      price: Number(config.menuPrices[productKey]) * 1000,
      currency: "CAD",
    }));
  const logistics =
    session.fulfillment.type === "PICKUP"
      ? { id: "pickup", name: "Recoger", price: 0 }
      : {
          id: `delivery-${session.fulfillment.city.toLowerCase()}`,
          name: `Delivery en ${
            session.fulfillment.city === "BRAMPTON"
              ? "Brampton"
              : "Mississauga"
          }`,
          price: session.fulfillment.deliveryFee * 1000,
        };
  products.push({ ...logistics, quantity: 1, currency: "CAD" });

  const normalized = normalizeOrder({
    message: {
      orderId: session.orderId,
      from: session.chatId,
      id: confirmationMessage?.id,
    },
    order: { currency: "CAD", products },
    customerName: session.customerName,
    customerPhone: session.customerPhone,
    priceDivisor: 1000,
    deliveryFees: config.deliveryFees,
    pickupTimeWindow: session.schedule.timeWindow,
  });
  normalized.summary.requestedDate = session.schedule.date;
  normalized.summary.timeWindow = session.schedule.timeWindow;
  normalized.summary.address =
    session.fulfillment.type === "DELIVERY"
      ? session.deliveryAddress || ""
      : "";
  normalized.summary.scheduleStatus = "CONFIRMADO";
  normalized.summary.status =
    session.fulfillment.type === "DELIVERY"
      ? "ESPERANDO_DATOS"
      : "CONFIRMADO";
  normalized.summary.customerNotes = "Pedido tomado por chat";
  return normalized;
}

class ConversationStateStore {
  constructor(file) {
    this.file = file;
    this.sessions = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  get(chatId) {
    return this.sessions[chatId] || null;
  }

  set(chatId, session) {
    if (session) this.sessions[chatId] = session;
    else delete this.sessions[chatId];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.sessions, null, 2));
  }
}

module.exports = {
  advanceConversation,
  buildTextOrder,
  confirmedMessage,
  ConversationStateStore,
  finalSummary,
  menuMessage,
  newSession,
  nextWeekdayDate,
  orderSummary,
  parseDeliveryAddress,
  PRODUCTS,
  subtotal,
  totalPieces,
  updatedMessage,
};
