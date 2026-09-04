"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOOL_SCHEMAS,
  actualizarBorrador,
  consultarFechas,
  consultarPanListo,
  guardarPedido,
  guardarSolicitudEspecial,
  modificarPedido,
} = require("../src/agent-tools");
const { crearBorrador } = require("../src/order-draft");

const config = {
  minimumOrderPieces: 5,
  pickupAddress: "154 Royal Palm Dr, Brampton",
  deliveryFees: { brampton: 0, mississauga: 8 },
  catalog: [
    {
      id: "chocolate",
      productId: "concha-chocolate",
      name: "Conchitas Chocolate",
      sheetName: "Concha de chocolate",
      price: 3.5,
      productionWeekdays: [3, 6],
      active: true,
    },
    {
      id: "vanilla",
      productId: "concha-vainilla",
      name: "Conchitas Vainilla",
      sheetName: "Concha de vainilla",
      price: 3.5,
      productionWeekdays: [3, 6],
      active: true,
    },
    {
      id: "muerto",
      name: "Pan de muerto",
      price: 4,
      productionWeekdays: [6],
      active: false,
    },
  ],
  schedules: [
    {
      id: "wednesday",
      weekday: 3,
      active: true,
      pickupEnabled: true,
      pickupWindow: "5:00 p.m. a 6:00 p.m.",
      deliveryEnabled: true,
      deliveryWindow: "después de las 3:00 p.m.",
    },
    {
      id: "saturday",
      weekday: 6,
      active: true,
      pickupEnabled: true,
      pickupWindow: "5:00 p.m. a 6:00 p.m.",
      deliveryEnabled: true,
      deliveryWindow: "después de las 10:00 a.m.",
    },
  ],
  closures: [],
};

function session(message = "Quiero 6 de chocolate para pickup") {
  return {
    chatId: "customer@lid",
    customerName: "Ana",
    customerPhone: "14370000000",
    estado: "ABIERTA",
    draft: crearBorrador(),
    fechas_ofrecidas: [],
    transcript: [{ role: "user", content: message }],
  };
}

function dates(current) {
  return consultarFechas(
    { product_ids: ["chocolate"], modalidad: "CUALQUIERA" },
    current,
    config,
    new Date("2026-08-28T16:00:00Z"),
  );
}

test("las ocho herramientas tienen esquema estricto y todos sus campos requeridos", () => {
  assert.equal(TOOL_SCHEMAS.length, 8);
  for (const tool of TOOL_SCHEMAS) {
    assert.equal(tool.type, "function");
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(
      [...tool.parameters.required].sort(),
      Object.keys(tool.parameters.properties).sort(),
    );
  }
});

test("consultar_fechas ofrece solamente fechas compatibles y las guarda", () => {
  const current = session();
  const result = dates(current);
  assert.equal(result.fechas.length, 3);
  assert.equal(result.fechas[0].fecha, "2026-08-29");
  assert.deepEqual(current.fechas_ofrecidas, result.fechas.map((x) => x.fecha));
});

test("pan listo permite hoy incluso para una capacidad fuera del catálogo semanal", async () => {
  const now = new Date("2026-08-28T16:00:00.000Z");
  const current = session("Quiero 5 panes de muerto que ya estén listos para pickup hoy");
  const batch = {
    id: "lote-1",
    productId: "muerto",
    quantityInitial: 7,
    quantityAvailable: 7,
    readyAt: "2026-08-28T14:00:00.000Z",
    expiresAt: "2026-08-28T22:00:00.000Z",
    pickupEnabled: true,
    deliveryEnabled: false,
  };
  let available = 7;
  const inventoryStore = {
    getState: () => ({
      readyInventory: [{ ...batch, quantityAvailable: available }],
    }),
    reserveReadyInventory: (items, orderId) => {
      const quantity = items[0].cantidad;
      if (quantity > available) {
        return {
          ok: false,
          shortages: [
            {
              productId: "muerto",
              requested: quantity,
              available,
              missing: quantity - available,
            },
          ],
        };
      }
      available -= quantity;
      return {
        ok: true,
        allocations: [
          { batchId: "lote-1", productId: "muerto", quantity },
        ],
      };
    },
  };

  const availability = consultarPanListo(
    {
      items: [{ product_id: "muerto", cantidad: 5 }],
      modalidad: "PICKUP",
    },
    current,
    config,
    inventoryStore,
    now,
  );
  assert.equal(availability.pedido_completo_disponible, true);

  const draft = actualizarBorrador(
    {
      items: [{ product_id: "muerto", cantidad: 5 }],
      modalidad: "PICKUP",
      ciudad: "",
      direccion: "",
      fecha: "",
      preparacion: "PAN_LISTO_INMEDIATO",
    },
    current,
    config,
  );
  assert.equal(draft.completo, true);
  assert.equal(draft.borrador.fecha, "2026-08-28");
  assert.equal(draft.borrador.preparacion, "PAN_LISTO_INMEDIATO");

  current.transcript.push({ role: "assistant", content: "Resumen" });
  current.transcript.push({ role: "user", content: "Sí, confírmalo" });
  let written;
  const saved = await guardarPedido(
    { confirmado_por_cliente: true },
    current,
    config,
    {
      saveOrder: async (order) => {
        written = order;
        return { inserted: true };
      },
    },
    inventoryStore,
    now,
  );

  assert.equal(saved.guardado, true);
  assert.equal(available, 2);
  assert.equal(written.items[0].source, "PAN_LISTO");
  assert.match(written.summary.customerNotes, /no producir/i);
});

