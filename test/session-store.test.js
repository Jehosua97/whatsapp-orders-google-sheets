const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ConversationStateStore,
  SESSION_STATES,
  newSession,
} = require("../src/session-store");

function temporaryState(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lacenaduria-session-store-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    file: path.join(directory, "sessions.json"),
  };
}

test("crea el estado ligero sin pasos ni datos del flujo anterior", () => {
  const session = newSession({
    chatId: "customer@c.us",
    customerName: "Ana",
    customerPhone: "14370000000",
    now: new Date("2026-08-28T15:00:00.000Z"),
  });

  assert.deepEqual(session, {
    chatId: "customer@c.us",
    customerName: "Ana",
    customerPhone: "14370000000",
    estado: "ABIERTA",
    draft: {
      items: [],
      modalidad: "",
      ciudad: "",
      direccion: "",
      direccion_tipo: "",
      fecha: "",
      ventana: "",
      preparacion: "FRESCO_PROGRAMADO",
      origen: "TEXTO",
      order_id: "",
    },
    fechas_ofrecidas: [],
    fechas_detalle: [],
    firma_resumen: "",
    firma_resumen_turno: -1,
    ultima_cotizacion: null,
    pan_listo_consultado: null,
    solicitud_especial: null,
    firma_resumen_especial: "",
    firma_resumen_especial_turno: -1,
    modificacion_pendiente: null,
    ultima_ubicacion: "",
    lastMessageId: "",
    motivo_pausa: "",
    transcript: [],
    lastActivity: "2026-08-28T15:00:00.000Z",
  });
  assert.equal(Object.hasOwn(session, "step"), false);
  assert.equal(Object.hasOwn(session, "cartOrder"), false);
});

