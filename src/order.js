"use strict";

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function numberOrBlank(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : text(value);
}

function lineTotal(price, quantity) {
  const numericPrice = Number(price);
  const numericQuantity = Number(quantity);
  if (!Number.isFinite(numericPrice) || !Number.isFinite(numericQuantity)) {
    return "";
  }
  return numericPrice * numericQuantity;
}

function normalizeOrder({ message, order, customerName = "" }) {
  if (!message?.orderId) {
    throw new Error("El mensaje de pedido no contiene orderId");
  }

  if (!Array.isArray(order?.products) || order.products.length === 0) {
    throw new Error("El carrito no contiene productos");
  }

  const receivedAt = new Date().toISOString();
  const orderId = text(message.orderId);
  const currency = text(order.currency);

  const items = order.products.map((product) => ({
    receivedAt,
    orderId,
    productId: text(product.id),
    productName: text(product.name),
    quantity: numberOrBlank(product.quantity),
    unitPrice: numberOrBlank(product.price),
    currency: text(product.currency || currency),
    lineTotal: lineTotal(product.price, product.quantity),
  }));

  return {
    summary: {
      receivedAt,
      orderId,
      phone: text(message.from).replace(/@.+$/, ""),
      customerName: text(customerName),
      currency,
      subtotal: numberOrBlank(order.subtotal),
      total: numberOrBlank(order.total),
      status: "NUEVO",
      messageId: text(message.id?._serialized),
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

module.exports = { itemRow, normalizeOrder, summaryRow };