test("si pan listo ya no alcanza al confirmar no guarda ni descuenta parcialmente", async () => {
  const now = new Date("2026-08-28T16:00:00.000Z");
  const current = session("Quiero 6 de chocolate listas para pickup hoy");
  const inventoryStore = {
    getState: () => ({
      readyInventory: [
        {
          id: "lote-2",
          productId: "chocolate",
          quantityAvailable: 6,
          readyAt: "2026-08-28T14:00:00.000Z",
          expiresAt: "2026-08-28T22:00:00.000Z",
          pickupEnabled: true,
          deliveryEnabled: true,
        },
      ],
    }),
    reserveReadyInventory: () => ({
      ok: false,
      shortages: [
        { productId: "chocolate", requested: 6, available: 3, missing: 3 },
      ],
    }),
  };
  consultarPanListo(
    {
      items: [{ product_id: "chocolate", cantidad: 6 }],
      modalidad: "PICKUP",
    },
    current,
    config,
    inventoryStore,
    now,
  );
  actualizarBorrador(
    {
      items: [{ product_id: "chocolate", cantidad: 6 }],
      modalidad: "PICKUP",
      ciudad: "",
      direccion: "",
      fecha: "",
      preparacion: "PAN_LISTO_INMEDIATO",
    },
    current,
    config,
  );
  current.transcript.push({ role: "assistant", content: "Resumen" });
  current.transcript.push({ role: "user", content: "Sí" });
  let writes = 0;
  const result = await guardarPedido(
    { confirmado_por_cliente: true },
    current,
    config,
    { saveOrder: async () => { writes += 1; } },
    inventoryStore,
    now,
  );
  assert.equal(result.guardado, false);
  assert.equal(result.motivo, "PAN_LISTO_CAMBIO_DE_DISPONIBILIDAD");
  assert.equal(writes, 0);
});

test("rechaza fecha no ofrecida y dirección que no escribió el cliente", () => {
  const current = session("Quiero delivery en Brampton");
  dates(current);
  const result = actualizarBorrador(
    {
      items: [{ product_id: "chocolate", cantidad: 6 }],
      modalidad: "DELIVERY",
      ciudad: "BRAMPTON",
      direccion: "999 Invented Street",
      fecha: "2027-01-01",
    },
    current,
    config,
  );
  assert.equal(result.borrador.direccion, "");
  assert.equal(result.borrador.fecha, "");
  assert.match(result.advertencias.join(" "), /no aparece/i);
  assert.match(result.advertencias.join(" "), /no fue devuelta/i);
});

test("no guarda en el mismo turno del resumen y sí tras confirmación posterior", async () => {
  const current = session();
  dates(current);
  const first = actualizarBorrador(
    {
      items: [{ product_id: "chocolate", cantidad: 6 }],
      modalidad: "PICKUP",
      ciudad: "",
      direccion: "",
      fecha: current.fechas_ofrecidas[0],
    },
    current,
    config,
  );
  assert.equal(first.completo, true);
  const saved = [];
  const store = {
    saveOrder: async (order) => {
      saved.push(order);
      return { inserted: true };
    },
  };

  current.transcript[0].content = "Sí, quiero 6 para pickup";
  assert.deepEqual(
    await guardarPedido(
      { confirmado_por_cliente: true },
      current,
      config,
      store,
    ),
    { guardado: false, motivo: "RESUMEN_DESACTUALIZADO" },
  );
  assert.equal(saved.length, 0);

  current.transcript.push({ role: "assistant", content: "Resumen" });
  current.transcript.push({ role: "user", content: "Sí, así queda" });
  const result = await guardarPedido(
    { confirmado_por_cliente: true },
    current,
    config,
    store,
  );
  assert.equal(result.guardado, true);
  assert.equal(saved.length, 1);
  assert.equal(current.estado, "CERRADA");
});

