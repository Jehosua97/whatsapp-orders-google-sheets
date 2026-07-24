"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  handleLocation,
  locationReceivedReply,
  phoneFromWhatsAppId,
  pickupReply,
  resolvePhoneNumber,
} = require("../src/whatsapp");

test("extrae un telefono de un ID telefonico de WhatsApp", () => {
  assert.equal(phoneFromWhatsAppId("14165550123@c.us"), "14165550123");
  assert.equal(
    phoneFromWhatsAppId("14165550123@s.whatsapp.net"),
    "14165550123",
  );
});

test("nunca presenta un LID como numero telefonico", () => {
  assert.equal(phoneFromWhatsAppId("136455926071466@lid"), "");
});

test("resuelve el numero asociado a un chat LID", async () => {
  const client = {
    getContactLidAndPhone: async () => [
      {
        lid: "136455926071466@lid",
        pn: "14165550123@c.us",
      },
    ],
  };

  const phone = await resolvePhoneNumber(
    client,
    "136455926071466@lid",
    { number: "136455926071466" },
  );
  assert.equal(phone, "14165550123");
});

test("deja el telefono vacio si WhatsApp no revela el mapeo del LID", async () => {
  const client = {
    getContactLidAndPhone: async () => [],
  };

  const phone = await resolvePhoneNumber(
    client,
    "136455926071466@lid",
    { number: "136455926071466" },
  );
  assert.equal(phone, "");
});

test("la respuesta de ubicacion no pide confirmar la ciudad", () => {
  const reply = locationReceivedReply();
  assert.match(reply, /recibimos tu ubicacion/i);
  assert.match(reply, /validaremos el horario de entrega/i);
  assert.doesNotMatch(reply, /Brampton|Mississauga/i);
});

test("la respuesta de recogida usa el horario configurable", () => {
  const reply = pickupReply("4:30 p.m. a 5:30 p.m.");
  assert.match(reply, /mandaremos la direccion/i);
  assert.match(reply, /4:30 p\.m\. a 5:30 p\.m\./i);
});

test("conserva la ciudad del catalogo al recibir una ubicacion", async () => {
  let savedPatch;
  let sentReply;
  const store = {
    getPendingOrderByChat: async () => ({
      orderId: "WA-123",
      city: "BRAMPTON",
      total: 10,
      currency: "CAD",
    }),
    updateOrder: async (_orderId, patch) => {
      savedPatch = patch;
    },
  };
  const message = {
    from: "test@lid",
    location: {
      description: "123 Main Street",
      latitude: 43.7,
      longitude: -79.7,
    },
    reply: async (text) => {
      sentReply = text;
    },
  };

  await handleLocation({
    message,
    store,
    config: { deliveryFees: { brampton: 5, mississauga: 8 } },
  });

  assert.equal(savedPatch.city, "BRAMPTON");
  assert.equal(savedPatch.deliveryFee, 5);
  assert.equal(sentReply, locationReceivedReply());
});
