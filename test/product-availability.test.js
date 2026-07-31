"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compatibleProductDates,
  productAvailability,
} = require("../src/product-availability");

const tuesdayThursday = {
  id: "volovan",
  name: "Volován",
  productionWeekdays: [2, 4],
};
const wednesdaySaturday = {
  id: "concha",
  name: "Concha",
  productionWeekdays: [3, 6],
};

test("un producto solo dura el dia de produccion y el siguiente", () => {
  assert.equal(productAvailability(tuesdayThursday, "2026-08-04"), "FRESH");
  assert.equal(
    productAvailability(tuesdayThursday, "2026-08-05"),
    "PREVIOUS_DAY",
  );
  assert.equal(productAvailability(tuesdayThursday, "2026-08-06"), "FRESH");
  assert.equal(
    productAvailability(tuesdayThursday, "2026-08-07"),
    "PREVIOUS_DAY",
  );
  assert.equal(productAvailability(tuesdayThursday, "2026-08-08"), "");
});

test("no ofrece produccion anterior a la llegada del pedido", () => {
  const dates = compatibleProductDates(
    [tuesdayThursday],
    new Date("2026-07-31T15:00:00.000Z"),
    { limit: 2 },
  );

  assert.deepEqual(
    dates.map((option) => option.date),
    ["2026-08-04", "2026-08-05"],
  );
  assert.doesNotMatch(
    dates.map((option) => option.date).join(","),
    /2026-07-31/,
  );
});

test("una combinacion ofrece solamente fechas compatibles", () => {
  const dates = compatibleProductDates(
    [tuesdayThursday, wednesdaySaturday],
    new Date("2026-07-31T15:00:00.000Z"),
    { limit: 4 },
  );

  assert.deepEqual(
    dates.map((option) => option.date),
    ["2026-08-05", "2026-08-06", "2026-08-12", "2026-08-13"],
  );
  assert.deepEqual(
    dates[0].freshProducts.map((product) => product.id),
    ["concha"],
  );
  assert.deepEqual(
    dates[0].previousDayProducts.map((product) => product.id),
    ["volovan"],
  );
  assert.deepEqual(
    dates[1].freshProducts.map((product) => product.id),
    ["volovan"],
  );
  assert.deepEqual(
    dates[1].previousDayProducts.map((product) => product.id),
    ["concha"],
  );
});
