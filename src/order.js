"use strict";

const {
  classifyFulfillmentProductName,
  deriveFulfillmentFromItems,
} = require("./fulfillment");

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrBlank(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : text(value);
}

function yesNo(value) {
  return value === true || String(value).toUpperCase() === "SI" ? "SI" : "NO";
}

function whatsappMoney(value, divisor = 1000) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return text(value);
  return parsed / divisor;
}

function lineTotal(price, quantity) {
  const numericPrice = Number(price);
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericPrice) || !Number.isFinite(numericQuantity)) {
    return "";
  }
  return numericPrice * numericQuantity;
}

function normalizeOrder({
  message,
  order,
  customerName = "",
  customerPhone = "",
  priceDivisor = 1000,
  deliveryFees = { brampton: 5, mississauga: 8 },
}) {
  if (!message?.orderId) {
    throw new Error("El mensaje de pedido no contiene orderId");
  }

  if (!Array.isArray(order?.products) || order.products.length === 0) {
    throw new Error("El carrito no contiene productos");
  }

  const receivedAt = new Date().toISOString();
  const orderId = text(message.orderId);
  const currency = text(order.currency);

  const items = order.products.map((product) => {
    const unitPrice = whatsappMoney(product.price, priceDivisor);
    const quantity = numberOrBlank(product.quantity);
    const isLogistics = Boolean(
      classifyFulfillmentProductName(product.name),
    );
    return {
      receivedAt,
      orderId,
      productId: text(product.id),
      productName: text(product.name),
      quantity,
      unitPrice,
      currency: text(product.currency || currency),
      lineTotal: lineTotal(unitPrice, quantity),
      isLogistics,
    };
  });

  const foodItems = items.filter((item) => !item.isLogistics);
  const productsTotal = foodItems.reduce(
    (total, item) => total + Number(item.lineTotal || 0),
    0,
  );
  const fulfillment = deriveFulfillmentFromItems(items, deliveryFees);
  const selection = fulfillment.selection;
  const deliveryFee = selection?.deliveryFee ?? "";
  const grandTotal =
    deliveryFee === "" ? productsTotal : productsTotal + Number(deliveryFee);
  const status = fulfillment.conflict
    ? "REVISION_MANUAL"
    : selection?.fulfillmentType === "PICKUP"
      ? "ESPERANDO_HORARIO"
      : "ESPERANDO_DATOS";
  const productSummary = foodItems
    .map((item) => `${item.quantity} x ${item.productName}`)
    .join(", ");

  return {
    summary: {
      receivedAt,
      orderId,
      phone:
        text(customerPhone) || text(message.from).replace(/@.+$/, ""),
      customerName: text(customerName),
      currency,
      subtotal: productsTotal,
      total: productsTotal,
      status,
      messageId: text(message.id?._serialized),
      chatId: text(message.from),
      fulfillmentType: selection?.fulfillmentType || "",
      city: selection?.city || "",
      address: "",
      postalCode: "",
      requestedDate: "",
      timeWindow: "",
      deliveryFee,
      grandTotal,
      scheduleStatus: "PENDIENTE",
      latitude: "",
      longitude: "",
      updatedAt: receivedAt,
      customerNotes: "",
      productSummary,
      fulfillmentConflict: fulfillment.conflict,
    },
    items,
  };
}

function summaryRow(summary) {
  return [
    summary.receivedAt,
    summary.orderId,
    summary.phone,
    summary.customerName,
    summary.currency,
    summary.subtotal,
    summary.total,
    summary.status,
    summary.messageId,
    summary.chatId,
    summary.fulfillmentType,
    summary.city,
    summary.address,
    summary.postalCode,
    summary.requestedDate,
    summary.timeWindow,
    summary.deliveryFee,
    summary.grandTotal,
    summary.scheduleStatus,
    summary.latitude,
    summary.longitude,
    summary.updatedAt,
    summary.customerNotes,
    summary.productSummary,
    yesNo(summary.fulfillmentConflict),
  ];
}

function itemRow(item) {
  return [
    item.receivedAt,
    item.orderId,
    item.productId,
    item.productName,
    item.quantity,
    item.unitPrice,
    item.currency,
    item.lineTotal,
    yesNo(item.isLogistics),
  ];
}

function formatMoney(value, currency = "CAD") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return `${new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: currency || "CAD",
  }).format(numeric)} ${currency || "CAD"}`;
}

module.exports = {
  formatMoney,
  itemRow,
  normalizeOrder,
  summaryRow,
  whatsappMoney,
};
