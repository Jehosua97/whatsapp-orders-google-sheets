"use strict";

const crypto = require("node:crypto");
const { isServiceClosed } = require("./admin-config");
const {
  construirBorrador,
  cotizarInterno,
  crearBorrador,
  esSiExplicito,
  hashBorrador,
  primerCampoFaltante,
  puedeGuardar,
} = require("./order-draft");
const {
  compatibleProductDates,
  dateLabel,
  torontoToday,
} = require("./product-availability");
const {
  READY_SOURCES,
  normalizeReadyRequests,
  planReadyAllocation,
} = require("./ready-inventory");

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    product_id: { type: "string", minLength: 1, maxLength: 80 },
    cantidad: { type: "integer", minimum: 0, maximum: 1000 },
  },
  required: ["product_id", "cantidad"],
};

const TOOL_SCHEMAS = [
  {
    type: "function",
    name: "consultar_fechas",
    description:
      "Calcula fechas reales compatibles para la lista completa de productos activos. Llámala después de conocer los productos y antes de proponer una fecha.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        product_ids: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
        modalidad: {
          type: "string",
          enum: ["PICKUP", "DELIVERY", "CUALQUIERA"],
        },
      },
      required: ["product_ids", "modalidad"],
    },
  },
  {
    type: "function",
    name: "consultar_pan_listo",
    description:
      "Consulta pan ya preparado para entrega hoy. Úsala solo después de conocer producto y cantidad, y únicamente si el cliente pide algo inmediato, para hoy o pregunta expresamente por pan listo.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: { type: "array", minItems: 1, maxItems: 20, items: ITEM_SCHEMA },
        modalidad: {
          type: "string",
          enum: ["PICKUP", "DELIVERY", "CUALQUIERA"],
        },
      },
      required: ["items", "modalidad"],
    },
  },
  {
    type: "function",
    name: "actualizar_borrador",
    description:
      "Valida y reemplaza el borrador. items debe contener la lista COMPLETA deseada; cantidad 0 quita un producto. Usa valores vacíos cuando el cliente aún no dio un dato.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: { type: "array", maxItems: 20, items: ITEM_SCHEMA },
        modalidad: {
          type: "string",
          enum: ["", "PICKUP", "DELIVERY"],
        },
        ciudad: {
          type: "string",
          enum: ["", "BRAMPTON", "MISSISSAUGA"],
        },
        direccion: { type: "string", maxLength: 500 },
        fecha: { type: "string", maxLength: 10 },
        preparacion: {
          type: "string",
          enum: ["FRESCO_PROGRAMADO", "PAN_LISTO_INMEDIATO"],
        },
      },
      required: [
        "items",
        "modalidad",
        "ciudad",
        "direccion",
        "fecha",
        "preparacion",
      ],
    },
  },
  {
    type: "function",
    name: "guardar_pedido",
    description:
      "Guarda el pedido únicamente después de mostrar el resumen completo y recibir una confirmación explícita en el último mensaje real del cliente.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        confirmado_por_cliente: { type: "boolean" },
      },
      required: ["confirmado_por_cliente"],
    },
  },
  {
    type: "function",
    name: "guardar_solicitud_especial",
    description:
      "Prepara o guarda una solicitud de un producto NO disponible esta semana. Primero llama con confirmado_por_cliente=false, muestra el resumen devuelto y pide confirmación.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        producto: { type: "string", minLength: 1, maxLength: 300 },
        cantidad: { type: "integer", minimum: 0, maximum: 1000 },
        fecha_texto: { type: "string", maxLength: 200 },
        modalidad: {
          type: "string",
          enum: ["", "PICKUP", "DELIVERY"],
        },
        ciudad: {
          type: "string",
          enum: ["", "BRAMPTON", "MISSISSAUGA", "OTHER"],
        },
        direccion: { type: "string", maxLength: 500 },
        confirmado_por_cliente: { type: "boolean" },
      },
      required: [
        "producto",
        "cantidad",
        "fecha_texto",
        "modalidad",
        "ciudad",
        "direccion",
        "confirmado_por_cliente",
      ],
    },
  },
  {
    type: "function",
    name: "modificar_pedido",
    description:
      "Prepara y, después de confirmar, reemplaza o cancela un pedido ya guardado. CANCELAR requiere dos confirmaciones del cliente en mensajes separados.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        order_id: { type: "string", minLength: 1, maxLength: 120 },
        accion: { type: "string", enum: ["REEMPLAZAR", "CANCELAR"] },
        items: { type: "array", maxItems: 20, items: ITEM_SCHEMA },
        modalidad: {
          type: "string",
          enum: ["", "PICKUP", "DELIVERY"],
        },
        ciudad: {
          type: "string",
          enum: ["", "BRAMPTON", "MISSISSAUGA"],
        },
        direccion: { type: "string", maxLength: 500 },
        fecha: { type: "string", maxLength: 10 },
        confirmado_por_cliente: { type: "boolean" },
      },
      required: [
        "order_id",
        "accion",
        "items",
        "modalidad",
        "ciudad",
        "direccion",
        "fecha",
        "confirmado_por_cliente",
      ],
    },
  },
  {
    type: "function",
    name: "consultar_pedido",
    description:
      "Consulta el pedido activo más reciente del cliente para contestar estado, resumen o preparar una modificación.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "escalar_a_humano",
    description:
      "Pausa el bot en este chat para que una persona atienda cuando el cliente lo pide, está molesto o el caso no puede resolverse con la información disponible.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        motivo: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["motivo"],
    },
  },
];

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return compact(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function activeCatalog(config = {}) {
  return (Array.isArray(config.catalog) ? config.catalog : []).filter(
    (product) => product?.active !== false,
  );
}

function productById(config, id, includeInactive = false) {
  const catalog = includeInactive
    ? Array.isArray(config.catalog)
      ? config.catalog
      : []
    : activeCatalog(config);
  return catalog.find(
    (product) => String(product.id) === String(id),
  );
}

function readyBatches(config, inventoryStore) {
  if (inventoryStore?.getState) {
    return inventoryStore.getState().readyInventory || [];
  }
  return Array.isArray(config.readyInventory) ? config.readyInventory : [];
}

function readyRequestKey(items) {
  return JSON.stringify(
    normalizeReadyRequests(items).sort((left, right) =>
      left.productId.localeCompare(right.productId),
    ),
  );
}

function torontoTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Toronto",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function earliestAllocationExpiry(allocations) {
  return (allocations || [])
    .map((allocation) => String(allocation.expiresAt || ""))
    .filter(Boolean)
    .sort()[0] || "";
}

