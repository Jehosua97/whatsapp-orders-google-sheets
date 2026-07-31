"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeOrder } = require("./order");
const { isServiceClosed } = require("./admin-config");
const { DEFAULT_PICKUP_ADDRESS } = require("./business-details");
const {
  compatibleProductDates,
  dateLabel,
  normalizeProductionWeekdays,
  WEEKDAY_NAMES,
} = require("./product-availability");

const PRODUCTS = {
  chocolate: {
    emoji: "🍫",
    displayName: "Conchitas Chocolate",
    promptName: "Conchitas de Chocolate",
    sheetName: "Concha de chocolate",
    productId: "concha-chocolate",
    productionWeekdays: [3, 6],
  },
  vanilla: {
    emoji: "🍦",
    displayName: "Conchitas Vainilla",
    promptName: "Conchitas de Vainilla",
    sheetName: "Concha de Vainilla",
    productId: "concha-vainilla",
    productionWeekdays: [3, 6],
  },
  bolillo: {
    emoji: "🍞",
    displayName: "Bolillos",
    promptName: "Bolillos",
    sheetName: "Bolillo",
    productId: "bolillo",
    productionWeekdays: [3, 6],
  },
};

function catalogProducts(config) {
  if (Array.isArray(config.catalog) && config.catalog.length) {
    return config.catalog.map((product) => ({
      ...product,
      displayName: product.name,
      promptName: product.promptName || product.name,
      sheetName: product.sheetName || product.name,
      productId: product.id,
    }));
  }
  return Object.entries(PRODUCTS).map(([id, product]) => ({
    id,
    ...product,
    name: product.displayName,
    price: Number(config.menuPrices[id] || 0),
    active: true,
  }));
}

function productDefinition(productKey, config) {
  return (
    catalogProducts(config).find((product) => product.id === productKey) ||
    PRODUCTS[productKey] || {
      id: productKey,
      productId: productKey,
      emoji: "🥖",
      displayName: productKey,
      promptName: productKey,
      sheetName: productKey,
    }
  );
}

function activeProducts(config) {
  return catalogProducts(config).filter((product) => product.active !== false);
}

function menuProductKeys(config) {
  return activeProducts(config).map((product) => product.id);
}

function productOrderFromAnswer(answer, productKeys) {
  const selectedIndexes = String(answer || "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((value) => Number(value) - 1);
  if (selectedIndexes.length > 1) {
    if (
      selectedIndexes.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= productKeys.length,
      )
    ) {
      return null;
    }
    return [
      ...new Set(selectedIndexes.map((index) => productKeys[index])),
    ];
  }
  const index = Number(answer) - 1;
  if (!Number.isInteger(index)) return null;
  if (index === productKeys.length && productKeys.length > 1) {
    return [...productKeys];
  }
  if (index < 0 || index >= productKeys.length) return null;
  return [productKeys[index]];
}

function configuredSchedules(config) {
  if (Array.isArray(config.schedules) && config.schedules.length) {
    return config.schedules;
  }
  return [
    {
      id: "wednesday",
      name: "Miércoles",
      weekday: 3,
      active: true,
      pickupEnabled: true,
      pickupWindow: config.pickupTimeWindow,
      deliveryEnabled: true,
      deliveryWindow: config.deliveryWindows.wednesday,
    },
    {
      id: "saturday",
      name: "Sábado",
      weekday: 6,
      active: true,
      pickupEnabled: true,
      pickupWindow: config.pickupTimeWindow,
      deliveryEnabled: true,
      deliveryWindow: config.deliveryWindows.saturday,
    },
  ];
}

