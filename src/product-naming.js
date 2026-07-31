"use strict";

function correctProductId(value) {
  return String(value || "")
    .replace(/^bolobon-pastor$/i, "volovan-pastor")
    .replace(/^bolobon-chorizo$/i, "volovan-chorizo");
}

function correctProductName(value) {
  return String(value || "")
    .replace(/bolob[oó]nes/gi, "Volovanes")
    .replace(/bolob[oó]n/gi, "Volován");
}

module.exports = { correctProductId, correctProductName };