function readyServiceClosed(config, date, modality) {
  return isServiceClosed(
    { closures: config.closures || [] },
    date,
    modality,
  );
}

function readyPlan(batches, items, modality, config, now) {
  const date = torontoToday(now);
  if (readyServiceClosed(config, date, modality)) {
    return {
      ok: false,
      allocations: [],
      shortages: normalizeReadyRequests(items).map((item) => ({
        productId: item.productId,
        requested: item.quantity,
        available: 0,
        missing: item.quantity,
      })),
      serviceClosed: true,
    };
  }
  return planReadyAllocation(batches, items, { now, modality });
}

function readyPlanSummary(plan, config) {
  const quantities = new Map();
  for (const allocation of plan.allocations || []) {
    quantities.set(
      allocation.productId,
      (quantities.get(allocation.productId) || 0) + allocation.quantity,
    );
  }
  return {
    completo: plan.ok === true,
    productos: plan.ok
      ? [...quantities.entries()].map(([productId, quantity]) => ({
          product_id: productId,
          nombre: String(
            productById(config, productId, true)?.name || productId,
          ),
          solicitado: quantity,
          disponible_ahora: quantity,
        }))
      : (plan.shortages || []).map((shortage) => ({
          product_id: shortage.productId,
          nombre: String(
            productById(config, shortage.productId, true)?.name ||
              shortage.productId,
          ),
          solicitado: shortage.requested,
          disponible_ahora: shortage.available,
          faltante: shortage.missing,
        })),
    servicio_cerrado: plan.serviceClosed === true,
  };
}

function latestUserPosition(session) {
  const transcript = Array.isArray(session?.transcript)
    ? session.transcript
    : [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") return index;
  }
  return -1;
}

function latestUserIndex(session) {
  const position = latestUserPosition(session);
  if (position < 0) return -1;
  const timestamp = Date.parse(session.transcript[position]?.ts || "");
  return Number.isFinite(timestamp) ? timestamp : position;
}

function latestUserMessage(session) {
  const index = latestUserPosition(session);
  return index >= 0 ? String(session.transcript[index].content || "") : "";
}

function addressAppearsInTranscript(session, address) {
  const candidate = normalized(address);
  if (!candidate || candidate.length < 4) return false;
  return (session?.transcript || []).some(
    (turn) =>
      turn?.role === "user" &&
      normalized(turn.content).includes(candidate),
  );
}

function addressType(session, address) {
  const raw = compact(address);
  if (/https?:\/\/(?:www\.)?(?:google\.[^/]+\/maps|maps\.app\.goo\.gl)|maps\.google\./i.test(raw)) {
    return "MAPS_LINK";
  }
  if (
    compact(session?.ultima_ubicacion) &&
    normalized(session.ultima_ubicacion).includes(normalized(raw))
  ) {
    return "UBICACION";
  }
  return "TEXTO";
}

function quoteWarnings(quote) {
  if (!quote.minimo_ok) {
    return [
      `El pedido tiene ${quote.piezas} pieza(s) y el mínimo es ${quote.minimo}.`,
    ];
  }
  return [];
}

function missingLabel(value) {
  return {
    ITEMS: "productos",
    MINIMO: "mínimo de piezas",
    FECHA: "fecha",
    MODALIDAD: "modalidad",
    CIUDAD: "ciudad",
    DIRECCION: "dirección",
  }[value] || String(value || "").toLowerCase();
}

function windowForDraft(session, draft) {
  const detail = (session?.fechas_detalle || []).find(
    (item) =>
      item.fecha === draft.fecha &&
      (draft.preparacion === "PAN_LISTO_INMEDIATO"
        ? item.origen === "PAN_LISTO"
        : item.origen !== "PAN_LISTO"),
  );
  if (!detail) return "";
  return draft.modalidad === "DELIVERY"
    ? detail.delivery_ventana || ""
    : draft.modalidad === "PICKUP"
      ? detail.pickup_ventana || ""
      : "";
}

