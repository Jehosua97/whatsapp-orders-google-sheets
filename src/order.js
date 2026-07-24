"use strict";

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrBlank(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : text(value);
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
    return {
      receivedAt,
      orderId,
      productId: text(product.id),
      productName: text(product.name),
      quantity,
      unitPrice,
      currency: text(product.currency || currency),
      lineTotal: lineTotal(unitPrice, quantity),
    };
  });

  const productsTotal = whatsappMoney(order.total, priceDivisor);

  return {
    summary: {
      receivedAt,
      orderId,
      phone:
        text(customerPhone) || text(message.from).replace(/@.+$/, ""),
      customerName: text(customerName),
      currency,
      subtotal: whatsappMoney(order.subtotal, priceDivisor),
      total: productsTotal,
      status: "ESPERANDO_DATOS",
      messageId: text(message.id?._serialized),
      chatId: text(message.from),
      fulfillmentType: "",
      city: "",
      address: "",
      postalCode: "",
      requestedDate: "",
      timeWindow: "",
      deliveryFee: "",
      grandTotal: productsTotal,
      scheduleStatus: "PENDIENTE",
      latitude: "",
      longitude: "",
      updatedAt: receivedAt,
      customerNotes: "",
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
