"use strict";

const WEEKDAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

function torontoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function weekdayForDate(date) {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

function normalizeProductionWeekdays(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(Number)
        .filter(
          (weekday) =>
            Number.isInteger(weekday) && weekday >= 0 && weekday <= 6,
        ),
    ),
  ].sort((left, right) => left - right);
}

function productAvailability(product, date) {
  const productionWeekdays = normalizeProductionWeekdays(
    product.productionWeekdays,
  );
  if (!productionWeekdays.length) return "";
  const weekday = weekdayForDate(date);
  if (productionWeekdays.includes(weekday)) return "FRESH";
  const previousWeekday = (weekday + 6) % 7;
  if (productionWeekdays.includes(previousWeekday)) return "PREVIOUS_DAY";
  return "";
}

function compatibleProductDates(
  products,
  now = new Date(),
  { limit = 6, lookaheadDays = 35 } = {},
) {
  if (!Array.isArray(products) || !products.length) return [];
  if (
    products.some(
      (product) =>
        !normalizeProductionWeekdays(product.productionWeekdays).length,
    )
  ) {
    return [];
  }

  const today = torontoToday(now);
  const results = [];
  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const date = addDays(today, offset);
    const availability = products.map((product) => ({
      product,
      freshness: productAvailability(product, date),
    }));
    if (availability.some((item) => !item.freshness)) continue;

    results.push({
      date,
      weekday: weekdayForDate(date),
      freshProducts: availability
        .filter((item) => item.freshness === "FRESH")
        .map((item) => item.product),
      previousDayProducts: availability
        .filter((item) => item.freshness === "PREVIOUS_DAY")
        .map((item) => item.product),
    });
    if (results.length >= limit) break;
  }
  return results;
}

function dateLabel(date) {
  const value = new Date(`${date}T12:00:00.000Z`);
  const formatted = new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(value);
  return `${WEEKDAY_NAMES[value.getUTCDay()]} ${formatted}`;
}

module.exports = {
  WEEKDAY_NAMES,
  addDays,
  compatibleProductDates,
  dateLabel,
  normalizeProductionWeekdays,
  productAvailability,
  torontoToday,
  weekdayForDate,
};