function validateItems(items, config, { includeInactive = false } = {}) {
  const warnings = [];
  const valid = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const id = compact(raw?.product_id);
    const quantity = Number(raw?.cantidad);
    if (!productById(config, id, includeInactive)) {
      warnings.push(
        `${id || "Ese producto"} no existe o no está disponible esta semana.`,
      );
      continue;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      warnings.push(`La cantidad de ${id} no es válida.`);
      continue;
    }
    if (quantity > 0) valid.push({ product_id: id, cantidad: quantity });
  }
  return { valid, warnings, ok: warnings.length === 0 };
}

function configuredSchedule(config, weekday) {
  return (config.schedules || []).find(
    (schedule) =>
      schedule.active !== false && Number(schedule.weekday) === Number(weekday),
  );
}

function consultarFechas(args, session, config, now = new Date()) {
  session.pan_listo_consultado = null;
  const ids = [...new Set((args?.product_ids || []).map(compact).filter(Boolean))];
  const products = ids.map((id) => productById(config, id));
  if (!ids.length || products.some((product) => !product)) {
    session.fechas_ofrecidas = [];
    session.fechas_detalle = [];
    return {
      fechas: [],
      error: "Uno o más productos no existen o no están disponibles esta semana.",
    };
  }
  const modality = ["PICKUP", "DELIVERY", "CUALQUIERA"].includes(
    args?.modalidad,
  )
    ? args.modalidad
    : "CUALQUIERA";
  const dates = compatibleProductDates(products, now, {
    limit: 180,
    lookaheadDays: 365,
  });
  const result = [];
  for (const availability of dates) {
    const schedule = configuredSchedule(config, availability.weekday);
    if (!schedule) continue;
    const pickupAvailable =
      schedule.pickupEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        availability.date,
        "PICKUP",
      );
    const deliveryAvailable =
      schedule.deliveryEnabled !== false &&
      !isServiceClosed(
        { closures: config.closures || [] },
        availability.date,
        "DELIVERY",
      );
    if (modality === "PICKUP" && !pickupAvailable) continue;
    if (modality === "DELIVERY" && !deliveryAvailable) continue;
    if (modality === "CUALQUIERA" && !pickupAvailable && !deliveryAvailable) {
      continue;
    }
    result.push({
      fecha: availability.date,
      etiqueta: dateLabel(availability.date),
      origen: "PROGRAMADO",
      pickup_disponible: pickupAvailable,
      pickup_ventana: pickupAvailable ? String(schedule.pickupWindow || "") : "",
      delivery_disponible: deliveryAvailable,
      delivery_ventana: deliveryAvailable
        ? String(schedule.deliveryWindow || "")
        : "",
    });
    if (result.length >= 3) break;
  }
  session.fechas_ofrecidas = result.map((item) => item.fecha);
  session.fechas_detalle = result;
  return { fechas: result };
}

function consultarPanListo(
  args,
  session,
  config,
  inventoryStore,
  now = new Date(),
) {
  const items = normalizeReadyRequests(args?.items);
  const unknown = items.filter(
    (item) => !productById(config, item.productId, true),
  );
  if (!items.length || unknown.length) {
    session.pan_listo_consultado = null;
    return {
      disponible_hoy: false,
      error: "Uno o más productos no existen en el catálogo.",
    };
  }

  const batches = readyBatches(config, inventoryStore);
  const pickup = readyPlan(batches, items, "PICKUP", config, now);
  const delivery = readyPlan(batches, items, "DELIVERY", config, now);
  const modality = ["PICKUP", "DELIVERY", "CUALQUIERA"].includes(
    args?.modalidad,
  )
    ? args.modalidad
    : "CUALQUIERA";
  const selected = modality === "PICKUP" ? pickup : modality === "DELIVERY" ? delivery : null;
  const date = torontoToday(now);
  const expiry = selected?.ok
    ? earliestAllocationExpiry(selected.allocations)
    : "";
  const window = expiry ? `Disponible hoy hasta las ${torontoTime(expiry)}` : "";

  session.pan_listo_consultado =
    selected?.ok === true
      ? {
          items_key: readyRequestKey(items),
          modalidad: modality,
          fecha: date,
          ventana: window,
          expires_at: expiry,
          consultado_en: now.toISOString(),
        }
      : null;
  if (selected?.ok === true) {
    session.fechas_ofrecidas = [
      ...new Set([...(session.fechas_ofrecidas || []), date]),
    ];
    session.fechas_detalle = [
      ...(session.fechas_detalle || []).filter(
        (detail) => !(detail.fecha === date && detail.origen === "PAN_LISTO"),
      ),
      {
        fecha: date,
        etiqueta: "Hoy",
        origen: "PAN_LISTO",
        pickup_disponible: modality === "PICKUP",
        pickup_ventana: modality === "PICKUP" ? window : "",
        delivery_disponible: modality === "DELIVERY",
        delivery_ventana: modality === "DELIVERY" ? window : "",
      },
    ];
  }

  return {
    fecha: date,
    disponible_hoy: pickup.ok || delivery.ok,
    pedido_completo_disponible:
      selected?.ok === true ||
      (modality === "CUALQUIERA" && (pickup.ok || delivery.ok)),
    pickup: readyPlanSummary(pickup, config),
    delivery: readyPlanSummary(delivery, config),
    modalidad_seleccionada: modality,
    ventana: window,
    regla:
      "No reduzcas la cantidad solicitada ni mezcles pan listo con producción nueva. Si no alcanza, ofrece el pedido completo fresco para una fecha programada; menciona la cantidad parcial solo si el cliente pidió expresamente una opción para hoy.",
  };
}

