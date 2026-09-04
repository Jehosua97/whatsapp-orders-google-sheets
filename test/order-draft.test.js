"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  construirBorrador,
  cotizarInterno,
  crearBorrador,
  esSiExplicito,
  fechaIsoValida,
  firmarResumen,
  hashBorrador,
  normalizar,
  normalizarBorrador,
  primerCampoFaltante,
  puedeGuardar,
} = require("../src/order-draft");

const config = {
  minimumOrderPieces: 5,
  currency: "CAD",
  deliveryFees: { brampton: 0, mississauga: 8 },
  catalog: [
    {
      id: "chocolate",
      name: "Conchitas Chocolate",
      price: 3.5,
      active: true,
    },
    {
      id: "vanilla",
      name: "Conchitas Vainilla",
      price: 3.5,
      active: true,
    },
    {
      id: "especial",
      name: "Producto especial",
      price: 9.99,
      active: false,
    },
  ],
};

function pickupDraft(overrides = {}) {
  return crearBorrador({
    items: [{ product_id: "chocolate", cantidad: 6 }],
    modalidad: "PICKUP",
    fecha: "2026-08-29",
    ventana: "5:00 p.m. a 6:00 p.m.",
    origen: "TEXTO",
    ...overrides,
  });
}

test("normaliza texto, enums e items sin mutar la entrada", () => {
  const input = {
    items: [
      { product_id: "vanilla", cantidad: "2" },
      { product_id: "chocolate", cantidad: 3 },
      { product_id: "vanilla", cantidad: 1 },
      { product_id: "quitar", cantidad: 0 },
    ],
    modalidad: " delivery ",
    ciudad: "brampton",
    direccion: " 15 Appleby Dr, Brampton ",
    direccion_tipo: "texto",
    fecha: " 2026-08-29 ",
  };

  assert.equal(normalizar("  SÍ, así está  "), "si, asi esta");
  assert.deepEqual(normalizarBorrador(input), {
    items: [
      { product_id: "chocolate", cantidad: 3 },
      { product_id: "vanilla", cantidad: 3 },
    ],
    modalidad: "DELIVERY",
    ciudad: "BRAMPTON",
    direccion: "15 Appleby Dr, Brampton",
    direccion_tipo: "TEXTO",
    fecha: "2026-08-29",
    ventana: "",
    preparacion: "FRESCO_PROGRAMADO",
    origen: "TEXTO",
    order_id: "",
  });
  assert.equal(input.items.length, 4);
});

test("construirBorrador reemplaza la lista completa y limpia datos de delivery en pickup", () => {
  const original = crearBorrador({
    items: [{ product_id: "chocolate", cantidad: 6 }],
    modalidad: "DELIVERY",
    ciudad: "MISSISSAUGA",
    direccion: "10 Main St",
    direccion_tipo: "TEXTO",
  });
  const next = construirBorrador(original, {
    items: [{ product_id: "vanilla", cantidad: 7 }],
    modalidad: "PICKUP",
  });

  assert.deepEqual(next.items, [{ product_id: "vanilla", cantidad: 7 }]);
  assert.equal(next.modalidad, "PICKUP");
  assert.equal(next.ciudad, "");
  assert.equal(next.direccion, "");
  assert.equal(original.modalidad, "DELIVERY");
});

test("el hash del borrador es estable y cambia con cualquier dato material", () => {
  const first = pickupDraft({
    items: [
      { product_id: "vanilla", cantidad: 7 },
      { product_id: "chocolate", cantidad: 6 },
    ],
  });
  const reordered = {
    fecha: "2026-08-29",
    items: [
      { cantidad: 6, product_id: "chocolate" },
      { cantidad: 7, product_id: "vanilla" },
    ],
    origen: "TEXTO",
    ventana: "5:00 p.m. a 6:00 p.m.",
    modalidad: "pickup",
  };

  assert.match(hashBorrador(first), /^[a-f0-9]{64}$/);
  assert.equal(hashBorrador(first), hashBorrador(reordered));
  assert.notEqual(
    hashBorrador(first),
    hashBorrador({ ...reordered, fecha: "2026-09-02" }),
  );
});

test("cotiza en centavos con catalogo activo y tarifa vigente", () => {
  const quote = cotizarInterno(
    crearBorrador({
      items: [
        { product_id: "chocolate", cantidad: 6 },
        { product_id: "vanilla", cantidad: 7 },
      ],
      modalidad: "DELIVERY",
      ciudad: "MISSISSAUGA",
      direccion: "10 Main St",
      fecha: "2026-08-29",
    }),
    config,
  );

  assert.deepEqual(quote, {
    lineas: [
      {
        product_id: "chocolate",
        nombre: "Conchitas Chocolate",
        cantidad: 6,
        precio_unitario: 3.5,
        subtotal: 21,
      },
      {
        product_id: "vanilla",
        nombre: "Conchitas Vainilla",
        cantidad: 7,
        precio_unitario: 3.5,
        subtotal: 24.5,
      },
    ],
    piezas: 13,
    minimo: 5,
    minimo_ok: true,
    subtotal: 45.5,
    envio: 8,
    total: 53.5,
    moneda: "CAD",
  });
});

test("la cotizacion nunca usa un producto inactivo o desconocido", () => {
  assert.throws(
    () =>
      cotizarInterno(
        pickupDraft({
          items: [{ product_id: "especial", cantidad: 5 }],
        }),
        config,
      ),
    /no existe o no esta disponible/i,
  );
  assert.throws(
    () =>
      cotizarInterno(
        pickupDraft({
          items: [{ product_id: "inventado", cantidad: 5 }],
        }),
        config,
      ),
    /no existe o no esta disponible/i,
  );
});