test("persiste de forma atómica y conserva solamente los últimos turnos", (t) => {
  const { directory, file } = temporaryState(t);
  const now = new Date("2026-08-28T15:05:00.000Z");
  const store = new ConversationStateStore(file, {
    now: () => now,
    transcriptTurns: 3,
  });
  const session = newSession("customer@c.us", { now });
  session.draft = {
    ...session.draft,
    items: [{ product_id: "chocolate", cantidad: 6 }],
    direccion: " 15 Appleby Dr, Brampton ",
  };
  session.transcript = [
    { role: "user", content: "Hola", ts: "2026-08-28T15:01:00Z" },
    {
      role: "assistant",
      content: "Hola, ¿qué te preparo?",
      ts: "2026-08-28T15:02:00Z",
    },
    {
      role: "user",
      content: "Conchas",
      ts: "2026-08-28T15:03:00Z",
    },
    {
      role: "assistant",
      content: "¿Cuántas?",
      ts: "2026-08-28T15:04:00Z",
    },
  ];

  store.set(session.chatId, session);
  const reloaded = new ConversationStateStore(file, {
    now: () => now,
    transcriptTurns: 3,
  }).get(session.chatId);

  assert.deepEqual(
    reloaded.transcript.map((turn) => turn.content),
    ["Hola, ¿qué te preparo?", "Conchas", "¿Cuántas?"],
  );
  assert.equal(reloaded.draft.direccion, " 15 Appleby Dr, Brampton ");
  assert.equal(reloaded.lastActivity, "2026-08-28T15:05:00.000Z");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[session.chatId].estado, "ABIERTA");
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("elimina sesiones abiertas y pausadas vencidas pero conserva cerradas", (t) => {
  const { file } = temporaryState(t);
  let now = new Date("2026-08-28T12:00:00.000Z");
  const options = {
    now: () => now,
    pendingTimeoutMs: 60 * 60 * 1000,
  };
  const store = new ConversationStateStore(file, options);
  store.set("open@c.us", newSession("open@c.us", { now }));
  store.set("paused@c.us", {
    ...newSession("paused@c.us", { now }),
    estado: SESSION_STATES.PAUSED,
  });
  store.set("closed@c.us", {
    ...newSession("closed@c.us", { now }),
    estado: SESSION_STATES.CLOSED,
  });

  now = new Date("2026-08-28T14:00:00.000Z");
  const recovered = new ConversationStateStore(file, options);

  assert.equal(recovered.get("open@c.us"), null);
  assert.equal(recovered.get("paused@c.us"), null);
  assert.equal(recovered.get("closed@c.us").estado, "CERRADA");
  assert.equal(recovered.lastRecoveryReport.clearedSessions, 2);
  assert.deepEqual(recovered.healthSummary(), {
    total: 1,
    pending: 0,
  });
});

test("migra una conversación de texto anterior y poda el autómata", (t) => {
  const { file } = temporaryState(t);
  fs.writeFileSync(
    file,
    JSON.stringify({
      "legacy@c.us": {
        orderId: "CHAT-NO-GUARDADO",
        chatId: "legacy@c.us",
        customerName: "Edgar",
        customerPhone: "14370000001",
        step: "DAY",
        quantities: { vanilla: 7, chocolate: 6 },
        productOrder: ["chocolate", "vanilla"],
        schedule: null,
        scheduleOptions: [
          { date: "2026-08-29" },
          { date: "2026-09-02" },
          { date: "fecha-inválida" },
        ],
        fulfillment: null,
        deliveryAddress: "",
        addressType: "",
        createdAt: "2026-08-28T15:00:00.000Z",
        stateUpdatedAt: "2026-08-28T15:30:00.000Z",
      },
    }),
  );
  const store = new ConversationStateStore(file, {
    now: () => new Date("2026-08-28T16:00:00.000Z"),
  });
  const migrated = store.get("legacy@c.us");

  assert.equal(migrated.estado, "ABIERTA");
  assert.equal(migrated.customerName, "Edgar");
  assert.equal(migrated.customerPhone, "14370000001");
  assert.deepEqual(migrated.draft.items, [
    { product_id: "chocolate", cantidad: 6 },
    { product_id: "vanilla", cantidad: 7 },
  ]);
  assert.equal(migrated.draft.order_id, "");
  assert.deepEqual(migrated.fechas_ofrecidas, [
    "2026-08-29",
    "2026-09-02",
  ]);
  assert.equal(migrated.lastActivity, "2026-08-28T15:30:00.000Z");
  assert.equal(Object.hasOwn(migrated, "step"), false);
  assert.equal(Object.hasOwn(migrated, "quantities"), false);
  assert.equal(store.lastRecoveryReport.migratedSessions, 1);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8"))["legacy@c.us"], "step"), false);
});

test("migra un carrito guardado a draft y conserva su order id", (t) => {
  const { file } = temporaryState(t);
  fs.writeFileSync(
    file,
    JSON.stringify({
      "cart@c.us": {
        chatId: "cart@c.us",
        source: "CART",
        orderId: "WA-CART-123",
        step: "CART_COMPLETED",
        cartOrder: {
          items: [
            { productId: "chocolate", quantity: 5 },
            { productId: "vanilla", quantity: 2 },
          ],
        },
        fulfillment: { type: "DELIVERY", city: "BRAMPTON" },
        deliveryAddress: "15 Appleby Dr, Brampton",
        addressType: "ADDRESS",
        schedule: {
          date: "2026-08-29",
          timeWindow: "después de las 3 PM",
        },
        stateUpdatedAt: "2026-08-28T15:30:00.000Z",
      },
    }),
  );

  const migrated = new ConversationStateStore(file, {
    now: () => new Date("2026-08-30T16:00:00.000Z"),
    pendingTimeoutMs: 60 * 60 * 1000,
  }).get("cart@c.us");

  assert.equal(migrated.estado, "CERRADA");
  assert.equal(migrated.chatId, "cart@c.us");
  assert.deepEqual(migrated.draft.items, [
    { product_id: "chocolate", cantidad: 5 },
    { product_id: "vanilla", cantidad: 2 },
  ]);
  assert.equal(migrated.draft.modalidad, "DELIVERY");
  assert.equal(migrated.draft.ciudad, "BRAMPTON");
  assert.equal(migrated.draft.direccion_tipo, "TEXTO");
  assert.equal(migrated.draft.origen, "CARRITO");
  assert.equal(migrated.draft.order_id, "WA-CART-123");
  assert.equal(Object.hasOwn(migrated, "cartOrder"), false);
});

test("updateByOrderId actualiza el draft correcto y lo persiste", (t) => {
  const { file } = temporaryState(t);
  let now = new Date("2026-08-28T15:00:00.000Z");
  const options = { now: () => now };
  const store = new ConversationStateStore(file, options);
  const target = newSession("target@c.us", { now });
  target.estado = SESSION_STATES.CLOSED;
  target.draft.order_id = "ORDER-42";
  target.draft.fecha = "2026-08-29";
  target.draft.ventana = "5–6 p.m.";
  store.set(target.chatId, target);
  store.set("other@c.us", newSession("other@c.us", { now }));

  now = new Date("2026-08-28T16:00:00.000Z");
  assert.equal(
    store.updateByOrderId("ORDER-42", (session) => ({
      ...session,
      draft: {
        ...session.draft,
        fecha: "2026-09-02",
        ventana: "después de las 3 PM",
      },
    })),
    true,
  );
  assert.equal(store.updateByOrderId("", (session) => session), false);
  assert.equal(store.updateByOrderId("UNKNOWN", (session) => session), false);

  const reloaded = new ConversationStateStore(file, options);
  assert.equal(reloaded.get("target@c.us").draft.fecha, "2026-09-02");
  assert.equal(
    reloaded.get("target@c.us").draft.ventana,
    "después de las 3 PM",
  );
  assert.equal(
    reloaded.get("target@c.us").lastActivity,
    "2026-08-28T16:00:00.000Z",
  );
  assert.equal(reloaded.get("other@c.us").draft.order_id, "");
});

test("conserva los metadatos internos seguros entre turnos", (t) => {
  const { file } = temporaryState(t);
  const now = new Date("2026-08-28T15:00:00.000Z");
  const store = new ConversationStateStore(file, { now: () => now });
  const session = newSession("metadata@c.us", { now });
  session.fechas_detalle = [
    {
      fecha: "2026-08-29",
      etiqueta: "Sábado 29 de agosto",
      origen: "PROGRAMADO",
      pickup_disponible: true,
      pickup_ventana: "5:00 p.m. a 6:00 p.m.",
      delivery_disponible: true,
      delivery_ventana: "después de las 3:00 p.m.",
    },
  ];
  session.firma_resumen_turno = 4;
  session.ultima_cotizacion = {
    lineas: [
      {
        product_id: "chocolate",
        nombre: "Conchitas Chocolate",
        cantidad: 6,
        precio_unitario: 3.5,
        subtotal: 21,
      },
    ],
    piezas: 6,
    minimo: 5,
    minimo_ok: true,
    subtotal: 21,
    envio: 0,
    total: 21,
    moneda: "CAD",
  };
  session.modificacion_pendiente = {
    order_id: "ORDER-42",
    accion: "CANCELAR",
    firma: "firma-modificacion",
    resumen_turno: 4,
    primera_confirmacion_turno: -1,
  };
  session.solicitud_especial = {
    producto: "Pan de muerto",
    cantidad: 5,
    fecha_texto: "el viernes",
  };
  session.firma_resumen_especial = "firma-especial";
  session.firma_resumen_especial_turno = 3;
  session.ultima_ubicacion = "15 Appleby Dr, Brampton";
  session.lastMessageId = "message-123";
  session.motivo_pausa = "El cliente pidió hablar con una persona";

  store.set(session.chatId, session);
  session.ultima_cotizacion.total = 999;
  session.modificacion_pendiente.accion = "REEMPLAZAR";

  const reloaded = new ConversationStateStore(file, {
    now: () => now,
  }).get(session.chatId);

  assert.deepEqual(reloaded.fechas_detalle, [
    {
      fecha: "2026-08-29",
      etiqueta: "Sábado 29 de agosto",
      origen: "PROGRAMADO",
      pickup_disponible: true,
      pickup_ventana: "5:00 p.m. a 6:00 p.m.",
      delivery_disponible: true,
      delivery_ventana: "después de las 3:00 p.m.",
    },
  ]);
  assert.equal(reloaded.firma_resumen_turno, 4);
  assert.equal(reloaded.ultima_cotizacion.total, 21);
  assert.equal(reloaded.modificacion_pendiente.accion, "CANCELAR");
  assert.equal(reloaded.firma_resumen_especial, "firma-especial");
  assert.equal(reloaded.firma_resumen_especial_turno, 3);
  assert.equal(reloaded.ultima_ubicacion, "15 Appleby Dr, Brampton");
  assert.equal(reloaded.lastMessageId, "message-123");
  assert.equal(
    reloaded.motivo_pausa,
    "El cliente pidió hablar con una persona",
  );
  assert.equal(Object.hasOwn(reloaded, "step"), false);
  assert.equal(Object.hasOwn(reloaded, "cartOrder"), false);
});

test("rechaza registros inválidos y permite borrar una sesión", (t) => {
  const { file } = temporaryState(t);
  fs.writeFileSync(
    file,
    JSON.stringify({
      "invalid@c.us": null,
      "valid@c.us": newSession({
        chatId: "valid@c.us",
        now: new Date("2026-08-28T15:00:00.000Z"),
      }),
    }),
  );
  const store = new ConversationStateStore(file, {
    now: () => new Date("2026-08-28T15:30:00.000Z"),
  });

  assert.equal(store.get("invalid@c.us"), null);
  assert.equal(store.lastRecoveryReport.removedInvalid, 1);
  assert.equal(store.delete("valid@c.us"), null);
  assert.equal(store.get("valid@c.us"), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
});