function actualizarBorrador(args, session, config) {
  const warnings = [];
  const current = session.draft || crearBorrador();
  if (session.estado === "CERRADA" && current.order_id) {
    const quote = cotizarInterno(current, config);
    return {
      borrador: current,
      cotizacion: quote,
      completo: true,
      faltante: [],
      advertencias: [
        "Ese pedido ya está guardado; usa modificar_pedido para cambiarlo.",
      ],
    };
  }

  const requestedPreparation = [
    "FRESCO_PROGRAMADO",
    "PAN_LISTO_INMEDIATO",
  ].includes(args?.preparacion)
    ? args.preparacion
    : current.preparacion || "FRESCO_PROGRAMADO";
  const requestedModality = ["PICKUP", "DELIVERY"].includes(args?.modalidad)
    ? args.modalidad
    : current.modalidad;
  const candidateItems = validateItems(args?.items, config, {
    includeInactive: requestedPreparation === "PAN_LISTO_INMEDIATO",
  });
  const consultation = session.pan_listo_consultado;
  const readyApproved =
    requestedPreparation !== "PAN_LISTO_INMEDIATO" ||
    (candidateItems.ok &&
      consultation &&
      consultation.modalidad === requestedModality &&
      consultation.items_key === readyRequestKey(candidateItems.valid));
  if (!readyApproved) {
    warnings.push(
      "Primero consulta nuevamente el pan listo para la cantidad y modalidad completas; no se activó la entrega inmediata.",
    );
  }
  const effectivePreparation = readyApproved
    ? requestedPreparation
    : current.preparacion || "FRESCO_PROGRAMADO";
  const itemResult = readyApproved
    ? candidateItems
    : validateItems(args?.items, config, {
        includeInactive: effectivePreparation === "PAN_LISTO_INMEDIATO",
      });
  warnings.push(...itemResult.warnings);
  const patch = {};
  if (itemResult.ok) patch.items = itemResult.valid;
  if (readyApproved) patch.preparacion = effectivePreparation;

  if (["PICKUP", "DELIVERY"].includes(args?.modalidad)) {
    patch.modalidad = args.modalidad;
  }
  if (["BRAMPTON", "MISSISSAUGA"].includes(args?.ciudad)) {
    patch.ciudad = args.ciudad;
  }
  if (compact(args?.direccion)) {
    if (addressAppearsInTranscript(session, args.direccion)) {
      patch.direccion = compact(args.direccion);
      patch.direccion_tipo = addressType(session, args.direccion);
    } else {
      warnings.push(
        "La dirección no aparece en ningún mensaje del cliente y no se aplicó.",
      );
    }
  }
  if (
    effectivePreparation === "PAN_LISTO_INMEDIATO" &&
    readyApproved &&
    consultation
  ) {
    patch.fecha = consultation.fecha;
  } else if (compact(args?.fecha)) {
    const scheduledDetail = (session.fechas_detalle || []).find(
      (detail) =>
        detail.fecha === compact(args.fecha) && detail.origen !== "PAN_LISTO",
    );
    if (scheduledDetail) {
      patch.fecha = compact(args.fecha);
    } else {
      warnings.push(
        "La fecha no fue devuelta por consultar_fechas y no se aplicó.",
      );
    }
  } else if (
    effectivePreparation === "FRESCO_PROGRAMADO" &&
    current.preparacion === "PAN_LISTO_INMEDIATO"
  ) {
    patch.fecha = "";
  }

  let next = construirBorrador(current, patch);
  next = construirBorrador(next, { ventana: windowForDraft(session, next) });
  const changed = hashBorrador(next) !== hashBorrador(current);
  if (changed) {
    session.firma_resumen = "";
    session.firma_resumen_turno = -1;
  }
  session.draft = next;
  session.estado = "ABIERTA";

  let quote;
  try {
    quote = cotizarInterno(next, config);
  } catch (error) {
    warnings.push(error.message);
    quote = {
      lineas: [],
      piezas: 0,
      minimo: Number(config.minimumOrderPieces || 0),
      minimo_ok: false,
      subtotal: 0,
      envio: 0,
      total: 0,
      moneda: "CAD",
    };
  }
  warnings.push(...quoteWarnings(quote));
  const missing = primerCampoFaltante(next, config);
  const complete = !missing;
  if (complete) {
    const signature = hashBorrador(next);
    if (session.firma_resumen !== signature) {
      session.firma_resumen = signature;
      session.firma_resumen_turno = latestUserIndex(session);
    }
    session.ultima_cotizacion = quote;
  }
  return {
    borrador: next,
    cotizacion: quote,
    completo: complete,
    faltante: missing ? [missingLabel(missing)] : [],
    advertencias: [...new Set(warnings)],
  };
}