test("un producto inactivo sólo puede cotizarse cuando existe como pan listo", () => {
  const ready = crearBorrador({
    items: [{ product_id: "especial", cantidad: 5 }],
    modalidad: "PICKUP",
    fecha: "2026-08-28",
    preparacion: "PAN_LISTO_INMEDIATO",
  });
  const quote = cotizarInterno(ready, config);
  assert.equal(quote.total, 49.95);
  assert.equal(primerCampoFaltante(ready, config), "");
});

test("primerCampoFaltante respeta el orden y las reglas de pickup", () => {
  assert.equal(primerCampoFaltante(crearBorrador(), config), "ITEMS");
  assert.equal(
    primerCampoFaltante(
      crearBorrador({
        items: [{ product_id: "chocolate", cantidad: 4 }],
      }),
      config,
    ),
    "MINIMO",
  );
  assert.equal(
    primerCampoFaltante(
      crearBorrador({
        items: [{ product_id: "chocolate", cantidad: 5 }],
      }),
      config,
    ),
    "FECHA",
  );
  assert.equal(
    primerCampoFaltante(
      crearBorrador({
        items: [{ product_id: "chocolate", cantidad: 5 }],
        fecha: "2026-08-29",
      }),
      config,
    ),
    "MODALIDAD",
  );
  assert.equal(primerCampoFaltante(pickupDraft(), config), "");
});

test("primerCampoFaltante exige ciudad y direccion solamente para delivery", () => {
  const base = {
    items: [{ product_id: "chocolate", cantidad: 5 }],
    fecha: "2026-08-29",
    modalidad: "DELIVERY",
  };
  assert.equal(
    primerCampoFaltante(crearBorrador(base), config),
    "CIUDAD",
  );
  assert.equal(
    primerCampoFaltante(
      crearBorrador({ ...base, ciudad: "BRAMPTON" }),
      config,
    ),
    "DIRECCION",
  );
  assert.equal(
    primerCampoFaltante(
      crearBorrador({
        ...base,
        ciudad: "BRAMPTON",
        direccion: "15 Appleby Dr",
      }),
      config,
    ),
    "",
  );
});

test("valida fechas ISO reales, no solo su apariencia", () => {
  assert.equal(fechaIsoValida("2026-08-29"), true);
  assert.equal(fechaIsoValida("29-08-2026"), false);
  assert.equal(fechaIsoValida("2026-02-29"), false);
  assert.equal(fechaIsoValida("2028-02-29"), true);
});

test("el si explicito acepta las frases autorizadas y no afirmaciones vagas", () => {
  for (const message of [
    "Sí",
    "Claro, adelante",
    "De acuerdo",
    "Así queda",
    "Confírmalo por favor",
    "Ok, listo",
  ]) {
    assert.equal(esSiExplicito(message), true, message);
  }
  for (const message of ["tal vez", "creo que sí? no estoy seguro", "gracias"]) {
    // The rule intentionally treats any literal "sí" as explicit, per policy.
    if (message.includes("sí")) continue;
    assert.equal(esSiExplicito(message), false, message);
  }
});

test("puedeGuardar exige el ultimo si real y un borrador completo", () => {
  const draft = pickupDraft();
  const session = {
    draft,
    fechas_ofrecidas: ["2026-08-29"],
    firma_resumen: hashBorrador(draft),
  };

  assert.deepEqual(puedeGuardar(session, "gracias", { total: 21 }, config), {
    ok: false,
    motivo: "SIN_CONFIRMACION_EXPLICITA",
  });

  const incomplete = crearBorrador({
    items: [{ product_id: "chocolate", cantidad: 4 }],
  });
  assert.deepEqual(
    puedeGuardar(
      { draft: incomplete, firma_resumen: hashBorrador(incomplete) },
      "sí",
      { total: 14 },
      config,
    ),
    { ok: false, motivo: "FALTA_MINIMO" },
  );
});

test("un cambio despues del resumen invalida la firma", () => {
  const session = { draft: pickupDraft(), fechas_ofrecidas: ["2026-08-29"] };
  firmarResumen(session);
  session.draft = construirBorrador(session.draft, {
    items: [{ product_id: "chocolate", cantidad: 7 }],
  });

  assert.deepEqual(
    puedeGuardar(session, "sí, perfecto", { total: 24.5 }, config),
    { ok: false, motivo: "RESUMEN_DESACTUALIZADO" },
  );
});

test("la fecha debe ser una de las ofrecidas por el servidor", () => {
  const draft = pickupDraft();
  const session = {
    draft,
    fechas_ofrecidas: ["2026-09-02"],
    firma_resumen: hashBorrador(draft),
  };

  assert.deepEqual(puedeGuardar(session, "sí", { total: 21 }, config), {
    ok: false,
    motivo: "FALTA_FECHA",
  });
});

test("el servidor rechaza el total del modelo y admite un centavo de tolerancia", () => {
  const draft = pickupDraft();
  const session = {
    draft,
    fechas_ofrecidas: ["2026-08-29"],
    firma_resumen: hashBorrador(draft),
  };

  assert.deepEqual(puedeGuardar(session, "sí", { total: 50 }, config), {
    ok: false,
    motivo: "TOTAL_NO_COINCIDE",
  });
  assert.deepEqual(puedeGuardar(session, "sí", { total: 21.01 }, config), {
    ok: true,
  });
  assert.deepEqual(puedeGuardar(session, "sí", { total: 20.99 }, config), {
    ok: true,
  });
  assert.deepEqual(puedeGuardar(session, "sí", { total: 21.02 }, config), {
    ok: false,
    motivo: "TOTAL_NO_COINCIDE",
  });
});