function legacyScheduleOptions(config, now, serviceType = "") {
  return configuredSchedules(config)
    .filter((schedule) => schedule.active !== false)
    .map((schedule) => {
      const date = nextWeekdayDate(now, schedule.weekday);
      const pickupAvailable =
        schedule.pickupEnabled !== false &&
        !isServiceClosed(
          { closures: config.closures || [] },
          date,
          "PICKUP",
        );
      const deliveryAvailable =
        schedule.deliveryEnabled !== false &&
        !isServiceClosed(
          { closures: config.closures || [] },
          date,
          "DELIVERY",
        );
      return {
        ...schedule,
        date,
        pickupAvailable,
        deliveryAvailable,
      };
    })
    .filter((schedule) => {
      if (serviceType === "PICKUP") return schedule.pickupAvailable;
      if (serviceType === "DELIVERY") return schedule.deliveryAvailable;
      return schedule.pickupAvailable || schedule.deliveryAvailable;
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function productKeysFromQuantities(quantities) {
  return Object.entries(quantities || {})
    .filter(([, quantity]) => Number(quantity || 0) > 0)
    .map(([productKey]) => productKey);
}

function scheduleOptions(
  config,
  now,
  serviceType = "",
  selectedProductKeys = [],
) {
  const requestedKeys = [...new Set(selectedProductKeys.filter(Boolean))];
  const products = requestedKeys
    .map((key) =>
      activeProducts(config).find((product) => product.id === key),
    )
    .filter(Boolean);
  const hasProductionRules =
    requestedKeys.length > 0 &&
    products.length === requestedKeys.length &&
    products.every(
      (product) =>
        normalizeProductionWeekdays(product.productionWeekdays).length > 0,
    );
  if (!hasProductionRules) {
    return legacyScheduleOptions(config, now, serviceType);
  }

  return compatibleProductDates(products, now).map((availability) => {
    const configured =
      configuredSchedules(config).find(
        (schedule) => schedule.weekday === availability.weekday,
      ) || {};
    const pickupAvailable =
      configured.pickupEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        availability.date,
        "PICKUP",
      );
    const deliveryAvailable =
      configured.deliveryEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        availability.date,
        "DELIVERY",
      );
    return {
      ...configured,
      id: `products-${availability.date}`,
      name: dateLabel(availability.date),
      weekday: availability.weekday,
      date: availability.date,
      pickupWindow:
        configured.pickupWindow || config.pickupTimeWindow,
      deliveryWindow:
        configured.deliveryWindow || "horario por confirmar",
      pickupAvailable,
      deliveryAvailable,
      freshProductNames: availability.freshProducts.map(
        (product) => product.name,
      ),
      previousDayProductNames: availability.previousDayProducts.map(
        (product) => product.name,
      ),
    };
  }).filter((schedule) => {
    if (serviceType === "PICKUP") return schedule.pickupAvailable;
    if (serviceType === "DELIVERY") return schedule.deliveryAvailable;
    return schedule.pickupAvailable || schedule.deliveryAvailable;
  });
}

function scheduleMenu(options, title = "📅 ¿Para qué día quieres tu entrega?") {
  if (!options.length) {
    return [
      title,
      "Por el momento no tenemos fechas disponibles. Te contactaremos para ayudarte.",
    ].join("\n");
  }
  const lines = [title];
  options.forEach((schedule, index) => {
    if (schedule.freshProductNames) {
      lines.push(`${index + 1} - ${schedule.name}`);
      if (schedule.freshProductNames.length) {
        lines.push(
          `   Recién hechos: ${schedule.freshProductNames.join(", ")}`,
        );
      }
      if (schedule.previousDayProductNames.length) {
        lines.push(
          `   Producción anterior: ${schedule.previousDayProductNames.join(", ")}`,
        );
      }
      return;
    }
    lines.push(
      `${index + 1} - ${schedule.name} (${schedule.pickupAvailable && schedule.deliveryAvailable
        ? schedule.deliveryWindow || schedule.pickupWindow
        : schedule.pickupAvailable
          ? `Pickup: ${schedule.pickupWindow}`
          : `Delivery: ${schedule.deliveryWindow}`})`,
    );
  });
  return lines.join("\n");
}

function fulfillmentMenu(schedule) {
  const lines = ["🚗 ¿Cómo prefieres recibir tu pedido?"];
  if (schedule.pickupAvailable) {
    lines.push(`1 - Pickup GRATIS (${schedule.pickupWindow})`);
  }
  if (schedule.deliveryAvailable) {
    lines.push(`2 - Delivery a domicilio (${schedule.deliveryWindow})`);
  }
  return lines.join("\n");
}

function scheduleAvailability(schedule, config) {
  if (!schedule) return schedule;
  const weekday = new Date(`${schedule.date}T12:00:00.000Z`).getUTCDay();
  const current =
    configuredSchedules(config).find((item) => item.id === schedule.id) ||
    configuredSchedules(config).find((item) => item.weekday === weekday) ||
    schedule;
  return {
    ...current,
    ...schedule,
    date: schedule.date,
    pickupAvailable:
      current.pickupEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        schedule.date,
        "PICKUP",
      ),
    deliveryAvailable:
      current.deliveryEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        schedule.date,
        "DELIVERY",
      ),
  };
}

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function updateKeyword(value) {
  const answer = normalizeAnswer(value);
  return /\b(ACTUALIZAR|AGREGAR|ANADIR|QUITAR|ELIMINAR|CAMBIAR|MODIFICAR|CANCELAR|CANCELACION|PICKUP|DELIVERY|ENTREGA|RECOGER)\b/.test(
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

function productionCalendarLines(products) {
  const groups = new Map();
  for (const product of products) {
    const weekdays = normalizeProductionWeekdays(
      product.productionWeekdays,
    );
    if (!weekdays.length) continue;
    const key = weekdays.join(",");
    const current = groups.get(key) || { weekdays, names: [] };
    current.names.push(product.name);
    groups.set(key, current);
  }
  return [...groups.values()].map(({ weekdays, names }) => {
    const dayNames = weekdays.map((weekday) => WEEKDAY_NAMES[weekday]);
    const days =
      dayNames.length === 1
        ? dayNames[0]
        : `${dayNames.slice(0, -1).join(", ")} y ${dayNames.at(-1)}`;
    return `${days}: ${names.join(", ")}`;
  });
}

function menuMessage(name, config) {
  const products = activeProducts(config);
  const productionLines = productionCalendarLines(products);
  return [
    `Mucho gusto, ${customerLabel(name)} 😊`,
    "",
    "📋 NUESTRO MENU:",
    "",
    ...products.map(
      (product) =>
        `${product.emoji} ${product.name} - ${money(product.price)} c/u`,
    ),
    ...(productionLines.length
      ? [
          "",
          "📅 DÍAS DE PRODUCCIÓN:",
          ...productionLines,
          "También puedes pedir cada producto para el día siguiente a su producción.",
        ]
      : []),
    "",
    `⚠️ Pedido mínimo: ${config.minimumOrderPieces} piezas`,
    "",
    "¿Qué deseas ordenar? Escribe:",
    ...products.map(
      (product, index) => `${index + 1} - ${product.name}`,
    ),
    ...(products.length > 1
      ? [`${products.length + 1} - Armar combinación paso a paso`]
      : []),
    "",
    "Responde con un número o combina varios separados por coma, por ejemplo: 1,4.",
  ].join("\n");
}

function quantityPrompt(productKey, first, minimumPieces, config) {
  const product = productDefinition(productKey, config);
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

function quantityAcknowledgement(productKey, quantity, config) {
  const product = productDefinition(productKey, config);
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

function productLines(quantities, prices, includePrices, config) {
  const configuredKeys = catalogProducts(config).map((product) => product.id);
  const keys = [
    ...new Set([...configuredKeys, ...Object.keys(quantities || {})]),
  ];
  return keys.map((productKey) => {
    const product = productDefinition(productKey, config);
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
    ...productLines(session.quantities, config.menuPrices, true, config),
    "━━━━━━━━━━━━━━━━━━",
    `📦 Total piezas: ${pieces}`,
    `💵 Subtotal: ${money(orderSubtotal)}`,
    "",
    scheduleMenu(session.scheduleOptions || []),
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

function scheduleFromAnswer(answer, config, now, options) {
  const choices = options || scheduleOptions(config, now);
  const index = Number(answer) - 1;
  const selected = choices[index];
  return selected ? { ...selected } : null;
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
    "━━━━━━━━━━",
    ...productLines(session.quantities, config.menuPrices, false, config),
    "━━━━━━━━━━",
    `📦 Total piezas: ${pieces}`,
    `📅 Entrega: ${session.schedule.name} ${session.schedule.timeWindow}`,
    `🏪 Tipo: ${type}`,
    ...(session.fulfillment.type === "DELIVERY"
      ? [`📍 Dirección: ${session.deliveryAddress || "Por confirmar"}`]
      : [
          `📍 Dirección de pickup: ${
            session.fulfillment.pickupAddress ||
            config.pickupAddress ||
            DEFAULT_PICKUP_ADDRESS
          }`,
        ]),
    `💵 Subtotal: ${money(orderSubtotal)}`,
    `🚗 Delivery: ${money(deliveryFee)}`,
    `💰 TOTAL: ${money(orderSubtotal + deliveryFee)}`,
    "━━━━━━━━━━",
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

function confirmedOrderReminder(session, config) {
  const summary = finalSummary(session, config)
    .split("\n")
    .slice(0, -4);
  return [
    `Hola, ${customerLabel(session.customerName)}. Este es tu pedido confirmado:`,
    "",
    ...summary,
    "",
    "¿Qué deseas hacer?",
    "1 - Actualizar pedido",
    "2 - Crear un pedido nuevo",
    "",
    "También puedes escribir ACTUALIZAR PEDIDO o NUEVO PEDIDO.",
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

function updateProductKeys(session, action, config) {
  const activeKeys = activeProducts(config).map((product) => product.id);
  if (action === "ADD") return activeKeys;
  return [
    ...new Set([
      ...activeKeys,
      ...Object.keys(session.quantities || {}).filter(
        (key) => Number(session.quantities[key] || 0) > 0,
      ),
    ]),
  ];
}

function productUpdateMenu(session, action, config, keys) {
  const verb = action === "ADD" ? "agregar" : "quitar";
  const productKeys = keys || updateProductKeys(session, action, config);
  return [
    `¿Qué producto deseas ${verb}?`,
    ...productKeys.map((key, index) => {
      const product = productDefinition(key, config);
      return `${index + 1} - ${product.name || product.displayName} (actual: ${Number(session.quantities[key] || 0)})`;
    }),
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
  delete restored.updateProductKeys;
  delete restored.updateScheduleOptions;
  return restored;
}

function finishUpdate(session) {
  const finished = { ...session, step: "COMPLETED" };
  delete finished.updateBackup;
  delete finished.updateAction;
  delete finished.updateProductKey;
  delete finished.updateProductKeys;
  delete finished.updateScheduleOptions;
  return finished;
}

function confirmedMessage(session, config = {}) {
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
  } else {
    lines.push(
      `📍 Dirección de pickup: ${
        session.fulfillment.pickupAddress ||
        config.pickupAddress ||
        DEFAULT_PICKUP_ADDRESS
      }`,
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
    "Para consultar tu pedido escribe HOLA.",
  );
  return lines.join("\n");
}

function newSession({
  chatId,
  customerName,
  customerPhone,
  config,
  now = new Date(),
}) {
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
    menuProductKeys: config ? menuProductKeys(config) : [],
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
  const newOrderCommands = [
    "NUEVO PEDIDO",
    "NUEVA ORDEN",
    "HACER PEDIDO",
    "HACER OTRO PEDIDO",
  ];
  const canceledRestartCommands = [
    "HOLA",
    "MENU",
    "PEDIDO",
    "ORDEN",
    ...newOrderCommands,
  ];

  if (session.step === "COMPLETED") {
    if (newOrderCommands.includes(answer) || answer === "2") {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        config,
        now,
      });
      return {
        session: next,
        messages: [menuMessage(next.customerName, config)],
      };
    }
    if (
      [
        "HOLA",
        "MENU",
        "PEDIDO",
        "ORDEN",
        "BUENOS DIAS",
        "BUENAS TARDES",
        "BUENAS NOCHES",
      ].includes(answer)
    ) {
      return {
        session,
        messages: [confirmedOrderReminder(session, config)],
      };
    }
    if (answer === "1") {
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
    if (updateKeyword(answer)) {
      const base = {
        ...session,
        updateBackup: updateBackup(session),
      };
      if (cancelKeyword(answer)) {
        return {
          session: { ...base, step: "CANCEL_CONFIRMATION" },
          messages: [
            [
              "⚠️ ¿Seguro que deseas cancelar todo el pedido?",
              "Escribe SI para cancelarlo o NO para conservarlo.",
            ].join("\n"),
          ],
        };
      }
      const isAdd = /\b(AGREGAR|ANADIR)\b/.test(answer);
      const isRemove = /\b(QUITAR|ELIMINAR)\b/.test(answer);
      if (isAdd || isRemove) {
        const updateAction = isAdd ? "ADD" : "REMOVE";
        const productKeys = updateProductKeys(
          base,
          updateAction,
          config,
        );
        const next = {
          ...base,
          step: "UPDATE_PRODUCT",
          updateAction,
          updateProductKeys: productKeys,
        };
        return {
          session: next,
          messages: [
            productUpdateMenu(next, updateAction, config, productKeys),
          ],
        };
      }
      if (/\b(DIA|FECHA)\b/.test(answer)) {
        const choices = scheduleOptions(
          config,
          now,
          session.fulfillment?.type || "",
          productKeysFromQuantities(session.quantities),
        );
        return {
          session: {
            ...base,
            step: "UPDATE_DAY",
            updateScheduleOptions: choices,
          },
          messages: [
            scheduleMenu(
              choices,
              "📅 ¿Para qué día quieres cambiar tu pedido?",
            ),
          ],
        };
      }
      if (
        /\b(PICKUP|DELIVERY|ENTREGA|RECOGER)\b/.test(answer)
      ) {
        const currentSchedule = scheduleAvailability(
          session.schedule,
          config,
        );
        return {
          session: {
            ...base,
            step: "UPDATE_FULFILLMENT",
            schedule: currentSchedule,
          },
          messages: [fulfillmentMenu(currentSchedule)],
        };
      }
      const next = { ...base, step: "UPDATE_MENU" };
      return {
        session: next,
        messages: [currentOrderMessage(next, config)],
      };
    }
    return {
      session,
      messages: [confirmedOrderReminder(session, config)],
    };
  }

  if (session.step === "CANCELED") {
    if (canceledRestartCommands.includes(answer)) {
      const next = newSession({
        chatId: session.chatId,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        config,
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
    const productKeys =
      session.menuProductKeys?.length
        ? session.menuProductKeys
        : menuProductKeys(config);
    const productOrder = productOrderFromAnswer(answer, productKeys);
    if (!productOrder) {
      const lastOption = productKeys.length + (productKeys.length > 1 ? 1 : 0);
      return {
        session,
        messages: [
          `Responde con números del 1 al ${lastOption}. Para combinar productos sepáralos por coma, por ejemplo: 1,4.`,
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
          config,
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
    const acknowledgement = quantityAcknowledgement(
      productKey,
      quantity,
      config,
    );

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
              config,
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
              config,
            ),
          ].join("\n"),
        ],
      };
    }

    const choices = scheduleOptions(
      config,
      now,
      "",
      productKeysFromQuantities(quantities),
    );
    const next = {
      ...session,
      step: "DAY",
      quantities,
      productIndex: nextIndex,
      scheduleOptions: choices,
    };
    return {
      session: next,
      messages: [orderSummary(next, config)],
    };
  }

  if (session.step === "DAY") {
    const schedule = scheduleFromAnswer(
      answer,
      config,
      now,
      session.scheduleOptions,
    );
    if (!schedule) {
      return {
        session,
        messages: [
          scheduleMenu(
            session.scheduleOptions || [],
            "Selecciona una de las fechas disponibles:",
          ),
        ],
      };
    }
    return {
      session: { ...session, step: "FULFILLMENT", schedule },
      messages: [
        [
          `✅ ${schedule.name} anotado!`,
          "",
          fulfillmentMenu(schedule),
        ].join("\n"),
      ],
    };
  }

  if (session.step === "FULFILLMENT") {
    if (answer === "1" && session.schedule.pickupAvailable) {
      const next = {
        ...session,
        step: "CONFIRMATION",
        fulfillment: {
          type: "PICKUP",
          city: "",
          deliveryFee: 0,
          pickupAddress:
            config.pickupAddress || DEFAULT_PICKUP_ADDRESS,
        },
        schedule: {
          ...session.schedule,
          timeWindow: session.schedule.pickupWindow,
        },
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
    if (answer === "2" && session.schedule.deliveryAvailable) {
      return {
        session: {
          ...session,
          step: "CITY",
          schedule: {
            ...session.schedule,
            timeWindow: session.schedule.deliveryWindow,
          },
        },
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
      messages: [fulfillmentMenu(session.schedule)],
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
      const productKeys = updateProductKeys(
        session,
        updateAction,
        config,
      );
      const next = {
        ...session,
        step: "UPDATE_PRODUCT",
        updateAction,
        updateProductKeys: productKeys,
      };
      return {
        session: next,
        messages: [
          productUpdateMenu(next, updateAction, config, productKeys),
        ],
      };
    }
    if (option === "3") {
      const choices = scheduleOptions(
        config,
        now,
        session.fulfillment?.type || "",
        productKeysFromQuantities(session.quantities),
      );
      return {
        session: {
          ...session,
          step: "UPDATE_DAY",
          updateScheduleOptions: choices,
        },
        messages: [
          scheduleMenu(
            choices,
            "📅 ¿Para qué día quieres cambiar tu pedido?",
          ),
        ],
      };
    }
    if (option === "4") {
      const currentSchedule = scheduleAvailability(
        session.schedule,
        config,
      );
      return {
        session: {
          ...session,
          step: "UPDATE_FULFILLMENT",
          schedule: currentSchedule,
        },
        messages: [
          fulfillmentMenu(currentSchedule),
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
    const productKeys =
      session.updateProductKeys ||
      updateProductKeys(session, session.updateAction, config);
    const productKey = productKeys[Number(answer) - 1] || "";
    if (!productKey) {
      return {
        session,
        messages: [
          productUpdateMenu(
            session,
            session.updateAction,
            config,
            productKeys,
          ),
        ],
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
        `¿Cuántas ${productDefinition(productKey, config).promptName} deseas ${actionText}?`,
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
          `Tu pedido tiene ${currentQuantity} ${productDefinition(productKey, config).promptName}. Escribe una cantidad menor o igual.`,
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
    const compatibleDates = scheduleOptions(
      config,
      now,
      session.fulfillment?.type || "",
      productKeysFromQuantities(quantities),
    );
    if (
      session.schedule?.date &&
      !compatibleDates.some(
        (option) => option.date === session.schedule.date,
      )
    ) {
      const rescheduled = {
        ...next,
        step: "UPDATE_DAY",
        updateScheduleOptions: compatibleDates,
      };
      return {
        session: rescheduled,
        messages: [
          scheduleMenu(
            compatibleDates,
            "Al cambiar los productos necesitamos ajustar la fecha. Estas opciones mantienen todo dentro de un día de producción:",
          ),
        ],
      };
    }
    return {
      session: next,
      messages: [updateConfirmationMessage(next, config)],
    };
  }

  if (session.step === "UPDATE_DAY") {
    const schedule = scheduleFromAnswer(
      answer,
      config,
      now,
      session.updateScheduleOptions,
    );
    if (!schedule) {
      return {
        session,
        messages: [
          scheduleMenu(
            session.updateScheduleOptions || [],
            "Selecciona una de las fechas disponibles:",
          ),
        ],
      };
    }
    const fulfillmentType = session.fulfillment?.type;
    const timeWindow =
      fulfillmentType === "PICKUP"
        ? schedule.pickupWindow
        : schedule.deliveryWindow;
    const next = {
      ...session,
      step: "UPDATE_CONFIRMATION",
      schedule: { ...schedule, timeWindow },
    };
    return {
      session: next,
      messages: [updateConfirmationMessage(next, config)],
    };
  }

  if (session.step === "UPDATE_FULFILLMENT") {
    if (answer === "1" && session.schedule.pickupAvailable) {
      const next = {
        ...session,
        step: "UPDATE_CONFIRMATION",
        fulfillment: {
          type: "PICKUP",
          city: "",
          deliveryFee: 0,
          pickupAddress:
            config.pickupAddress || DEFAULT_PICKUP_ADDRESS,
        },
        schedule: {
          ...session.schedule,
          timeWindow: session.schedule.pickupWindow,
        },
        deliveryAddress: "",
        addressType: "",
      };
      return {
        session: next,
        messages: [updateConfirmationMessage(next, config)],
      };
    }
    if (answer === "2" && session.schedule.deliveryAvailable) {
      return {
        session: {
          ...session,
          step: "UPDATE_CITY",
          schedule: {
            ...session.schedule,
            timeWindow: session.schedule.deliveryWindow,
          },
        },
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
      messages: [fulfillmentMenu(session.schedule)],
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
    .map(([productKey, quantity]) => {
      const product = productDefinition(productKey, config);
      return {
        id: product.productId || product.id,
        name: product.sheetName,
        quantity,
        price: Number(config.menuPrices[productKey] || product.price || 0) * 1000,
        currency: "CAD",
      };
    });
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
      : session.fulfillment.pickupAddress ||
        config.pickupAddress ||
        DEFAULT_PICKUP_ADDRESS;
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
    this.save();
  }

  updateByOrderId(orderId, updater) {
    let updated = false;
    for (const [chatId, session] of Object.entries(this.sessions)) {
      if (String(session.orderId) !== String(orderId)) continue;
      this.sessions[chatId] = updater({ ...session });
      updated = true;
    }
    if (updated) this.save();
    return updated;
  }

  save() {
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
  catalogProducts,
  configuredSchedules,
  menuMessage,
  newSession,
  nextWeekdayDate,
  orderSummary,
  parseDeliveryAddress,
  PRODUCTS,
  scheduleOptions,
  subtotal,
  totalPieces,
  updatedMessage,
};