function orderId(prefix = "AI", now = new Date()) {
  return `${prefix}-${now.getTime()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function buildOrderFromDraft(session, config, options = {}) {
  const now = options.now || new Date();
  const receivedAt = now.toISOString();
  const draft = session.draft;
  const quote = cotizarInterno(draft, config);
  const id = options.orderId || draft.order_id || orderId("AI", now);
  const itemSource =
    draft.preparacion === "PAN_LISTO_INMEDIATO"
      ? READY_SOURCES.READY
      : READY_SOURCES.FRESH;
  const products = quote.lineas.map((line) => {
    const product = productById(
      config,
      line.product_id,
      draft.preparacion === "PAN_LISTO_INMEDIATO",
    );
    return {
      receivedAt,
      orderId: id,
      productId: String(product.productId || product.id),
      productName: String(product.sheetName || product.name || product.id),
      quantity: line.cantidad,
      unitPrice: line.precio_unitario,
      currency: quote.moneda,
      lineTotal: line.subtotal,
      isLogistics: false,
      source: itemSource,
    };
  });
  products.push({
    receivedAt,
    orderId: id,
    productId:
      draft.modalidad === "PICKUP"
        ? "pickup"
        : `delivery-${draft.ciudad.toLowerCase()}`,
    productName:
      draft.modalidad === "PICKUP"
        ? "Recoger"
        : `Delivery en ${draft.ciudad === "BRAMPTON" ? "Brampton" : "Mississauga"}`,
    quantity: 1,
    unitPrice: quote.envio,
    currency: quote.moneda,
    lineTotal: quote.envio,
    isLogistics: true,
    source: READY_SOURCES.LOGISTICS,
  });
  return {
    summary: {
      receivedAt,
      orderId: id,
      phone: String(session.customerPhone || ""),
      customerName: String(session.customerName || ""),
      currency: quote.moneda,
      subtotal: quote.subtotal,
      total: quote.subtotal,
      status: "NUEVO",
      messageId: String(session.lastMessageId || ""),
      chatId: String(session.chatId || ""),
      fulfillmentType: draft.modalidad,
      city: draft.modalidad === "DELIVERY" ? draft.ciudad : "",
      address:
        draft.modalidad === "DELIVERY"
          ? draft.direccion
          : String(config.pickupAddress || ""),
      postalCode: "",
      requestedDate: draft.fecha,
      timeWindow: draft.ventana,
      deliveryFee: quote.envio,
      grandTotal: quote.total,
      scheduleStatus: "CONFIRMADO",
      latitude: "",
      longitude: "",
      updatedAt: receivedAt,
      customerNotes:
        draft.preparacion === "PAN_LISTO_INMEDIATO"
          ? "Pedido tomado por el agente de ventas | PAN LISTO: surtir de inventario; no producir"
          : "Pedido tomado por el agente de ventas | PRODUCCIÓN NUEVA",
      productSummary: quote.lineas
        .map((line) => `${line.cantidad} x ${line.nombre}`)
        .join(", "),
      fulfillmentConflict: false,
      kitchenStatus: "Confirmado",
    },
    items: products,
  };
}

function customerSummary(session, quote = session.ultima_cotizacion) {
  const draft = session.draft;
  if (!draft || !quote) return "";
  return [
    ...quote.lineas.map(
      (line) =>
        `${line.cantidad} x ${line.nombre} ($${line.subtotal.toFixed(2)})`,
    ),
    `Fecha: ${draft.fecha}`,
    `Horario: ${draft.ventana}`,
    `Preparación: ${
      draft.preparacion === "PAN_LISTO_INMEDIATO"
        ? "pan listo para hoy"
        : "producción nueva y fresca"
    }`,
    `Modalidad: ${draft.modalidad}`,
    draft.modalidad === "DELIVERY" && `Dirección: ${draft.direccion}`,
    `Subtotal: $${quote.subtotal.toFixed(2)} CAD`,
    `Envío: $${quote.envio.toFixed(2)} CAD`,
    `Total: $${quote.total.toFixed(2)} CAD`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function guardarPedido(
  args,
  session,
  config,
  store,
  inventoryStore,
  now = new Date(),
) {
  if (args?.confirmado_por_cliente !== true) {
    return { guardado: false, motivo: "SIN_CONFIRMACION_EXPLICITA" };
  }
  const lastUser = latestUserMessage(session);
  const quote = session.ultima_cotizacion || {};
  const gate = puedeGuardar(session, lastUser, quote, config);
  if (!gate.ok) return { guardado: false, motivo: gate.motivo };
  if (
    Number(session.firma_resumen_turno) >= 0 &&
    latestUserIndex(session) <= Number(session.firma_resumen_turno)
  ) {
    return { guardado: false, motivo: "RESUMEN_DESACTUALIZADO" };
  }
  const newOrderId = session.draft.order_id || orderId("AI", now);
  let reservation = null;
  if (session.draft.preparacion === "PAN_LISTO_INMEDIATO") {
    if (!inventoryStore?.reserveReadyInventory) {
      return { guardado: false, motivo: "PAN_LISTO_NO_DISPONIBLE" };
    }
    reservation = inventoryStore.reserveReadyInventory(
      session.draft.items,
      newOrderId,
      { now, modality: session.draft.modalidad },
    );
    if (!reservation.ok) {
      session.firma_resumen = "";
      session.firma_resumen_turno = -1;
      session.pan_listo_consultado = null;
      return {
        guardado: false,
        motivo: "PAN_LISTO_CAMBIO_DE_DISPONIBILIDAD",
        faltantes: reservation.shortages || [],
        siguiente_paso:
          "Explica que cambió la disponibilidad y ofrece preparar el pedido completo fresco en una fecha programada.",
      };
    }
  }
  const order = buildOrderFromDraft(session, config, {
    now,
    orderId: newOrderId,
  });
  let saved;
  try {
    saved = await store.saveOrder(order);
  } catch (error) {
    if (reservation?.ok) {
      inventoryStore.rollbackReadyInventory?.(newOrderId, now);
    }
    throw error;
  }
  if (reservation?.ok) {
    inventoryStore.commitReadyInventory?.(newOrderId, now);
  }
  session.draft = construirBorrador(session.draft, {
    order_id: order.summary.orderId,
  });
  session.estado = "CERRADA";
  session.lastActivity = now.toISOString();
  return {
    guardado: saved?.inserted !== false || Boolean(order.summary.orderId),
    order_id: order.summary.orderId,
    resumen_cliente: customerSummary(session, quote),
    preparacion: session.draft.preparacion,
  };
}

function specialPayload(args) {
  return {
    producto: compact(args?.producto),
    cantidad: Math.max(0, Math.floor(Number(args?.cantidad) || 0)),
    fecha_texto: compact(args?.fecha_texto),
    modalidad: ["PICKUP", "DELIVERY"].includes(args?.modalidad)
      ? args.modalidad
      : "",
    ciudad: ["BRAMPTON", "MISSISSAUGA", "OTHER"].includes(args?.ciudad)
      ? args.ciudad
      : "",
    direccion: compact(args?.direccion),
  };
}

function specialMissing(request) {
  if (!request.producto) return "PRODUCTO";
  if (!(request.cantidad > 0)) return "CANTIDAD";
  if (!request.fecha_texto) return "FECHA";
  if (!request.modalidad) return "MODALIDAD";
  if (request.modalidad === "DELIVERY" && !request.ciudad) return "CIUDAD";
  if (request.modalidad === "DELIVERY" && !request.direccion) return "DIRECCION";
  return "";
}

function specialSummary(request) {
  return [
    `Producto especial: ${request.producto}`,
    `Cantidad: ${request.cantidad}`,
    `Fecha solicitada: ${request.fecha_texto}`,
    `Modalidad: ${request.modalidad}${request.ciudad ? ` en ${request.ciudad}` : ""}`,
    request.direccion && `Dirección: ${request.direccion}`,
    "Precio, disponibilidad y horario: por confirmar por el administrador.",
  ]
    .filter(Boolean)
    .join("\n");
}

function activeProductMatches(value, config) {
  const wanted = normalized(value);
  return activeCatalog(config).some((product) => {
    const values = [product.id, product.name, product.promptName]
      .map(normalized)
      .filter(Boolean);
    return values.some(
      (candidate) =>
        candidate === wanted ||
        (candidate.length >= 4 && wanted.includes(candidate)),
    );
  });
}

function buildSpecialOrder(request, session, now = new Date()) {
  const receivedAt = now.toISOString();
  const id = request.order_id || orderId("SPECIAL", now);
  return {
    summary: {
      receivedAt,
      orderId: id,
      phone: String(session.customerPhone || ""),
      customerName: String(session.customerName || ""),
      currency: "CAD",
      subtotal: "",
      total: "",
      status: "REVISION_MANUAL",
      messageId: String(session.lastMessageId || ""),
      chatId: String(session.chatId || ""),
      fulfillmentType: request.modalidad,
      city: request.ciudad,
      address: request.direccion,
      postalCode: "",
      requestedDate: request.fecha_texto,
      timeWindow: "",
      deliveryFee: "",
      grandTotal: "",
      scheduleStatus: "PENDIENTE_ADMIN",
      latitude: "",
      longitude: "",
      updatedAt: receivedAt,
      customerNotes:
        "Solicitud especial tomada por el agente; precio, disponibilidad y horario por confirmar",
      productSummary: `${request.cantidad} x ${request.producto}`,
      fulfillmentConflict: false,
      kitchenStatus: "Por confirmar",
    },
    items: [
      {
        receivedAt,
        orderId: id,
        productId: `especial-${normalized(request.producto).replace(/\s+/g, "-").slice(0, 60) || "producto"}`,
        productName: request.producto,
        quantity: request.cantidad,
        unitPrice: "",
        currency: "CAD",
        lineTotal: "",
        isLogistics: false,
      },
    ],
  };
}

async function guardarSolicitudEspecial(args, session, config, store) {
  const request = specialPayload(args);
  const missing = specialMissing(request);
  if (missing) return { guardado: false, motivo: `FALTA_${missing}` };
  if (activeProductMatches(request.producto, config)) {
    return { guardado: false, motivo: "PRODUCTO_DISPONIBLE_EN_CATALOGO" };
  }
  if (
    request.modalidad === "DELIVERY" &&
    !addressAppearsInTranscript(session, request.direccion)
  ) {
    return { guardado: false, motivo: "DIRECCION_NO_ESCRITA_POR_CLIENTE" };
  }
  const signature = crypto
    .createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
  const summary = specialSummary(request);
  const priorSignature = session.firma_resumen_especial;
  if (priorSignature !== signature) {
    session.solicitud_especial = request;
    session.firma_resumen_especial = signature;
    session.firma_resumen_especial_turno = latestUserIndex(session);
    return {
      guardado: false,
      motivo: "RESUMEN_ESPECIAL_REQUIERE_CONFIRMACION",
      resumen_cliente: summary,
    };
  }
  if (args?.confirmado_por_cliente !== true || !esSiExplicito(latestUserMessage(session))) {
    return {
      guardado: false,
      motivo: "SIN_CONFIRMACION_EXPLICITA",
      resumen_cliente: summary,
    };
  }
  if (
    latestUserIndex(session) <=
    Number(session.firma_resumen_especial_turno ?? -1)
  ) {
    return {
      guardado: false,
      motivo: "RESUMEN_DESACTUALIZADO",
      resumen_cliente: summary,
    };
  }
  const order = buildSpecialOrder(request, session);
  await store.saveOrder(order);
  session.solicitud_especial = {
    ...request,
    order_id: order.summary.orderId,
  };
  session.estado = "CERRADA";
  session.draft.order_id = order.summary.orderId;
  return {
    guardado: true,
    order_id: order.summary.orderId,
    resumen_cliente: summary,
  };
}

function orderClosed(order) {
  const statuses = [order?.status, order?.kitchenStatus].map((value) =>
    compact(value).toUpperCase(),
  );
  return statuses.some((value) => ["CANCELADO", "ENTREGADO"].includes(value));
}

async function consultarPedido(_args, session, _config, store) {
  let order = await store.getPendingOrderByChat?.(session.chatId);
  if (!order && session.draft?.order_id && store.getOrder) {
    order = await store.getOrder(session.draft.order_id);
  }
  if (!order && store.listOrders) {
    const orders = await store.listOrders();
    order = orders.find(
      (candidate) =>
        candidate.chatId === session.chatId && !orderClosed(candidate),
    );
  }
  if (!order) return { tiene_pedido: false };
  return {
    tiene_pedido: true,
    order_id: String(order.orderId || ""),
    estado: String(order.kitchenStatus || order.status || ""),
    resumen: String(order.productSummary || ""),
    fecha: String(order.requestedDate || ""),
    modalidad: String(order.fulfillmentType || ""),
    ciudad: String(order.city || ""),
    direccion: String(order.address || ""),
    total: order.grandTotal ?? order.total ?? "",
  };
}

function modificationPayload(args, config, session) {
  if (args.accion === "CANCELAR") {
    return { order_id: compact(args.order_id), accion: "CANCELAR" };
  }
  const validated = validateItems(args.items, config);
  if (!validated.ok) return { error: validated.warnings.join(" ") };
  const draft = construirBorrador(crearBorrador(), {
    items: validated.valid,
    modalidad: args.modalidad,
    ciudad: args.ciudad,
    direccion: args.direccion,
    direccion_tipo: addressType(session, args.direccion),
    fecha: args.fecha,
    origen: "TEXTO",
    order_id: compact(args.order_id),
  });
  draft.ventana = windowForDraft(session, draft);
  return { order_id: compact(args.order_id), accion: "REEMPLAZAR", draft };
}

async function modificarPedido(args, session, config, store) {
  const existing = await store.getOrder?.(args.order_id);
  if (!existing || existing.chatId !== session.chatId) {
    return { actualizado: false, motivo: "PEDIDO_NO_ENCONTRADO" };
  }
  if (orderClosed(existing)) {
    return { actualizado: false, motivo: "PEDIDO_YA_CERRADO" };
  }
  if (
    args?.accion === "REEMPLAZAR" &&
    /PAN LISTO/i.test(String(existing.customerNotes || ""))
  ) {
    return {
      actualizado: false,
      motivo: "PEDIDO_PAN_LISTO_REQUIERE_ADMIN",
      siguiente_paso:
        "Escala la modificación a una persona. No devuelvas inventario ni prometas piezas nuevas automáticamente.",
    };
  }
  const payload = modificationPayload(args, config, session);
  if (payload.error) return { actualizado: false, motivo: payload.error };
  if (payload.accion === "REEMPLAZAR") {
    if (
      payload.draft.modalidad === "DELIVERY" &&
      !addressAppearsInTranscript(session, payload.draft.direccion)
    ) {
      return { actualizado: false, motivo: "DIRECCION_NO_ESCRITA_POR_CLIENTE" };
    }
    if (!(session.fechas_ofrecidas || []).includes(payload.draft.fecha)) {
      return { actualizado: false, motivo: "FECHA_NO_OFRECIDA" };
    }
    const missing = primerCampoFaltante(payload.draft, config);
    if (missing) return { actualizado: false, motivo: `FALTA_${missing}` };
    payload.quote = cotizarInterno(payload.draft, config);
  }
  const signature = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const currentTurn = latestUserIndex(session);
  if (session.modificacion_pendiente?.firma !== signature) {
    session.modificacion_pendiente = {
      ...payload,
      firma: signature,
      resumen_turno: currentTurn,
      primera_confirmacion_turno: -1,
    };
    return {
      actualizado: false,
      motivo:
        payload.accion === "CANCELAR"
          ? "CONFIRMACION_DE_CANCELACION_REQUERIDA"
          : "CONFIRMACION_REQUERIDA",
      resumen_cliente:
        payload.accion === "CANCELAR"
          ? `Se cancelará el pedido ${payload.order_id}.`
          : customerSummary({ draft: payload.draft }, payload.quote),
    };
  }
  const pending = session.modificacion_pendiente;
  if (args.confirmado_por_cliente !== true || !esSiExplicito(latestUserMessage(session))) {
    return { actualizado: false, motivo: "SIN_CONFIRMACION_EXPLICITA" };
  }
  if (currentTurn <= pending.resumen_turno) {
    return { actualizado: false, motivo: "RESUMEN_DESACTUALIZADO" };
  }
  if (payload.accion === "CANCELAR") {
    if (pending.primera_confirmacion_turno < 0) {
      pending.primera_confirmacion_turno = currentTurn;
      return {
        actualizado: false,
        motivo: "SEGUNDA_CONFIRMACION_REQUERIDA",
      };
    }
    if (currentTurn <= pending.primera_confirmacion_turno) {
      return {
        actualizado: false,
        motivo: "SEGUNDA_CONFIRMACION_REQUERIDA",
      };
    }
    await store.updateOrder(payload.order_id, {
      status: "CANCELADO",
      kitchenStatus: "Cancelado",
    });
    session.estado = "CERRADA";
    delete session.modificacion_pendiente;
    return { actualizado: true, cancelado: true, order_id: payload.order_id };
  }
  const replacementSession = {
    ...session,
    draft: payload.draft,
    ultima_cotizacion: payload.quote,
  };
  const order = buildOrderFromDraft(replacementSession, config);
  await store.replaceOrder(order);
  session.draft = payload.draft;
  session.ultima_cotizacion = payload.quote;
  session.estado = "CERRADA";
  delete session.modificacion_pendiente;
  return {
    actualizado: true,
    cancelado: false,
    order_id: payload.order_id,
    resumen_cliente: customerSummary(session, payload.quote),
  };
}

function escalarAHumano(args, session, _config, _store, pauseState) {
  pauseState?.pause?.(session.chatId);
  session.estado = "PAUSADA";
  session.motivo_pausa = compact(args?.motivo);
  return { escalado: true };
}

async function executeTool(name, args, context) {
  const { session, config, store, inventoryStore, pauseState, now } = context;
  if (name === "consultar_fechas") {
    return consultarFechas(args, session, config, now || new Date());
  }
  if (name === "consultar_pan_listo") {
    return consultarPanListo(
      args,
      session,
      config,
      inventoryStore,
      now || new Date(),
    );
  }
  if (name === "actualizar_borrador") {
    return actualizarBorrador(args, session, config);
  }
  if (name === "guardar_pedido") {
    return guardarPedido(
      args,
      session,
      config,
      store,
      inventoryStore,
      now || new Date(),
    );
  }
  if (name === "guardar_solicitud_especial") {
    return guardarSolicitudEspecial(args, session, config, store);
  }
  if (name === "modificar_pedido") {
    return modificarPedido(args, session, config, store);
  }
  if (name === "consultar_pedido") {
    return consultarPedido(args, session, config, store);
  }
  if (name === "escalar_a_humano") {
    return escalarAHumano(args, session, config, store, pauseState);
  }
  return { error: `Herramienta desconocida: ${name}` };
}

async function guardarSolicitudSuelta(store, session, customerMessage, now = new Date()) {
  const day = torontoToday(now);
  const digest = crypto
    .createHash("sha256")
    .update(`${session.chatId}|${day}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  const id = `MANUAL-${day}-${digest}`;
  const current = await store.getOrder?.(id);
  if (current) {
    const note = [current.customerNotes, compact(customerMessage)]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 4000);
    await store.updateOrder?.(id, { customerNotes: note });
    return { inserted: false, order_id: id };
  }
  const request = {
    producto: "Mensaje de WhatsApp para revisión",
    cantidad: 1,
    fecha_texto: "Por confirmar",
    modalidad: "",
    ciudad: "",
    direccion: "",
    order_id: id,
  };
  const order = buildSpecialOrder(request, session, now);
  order.summary.customerNotes = `OpenAI no disponible | Mensaje: ${compact(customerMessage)}`;
  order.summary.productSummary = "Solicitud recibida por WhatsApp";
  order.items[0].productName = "Solicitud recibida por WhatsApp";
  const saved = await store.saveOrder(order);
  return { ...saved, order_id: id };
}

module.exports = {
  TOOL_SCHEMAS,
  activeCatalog,
  actualizarBorrador,
  addressAppearsInTranscript,
  buildOrderFromDraft,
  buildSpecialOrder,
  consultarFechas,
  consultarPanListo,
  consultarPedido,
  customerSummary,
  escalarAHumano,
  executeTool,
  guardarPedido,
  guardarSolicitudEspecial,
  guardarSolicitudSuelta,
  latestUserIndex,
  latestUserMessage,
  modificarPedido,
  orderClosed,
  orderId,
};
