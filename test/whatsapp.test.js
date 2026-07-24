"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  phoneFromWhatsAppId,
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