test("un cambio incluido en el sí obliga a mostrar un resumen nuevo", async () => {
  const current = session();
  dates(current);
  actualizarBorrador(
    {
      items: [{ product_id: "chocolate", cantidad: 6 }],
      modalidad: "PICKUP",
      ciudad: "",
      direccion: "",
      fecha: current.fechas_ofrecidas[0],
    },
    current,
    config,
  );
  current.transcript.push({ role: "assistant", content: "Resumen de 6" });
  current.transcript.push({ role: "user", content: "Sí, pero que sean 7" });
  actualizarBorrador(
    {
      items: [{ product_id: "chocolate", cantidad: 7 }],
      modalidad: "PICKUP",
      ciudad: "",
      direccion: "",
      fecha: current.fechas_ofrecidas[0],
    },
    current,
    config,
  );
  let writes = 0;
  const result = await guardarPedido(
    { confirmado_por_cliente: true },
    current,
    config,
    { saveOrder: async () => { writes += 1; } },
  );
  assert.equal(result.guardado, false);
  assert.equal(result.motivo, "RESUMEN_DESACTUALIZADO");
  assert.equal(writes, 0);
});

test("un producto fuera de semana sólo se guarda como solicitud especial tras confirmar", async () => {
  const current = session(
    "Quiero 8 panes de muerto para el 5 de septiembre, pickup",
  );
  const args = {
    producto: "pan de muerto",
    cantidad: 8,
    fecha_texto: "5 de septiembre",
    modalidad: "PICKUP",
    ciudad: "",
    direccion: "",
    confirmado_por_cliente: false,
  };
  const writes = [];
  const store = {
    saveOrder: async (order) => {
      writes.push(order);
      return { inserted: true };
    },
  };
  const staged = await guardarSolicitudEspecial(args, current, config, store);
  assert.equal(staged.guardado, false);
  assert.match(staged.resumen_cliente, /pan de muerto/i);
  assert.equal(writes.length, 0);

  current.transcript.push({ role: "assistant", content: staged.resumen_cliente });
  current.transcript.push({ role: "user", content: "Sí, envíala" });
  const saved = await guardarSolicitudEspecial(
    { ...args, confirmado_por_cliente: true },
    current,
    config,
    store,
  );
  assert.equal(saved.guardado, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].summary.status, "REVISION_MANUAL");
  assert.equal(writes[0].summary.kitchenStatus, "Por confirmar");
});

test("cancelar un pedido exige dos confirmaciones separadas", async () => {
  const current = session("Quiero cancelar mi pedido");
  const updates = [];
  const store = {
    getOrder: async () => ({
      orderId: "AI-1",
      chatId: current.chatId,
      status: "NUEVO",
      kitchenStatus: "Confirmado",
    }),
    updateOrder: async (id, patch) => updates.push({ id, patch }),
  };
  const args = {
    order_id: "AI-1",
    accion: "CANCELAR",
    items: [],
    modalidad: "",
    ciudad: "",
    direccion: "",
    fecha: "",
    confirmado_por_cliente: false,
  };
  const staged = await modificarPedido(args, current, config, store);
  assert.equal(staged.motivo, "CONFIRMACION_DE_CANCELACION_REQUERIDA");
  current.transcript.push({ role: "assistant", content: "¿Lo cancelo?" });
  current.transcript.push({ role: "user", content: "Sí" });
  const first = await modificarPedido(
    { ...args, confirmado_por_cliente: true },
    current,
    config,
    store,
  );
  assert.equal(first.motivo, "SEGUNDA_CONFIRMACION_REQUERIDA");
  assert.equal(updates.length, 0);
  current.transcript.push({ role: "assistant", content: "Confirma otra vez" });
  current.transcript.push({ role: "user", content: "Sí, cancélalo" });
  const second = await modificarPedido(
    { ...args, confirmado_por_cliente: true },
    current,
    config,
    store,
  );
  assert.equal(second.actualizado, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.kitchenStatus, "Cancelado");
});
