"use strict";

const weekdays = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];
const weekdayShortLabels = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

const state = {
  dashboard: null,
  selectedClosureId: "",
  savedAutomation: null,
};

const elements = {
  catalogRows: document.querySelector("#catalogRows"),
  catalogSummary: document.querySelector("#catalogSummary"),
  readyInventoryRows: document.querySelector("#readyInventoryRows"),
  readySummary: document.querySelector("#readySummary"),
  readyInventoryForm: document.querySelector("#readyInventoryForm"),
  scheduleRows: document.querySelector("#scheduleRows"),
  upcomingDates: document.querySelector("#upcomingDates"),
  closureRows: document.querySelector("#closureRows"),
  affectedRows: document.querySelector("#affectedRows"),
  affectedSection: document.querySelector("#affectedSection"),
  affectedTitle: document.querySelector("#affectedTitle"),
  allowedPhoneRows: document.querySelector("#allowedPhoneRows"),
  blockedPhoneRows: document.querySelector("#blockedPhoneRows"),
  closureDialog: document.querySelector("#closureDialog"),
  closureForm: document.querySelector("#closureForm"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icons() {
  if (window.lucide) window.lucide.createIcons();
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

async function api(url, options = {}, retry = true) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const password = sessionStorage.getItem("adminPassword");
  if (password) headers["x-admin-password"] = password;
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    const supplied = window.prompt("Contraseña del panel:");
    if (supplied === null) throw new Error("Acceso cancelado.");
    sessionStorage.setItem("adminPassword", supplied);
    return api(url, options, false);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "No se pudo completar la operación.");
  }
  if (response.status === 204) return null;
  return response.json();
}

function setLoading(element, loading) {
  element.classList.toggle("loading", loading);
  if ("disabled" in element) element.disabled = loading;
}

function renderCatalog() {
  const catalog = state.dashboard.catalog;
  const active = catalog.filter((product) => product.active).length;
  const average =
    catalog.reduce((total, product) => total + Number(product.price), 0) /
    Math.max(catalog.length, 1);
  elements.catalogSummary.innerHTML = [
    ["Productos", catalog.length],
    ["Disponibles", active],
    ["Precio promedio", `$${average.toFixed(2)}`],
  ]
    .map(
      ([label, value]) =>
        `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  elements.catalogRows.innerHTML = catalog
    .map(
      (product, index) => `
        <div class="catalog-row" data-index="${index}">
          <div class="product-name-fields">
            <input class="emoji-input" data-field="emoji" value="${escapeHtml(product.emoji)}" aria-label="Icono" maxlength="8">
            <input data-field="name" value="${escapeHtml(product.name)}" aria-label="Nombre del producto">
          </div>
          <div class="production-weekdays" aria-label="Días de producción de ${escapeHtml(product.name)}">
            ${weekdayShortLabels
              .map(
                (label, weekday) => `
                  <label class="weekday-option">
                    <input type="checkbox" data-production-weekday value="${weekday}" ${(product.productionWeekdays || []).includes(weekday) ? "checked" : ""}>
                    <span>${label}</span>
                  </label>`,
              )
              .join("")}
          </div>
          <div class="price-field">
            <input data-field="price" type="number" min="0" step="0.25" value="${Number(product.price).toFixed(2)}" aria-label="Precio">
          </div>
          <label class="switch" title="Disponible">
            <input data-field="active" type="checkbox" ${product.active ? "checked" : ""}>
            <span></span>
          </label>
          <button class="icon-button danger-icon remove-product" title="Eliminar producto" ${catalog.length === 1 ? "disabled" : ""}>
            <i data-lucide="trash-2"></i>
          </button>
        </div>`,
    )
    .join("");
  icons();
}

function catalogFromForm() {
  return [...elements.catalogRows.querySelectorAll(".catalog-row")].map(
    (row) => {
      const existing =
        state.dashboard.catalog[Number(row.dataset.index)] || {};
      const name = row.querySelector('[data-field="name"]').value;
      return {
        id: existing.id,
        emoji: row.querySelector('[data-field="emoji"]').value,
        name,
        promptName: name,
        sheetName: name,
        productionWeekdays: [
          ...row.querySelectorAll('[data-production-weekday]:checked'),
        ].map((input) => Number(input.value)),
        price: Number(row.querySelector('[data-field="price"]').value),
        active: row.querySelector('[data-field="active"]').checked,
      };
    },
  );
}

function localDateTimeValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function defaultReadyExpiry() {
  return localDateTimeValue(Date.now() + 8 * 60 * 60 * 1000);
}

function readyBatchStatus(batch) {
  const now = Date.now();
  if (Number(batch.quantityAvailable || 0) <= 0) {
    return { label: "Agotado", className: "unavailable" };
  }
  if (Date.parse(batch.expiresAt) <= now) {
    return { label: "Vencido", className: "warning" };
  }
  if (Date.parse(batch.readyAt) > now) {
    return { label: "Pendiente", className: "warning" };
  }
  return { label: "Disponible ahora", className: "pickup" };
}

function renderReadyInventory() {
  const catalog = state.dashboard.catalog || [];
  const batches = state.dashboard.readyInventory || [];
  const productSelect = document.querySelector("#readyProduct");
  const selectedProduct = productSelect.value;
  productSelect.innerHTML = catalog
    .map(
      (product) =>
        `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}${product.active ? "" : " (fuera del catálogo semanal)"}</option>`,
    )
    .join("");
  if (catalog.some((product) => product.id === selectedProduct)) {
    productSelect.value = selectedProduct;
  }
  const expiryInput = document.querySelector("#readyExpiresAt");
  if (!expiryInput.value) expiryInput.value = defaultReadyExpiry();

  const active = batches.filter(
    (batch) =>
      Number(batch.quantityAvailable || 0) > 0 &&
      Date.parse(batch.readyAt) <= Date.now() &&
      Date.parse(batch.expiresAt) > Date.now(),
  );
  const activePieces = active.reduce(
    (total, batch) => total + Number(batch.quantityAvailable || 0),
    0,
  );
  const expired = batches.filter(
    (batch) => Date.parse(batch.expiresAt) <= Date.now(),
  ).length;
  elements.readySummary.innerHTML = [
    ["Piezas listas", activePieces],
    ["Lotes activos", active.length],
    ["Agotados o vencidos", batches.length - active.length],
  ]
    .map(
      ([label, value]) =>
        `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
  document.querySelector("#readyNavCount").textContent = activePieces;

  const productById = new Map(catalog.map((product) => [product.id, product]));
  elements.readyInventoryRows.innerHTML = batches.length
    ? [...batches]
        .sort(
          (left, right) =>
            Date.parse(left.expiresAt) - Date.parse(right.expiresAt),
        )
        .map((batch) => {
          const product = productById.get(batch.productId) || {};
          const status = readyBatchStatus(batch);
          return `
            <article class="ready-inventory-row" data-batch-id="${escapeHtml(batch.id)}">
              <div class="ready-product-label">
                <span class="ready-product-emoji">${escapeHtml(product.emoji || "🥖")}</span>
                <div>
                  <strong>${escapeHtml(product.name || batch.productId)}</strong>
                  <span class="pill ${status.className}">${status.label}</span>
                </div>
              </div>
              <label class="field compact-field">
                <span>Piezas disponibles</span>
                <input data-ready-field="quantityAvailable" type="number" min="0" step="1" value="${Number(batch.quantityAvailable || 0)}" />
              </label>
              <label class="field compact-field">
                <span>Vender hasta</span>
                <input data-ready-field="expiresAt" type="datetime-local" value="${localDateTimeValue(batch.expiresAt)}" />
              </label>
              <div class="ready-row-services">
                <label class="check-line"><input data-ready-field="pickupEnabled" type="checkbox" ${batch.pickupEnabled !== false ? "checked" : ""} /><span>Pickup</span></label>
                <label class="check-line"><input data-ready-field="deliveryEnabled" type="checkbox" ${batch.deliveryEnabled !== false ? "checked" : ""} /><span>Delivery</span></label>
              </div>
              <label class="field compact-field ready-row-note">
                <span>Nota interna</span>
                <input data-ready-field="note" maxlength="160" value="${escapeHtml(batch.note || "")}" placeholder="Sin nota" />
              </label>
              <div class="ready-row-actions">
                <button class="button secondary small save-ready-batch" type="button"><i data-lucide="save"></i>Guardar</button>
                <button class="icon-button danger-icon remove-ready-batch" type="button" title="Eliminar lote"><i data-lucide="trash-2"></i></button>
              </div>
            </article>`;
        })
        .join("")
    : '<div class="empty-state">No hay pan listo registrado. Los pedidos programados continúan funcionando normalmente.</div>';
  icons();
}

function readyBatchFromRow(row) {
  const expiresValue = row.querySelector(
    '[data-ready-field="expiresAt"]',
  ).value;
  return {
    quantityAvailable: Number(
      row.querySelector('[data-ready-field="quantityAvailable"]').value,
    ),
    expiresAt: new Date(expiresValue).toISOString(),
    pickupEnabled: row.querySelector('[data-ready-field="pickupEnabled"]')
      .checked,
    deliveryEnabled: row.querySelector('[data-ready-field="deliveryEnabled"]')
      .checked,
    note: row.querySelector('[data-ready-field="note"]').value,
  };
}

function renderSchedules() {
  elements.scheduleRows.innerHTML = state.dashboard.schedules
    .map((schedule, index) => {
      const pickupEnabled = schedule.pickupEnabled !== false;
      const deliveryEnabled = schedule.deliveryEnabled !== false;
      return `
        <div class="schedule-row" data-index="${index}">
          <div class="schedule-identity">
            <select data-field="weekday" aria-label="Día de la semana">
              ${weekdays
                .map(
                  (day, weekday) =>
                    `<option value="${weekday}" ${weekday === schedule.weekday ? "selected" : ""}>${day}</option>`,
                )
                .join("")}
            </select>
          </div>
          <div class="service-editor ${pickupEnabled ? "" : "unavailable"}">
            <label class="switch-line">
              <span class="switch">
                <input data-field="pickupEnabled" type="checkbox" ${pickupEnabled ? "checked" : ""}>
                <span></span>
              </span>
              <span class="service-copy">
                <strong>Pickup</strong>
                <small>${pickupEnabled ? "Disponible" : "No disponible"}</small>
              </span>
            </label>
            <input data-field="pickupWindow" value="${escapeHtml(schedule.pickupWindow)}" aria-label="Horario de pickup" ${pickupEnabled ? "" : "disabled"}>
          </div>
          <div class="service-editor delivery ${deliveryEnabled ? "" : "unavailable"}">
            <label class="switch-line">
              <span class="switch">
                <input data-field="deliveryEnabled" type="checkbox" ${deliveryEnabled ? "checked" : ""}>
                <span></span>
              </span>
              <span class="service-copy">
                <strong>Delivery</strong>
                <small>${deliveryEnabled ? "Disponible" : "No disponible"}</small>
              </span>
            </label>
            <input data-field="deliveryWindow" value="${escapeHtml(schedule.deliveryWindow)}" aria-label="Horario de delivery" ${deliveryEnabled ? "" : "disabled"}>
          </div>
          <button class="icon-button danger-icon remove-schedule" title="Eliminar día" ${state.dashboard.schedules.length === 1 ? "disabled" : ""}>
            <i data-lucide="trash-2"></i>
          </button>
        </div>`;
    })
    .join("");
  icons();
}

function updateScheduleServiceState(toggle) {
  const editor = toggle.closest(".service-editor");
  const available = toggle.checked;
  editor.classList.toggle("unavailable", !available);
  editor.querySelector(".service-copy small").textContent = available
    ? "Disponible"
    : "No disponible";
  editor.querySelector('input[type="text"], input:not([type])').disabled =
    !available;
}

function schedulesFromForm() {
  return [...elements.scheduleRows.querySelectorAll(".schedule-row")].map(
    (row) => {
      const existing =
        state.dashboard.schedules[Number(row.dataset.index)] || {};
      const weekday = Number(
        row.querySelector('[data-field="weekday"]').value,
      );
      return {
        id: existing.id,
        name: weekdays[weekday],
        weekday,
        active: true,
        pickupEnabled: row.querySelector(
          '[data-field="pickupEnabled"]',
        ).checked,
        pickupWindow: row.querySelector(
          '[data-field="pickupWindow"]',
        ).value,
        deliveryEnabled: row.querySelector(
          '[data-field="deliveryEnabled"]',
        ).checked,
        deliveryWindow: row.querySelector(
          '[data-field="deliveryWindow"]',
        ).value,
      };
    },
  );
}

function renderRescheduling() {
  const dashboard = state.dashboard;
  const affectedTotal = dashboard.closures.reduce(
    (total, closure) => total + closure.affectedCount,
    0,
  );
  const availableDates = dashboard.upcomingDates.filter(
    (date) => date.pickupAvailable || date.deliveryAvailable,
  ).length;
  document.querySelector("#rescheduleMetrics").innerHTML = [
    ["Fechas disponibles", availableDates],
    ["Excepciones", dashboard.closures.length],
    ["Pedidos por atender", affectedTotal],
  ]
    .map(
      ([label, value]) =>
        `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");

  elements.upcomingDates.innerHTML = dashboard.upcomingDates
    .slice(0, 12)
    .map((date) => {
      const closed = !date.pickupAvailable || !date.deliveryAvailable;
      return `
        <div class="availability-row ${closed ? "has-exception" : ""}">
          <div class="availability-date">
            <strong>${escapeHtml(date.dateLabel)}</strong>
            <span>${escapeHtml(date.date)}</span>
          </div>
          <span class="availability-status ${date.pickupAvailable ? "available" : "unavailable"}" data-service="Pickup">
            <i data-lucide="${date.pickupAvailable ? "check-circle-2" : "x-circle"}"></i>
            ${date.pickupAvailable ? escapeHtml(date.pickupWindow) : "No disponible"}
          </span>
          <span class="availability-status ${date.deliveryAvailable ? "available" : "unavailable"}" data-service="Delivery">
            <i data-lucide="${date.deliveryAvailable ? "check-circle-2" : "x-circle"}"></i>
            ${date.deliveryAvailable ? escapeHtml(date.deliveryWindow) : "No disponible"}
          </span>
          <div class="availability-orders">
            <strong>${date.confirmedOrders}</strong>
            <span>confirmados</span>
          </div>
          <button class="icon-button close-date" data-date="${date.date}" title="${closed ? "Editar disponibilidad" : "Agregar excepción"}">
            <i data-lucide="${closed ? "calendar-cog" : "calendar-minus-2"}"></i>
          </button>
        </div>`;
    })
    .join("");

  document.querySelector("#closureNavCount").textContent =
    dashboard.closures.length;
  document.querySelector("#closureCountLabel").textContent =
    `${dashboard.closures.length} ${dashboard.closures.length === 1 ? "activa" : "activas"}`;
  elements.closureRows.innerHTML = dashboard.closures.length
    ? dashboard.closures
        .map(
          (closure) => `
            <div class="closure-row">
              <div>
                <strong>${escapeHtml(closure.dateLabel)}</strong>
                <span class="subtext">${escapeHtml(closure.reason || "Sin motivo registrado")}</span>
              </div>
              <div class="service-pills">
                ${closure.services
                  .map(
                    (service) =>
                      `<span class="pill ${service.toLowerCase()}">${service === "PICKUP" ? "Pickup" : "Delivery"}</span>`,
                  )
                  .join("")}
              </div>
              <span class="pill ${closure.affectedCount ? "warning" : "pickup"}">
                ${closure.affectedCount} afectados
              </span>
              <div class="closure-actions">
                <button class="button small secondary view-affected" data-id="${closure.id}">
                  <i data-lucide="users"></i>
                  Ver pedidos
                </button>
                <button class="icon-button danger-icon remove-closure" data-id="${closure.id}" title="Reabrir fecha">
                  <i data-lucide="calendar-check"></i>
                </button>
              </div>
            </div>`,
        )
        .join("")
    : '<div class="empty-state">No hay suspensiones programadas.</div>';
  icons();
}

function formatPhone(phone) {
  const digits = String(phone || "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function automationChanged() {
  return (
    JSON.stringify(state.dashboard.automation) !==
    JSON.stringify(state.savedAutomation)
  );
}

function phoneRows(phones, list) {
  return phones.length
    ? phones
        .map(
          (phone) => `
            <div class="phone-row">
              <span class="phone-icon">
                <i data-lucide="${list === "blocked" ? "shield-ban" : "user-check"}"></i>
              </span>
              <strong>${escapeHtml(formatPhone(phone))}</strong>
              <button class="icon-button danger-icon remove-phone" type="button" data-list="${list}" data-phone="${escapeHtml(phone)}" title="Quitar número">
                <i data-lucide="trash-2"></i>
              </button>
            </div>`,
        )
        .join("")
    : `<div class="phone-empty">${list === "blocked" ? "No hay números bloqueados." : "No hay números permitidos."}</div>`;
}

function renderAutomation() {
  const automation = state.dashboard.automation;
  const activeAutomation = state.savedAutomation || automation;
  document.querySelectorAll("#automationMode [data-mode]").forEach((button) => {
    const selected = button.dataset.mode === automation.mode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  const productionActive = activeAutomation.mode === "NORMAL";
  const activeStatus = document.querySelector("#automationActiveStatus");
  activeStatus.classList.toggle("production", productionActive);
  document.querySelector("#activeAutomationLabel").textContent =
    productionActive ? "Producción" : "Solo pruebas";
  document.querySelector("#activeAutomationDetail").textContent =
    productionActive
      ? "El bot está respondiendo a todos excepto a los números bloqueados."
      : `El bot está respondiendo solo a ${activeAutomation.allowedPhones.length} números permitidos.`;
  const changed = automationChanged();
  document.querySelector("#automationPending").hidden = !changed;
  document.querySelector("#saveAutomationButton").disabled = !changed;
  document.querySelector("#allowedCount").textContent =
    automation.allowedPhones.length;
  document.querySelector("#blockedCount").textContent =
    automation.blockedPhones.length;
  elements.allowedPhoneRows.innerHTML = phoneRows(
    automation.allowedPhones,
    "allowed",
  );
  elements.blockedPhoneRows.innerHTML = phoneRows(
    automation.blockedPhones,
    "blocked",
  );
  icons();
}

async function renderAffected(closureId) {
  const data = await api(`/api/closures/${closureId}/affected`);
  state.selectedClosureId = closureId;
  elements.affectedSection.hidden = false;
  elements.affectedTitle.textContent = `${data.affected.length} pedidos afectados · ${data.closure.date}`;
  elements.affectedRows.innerHTML = data.affected.length
    ? data.affected
        .map(
          (order) => `
            <div class="affected-row">
              <div>
                <strong>${escapeHtml(order.customerName)}</strong>
                <span class="subtext">${escapeHtml(order.productSummary || order.orderId)}</span>
              </div>
              <div>
                <span class="pill ${order.serviceType.toLowerCase()}">${order.serviceType === "PICKUP" ? "Pickup" : "Delivery"}</span>
                <span class="subtext">${escapeHtml(order.city)}</span>
              </div>
              <div class="route-change">
                <span>${escapeHtml(order.fromDate)}</span>
                <i data-lucide="arrow-right"></i>
                <span>${order.next ? escapeHtml(order.next.date) : "Sin fecha"}</span>
              </div>
              <button class="button small primary notify-order" data-order-id="${escapeHtml(order.orderId)}" ${!order.canNotify || !order.next ? "disabled" : ""} title="${!order.canNotify ? "No autorizado por el control del bot" : "Enviar notificación y reprogramar"}">
                <i data-lucide="send"></i>
                ${order.canNotify ? "Notificar y reprogramar" : "No autorizado"}
              </button>
            </div>`,
        )
        .join("")
    : '<div class="empty-state">No hay pedidos confirmados afectados.</div>';
  elements.affectedSection.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
  icons();
}

function renderAll() {
  const connected = state.dashboard.whatsappStatus === "READY";
  const connecting = ["CONNECTING", "AUTHENTICATED"].includes(
    state.dashboard.whatsappStatus,
  );
  document.querySelector("#connectionLabel").textContent = connected
    ? "WhatsApp conectado"
    : connecting
      ? "WhatsApp conectando"
      : "WhatsApp desconectado";
  document
    .querySelector("#connectionDot")
    .classList.toggle("connecting", connecting);
  document
    .querySelector("#connectionDot")
    .classList.toggle("disconnected", !connected && !connecting);
  const activeAutomation =
    state.savedAutomation || state.dashboard.automation;
  const productionActive = activeAutomation.mode === "NORMAL";
  const banner = document.querySelector("#testBanner");
  banner.classList.toggle("production", productionActive);
  document.querySelector("#automationBannerText").textContent =
    productionActive
      ? "Modo PRODUCCIÓN activo: el bot responde a todos excepto a los números bloqueados."
      : `Modo SOLO PRUEBAS activo: el bot responde únicamente a ${activeAutomation.allowedPhones.length} números permitidos.`;
  renderCatalog();
  renderReadyInventory();
  renderSchedules();
  renderRescheduling();
  renderAutomation();
  document.querySelector("#freeBramptonDelivery").checked =
    state.dashboard.promotions?.freeBramptonDelivery !== false;
  renderBotPower();
  renderAi();
}

function renderBotPower() {
  const enabled = state.dashboard.botEnabled !== false;
  const button = document.querySelector("#botPowerButton");
  button.classList.toggle("paused", !enabled);
  button.title = enabled
    ? "Pausar el bot para todos los chats"
    : "Continuar el bot para todos los chats";
  button.innerHTML = `
    <i data-lucide="${enabled ? "pause" : "play"}"></i>
    <span id="botPowerLabel">${enabled ? "Pausar bot" : "Continuar bot"}</span>
  `;
  icons();
}

function renderAi() {
  const ai = state.dashboard.ai || {
    enabled: false,
    configured: false,
    operational: false,
    model: "gpt-5.4-mini",
  };
  document.querySelector("#aiEnabled").checked = ai.enabled === true;
  document.querySelector("#aiModel").textContent = ai.model || "gpt-5.4-mini";

  const status = document.querySelector("#aiActiveStatus");
  const title = document.querySelector("#aiStatusTitle");
  const detail = document.querySelector("#aiStatusDetail");
  const badge = document.querySelector("#aiConfiguredBadge");
  status.classList.toggle("production", ai.operational === true);
  status.classList.toggle(
    "ai-unavailable",
    ai.enabled === true && ai.configured !== true,
  );

  if (ai.operational) {
    title.textContent = "IA activa";
    detail.textContent = ai.lastError
      ? `El flujo seguro sigue disponible. Último aviso: ${ai.lastError}`
      : "Entiende mensajes naturales y redacta sobre respuestas verificadas.";
  } else if (!ai.enabled) {
    title.textContent = "IA desactivada";
    detail.textContent = "El bot utiliza únicamente el flujo tradicional verificado.";
  } else if (!ai.configured) {
    title.textContent = "Falta configurar la llave";
    detail.textContent = "Agrega OPENAI_API_KEY al archivo .env y reinicia el servicio.";
  } else {
    title.textContent = "IA temporalmente no disponible";
    detail.textContent = ai.lastError ||
      "La conexión no está disponible. El bot continúa con el flujo seguro.";
  }

  badge.textContent = ai.configured ? "Llave configurada" : "Falta OPENAI_API_KEY";
  badge.classList.toggle("pickup", ai.configured === true);
  badge.classList.toggle("warning", ai.configured !== true);
  icons();
}

async function loadDashboard(showMessage = false) {
  const button = document.querySelector("#refreshButton");
  setLoading(button, true);
  try {
    state.dashboard = await api("/api/dashboard");
    state.dashboard.readyInventory = Array.isArray(
      state.dashboard.readyInventory,
    )
      ? state.dashboard.readyInventory
      : [];
    state.dashboard.promotions = {
      freeBramptonDelivery:
        state.dashboard.promotions?.freeBramptonDelivery !== false,
    };
    state.dashboard.ai = {
      enabled: state.dashboard.ai?.enabled === true,
      configured: state.dashboard.ai?.configured === true,
      operational: state.dashboard.ai?.operational === true,
      model: state.dashboard.ai?.model || "gpt-5.4-mini",
      lastError: state.dashboard.ai?.lastError || "",
      lastSuccessAt: state.dashboard.ai?.lastSuccessAt || "",
      lastFailureAt: state.dashboard.ai?.lastFailureAt || "",
      suspendedUntil: state.dashboard.ai?.suspendedUntil || "",
    };
    state.savedAutomation = clone(state.dashboard.automation);
    renderAll();
    if (showMessage) showToast("Datos actualizados.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".nav-item")
      .forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle(
        "active",
        view.id === `${button.dataset.view}View`,
      );
    });
  });
});

document.querySelector("#addProductButton").addEventListener("click", () => {
  if (state.dashboard.catalog.length >= 10) {
    showToast("El catálogo admite hasta 10 productos.", true);
    return;
  }
  state.dashboard.catalog.push({
    id: "",
    name: "Nuevo producto",
    promptName: "Nuevo producto",
    sheetName: "Nuevo producto",
    emoji: "🥖",
    price: 0,
    productionWeekdays: [2],
    active: true,
  });
  renderCatalog();
});

elements.catalogRows.addEventListener("click", (event) => {
  const button = event.target.closest(".remove-product");
  if (!button) return;
  const row = button.closest(".catalog-row");
  state.dashboard.catalog.splice(Number(row.dataset.index), 1);
  renderCatalog();
});

document.querySelector("#saveCatalogButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api("/api/catalog", {
      method: "PUT",
      body: JSON.stringify({ catalog: catalogFromForm() }),
    });
    state.dashboard.catalog = result.catalog;
    renderCatalog();
    showToast("Catálogo guardado y aplicado a WhatsApp.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

elements.readyInventoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#addReadyInventoryButton");
  setLoading(button, true);
  try {
    const expiresAt = new Date(
      document.querySelector("#readyExpiresAt").value,
    );
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error("Selecciona una hora límite válida.");
    }
    await api("/api/ready-inventory", {
      method: "POST",
      body: JSON.stringify({
        productId: document.querySelector("#readyProduct").value,
        quantityAvailable: Number(
          document.querySelector("#readyQuantity").value,
        ),
        expiresAt: expiresAt.toISOString(),
        pickupEnabled: document.querySelector("#readyPickup").checked,
        deliveryEnabled: document.querySelector("#readyDelivery").checked,
        note: document.querySelector("#readyNote").value,
      }),
    });
    document.querySelector("#readyQuantity").value = "1";
    document.querySelector("#readyNote").value = "";
    document.querySelector("#readyExpiresAt").value = defaultReadyExpiry();
    await loadDashboard();
    showToast("Pan listo registrado y disponible para el agente.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

elements.readyInventoryRows.addEventListener("click", async (event) => {
  const saveButton = event.target.closest(".save-ready-batch");
  const removeButton = event.target.closest(".remove-ready-batch");
  if (!saveButton && !removeButton) return;
  const row = event.target.closest(".ready-inventory-row");
  const batchId = row?.dataset.batchId;
  if (!row || !batchId) return;

  if (removeButton) {
    if (
      !window.confirm(
        "¿Eliminar este lote? Las piezas ya reservadas en pedidos no se recuperarán.",
      )
    ) {
      return;
    }
    setLoading(removeButton, true);
    try {
      await api(`/api/ready-inventory/${encodeURIComponent(batchId)}`, {
        method: "DELETE",
      });
      await loadDashboard();
      showToast("Lote eliminado del pan listo.");
    } catch (error) {
      showToast(error.message, true);
      setLoading(removeButton, false);
    }
    return;
  }

  setLoading(saveButton, true);
  try {
    await api(`/api/ready-inventory/${encodeURIComponent(batchId)}`, {
      method: "PATCH",
      body: JSON.stringify(readyBatchFromRow(row)),
    });
    await loadDashboard();
    showToast("Disponibilidad de pan listo actualizada.");
  } catch (error) {
    showToast(error.message, true);
    setLoading(saveButton, false);
  }
});

document.querySelector("#addScheduleButton").addEventListener("click", () => {
  state.dashboard.schedules.push({
    id: "",
    name: "Nuevo día",
    weekday: 0,
    active: true,
    pickupEnabled: true,
    pickupWindow: "5:00 p.m. a 6:00 p.m.",
    deliveryEnabled: true,
    deliveryWindow: "después de las 3:00 PM",
  });
  renderSchedules();
});

elements.scheduleRows.addEventListener("click", (event) => {
  const button = event.target.closest(".remove-schedule");
  if (!button) return;
  const row = button.closest(".schedule-row");
  state.dashboard.schedules.splice(Number(row.dataset.index), 1);
  renderSchedules();
});

elements.scheduleRows.addEventListener("change", (event) => {
  if (
    event.target.matches(
      '[data-field="pickupEnabled"], [data-field="deliveryEnabled"]',
    )
  ) {
    updateScheduleServiceState(event.target);
  }
});

document.querySelector("#saveSchedulesButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api("/api/schedules", {
      method: "PUT",
      body: JSON.stringify({ schedules: schedulesFromForm() }),
    });
    state.dashboard.schedules = result.schedules;
    await loadDashboard();
    showToast("Horarios guardados y aplicados a WhatsApp.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

function openClosureDialog(date = "") {
  document.querySelector("#closureDate").value =
    date || state.dashboard.today;
  const existing = state.dashboard.closures.find(
    (closure) => closure.date === date,
  );
  document.querySelector("#closePickup").checked =
    !existing || existing.services.includes("PICKUP");
  document.querySelector("#closeDelivery").checked =
    !existing || existing.services.includes("DELIVERY");
  document.querySelector("#closureReason").value = existing?.reason || "";
  elements.closureDialog.showModal();
}

document.querySelector("#newClosureButton").addEventListener("click", () => {
  openClosureDialog();
});

elements.upcomingDates.addEventListener("click", (event) => {
  const button = event.target.closest(".close-date");
  if (button) openClosureDialog(button.dataset.date);
});

elements.closureForm.addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const services = [];
  if (document.querySelector("#closePickup").checked) services.push("PICKUP");
  if (document.querySelector("#closeDelivery").checked) services.push("DELIVERY");
  const button = document.querySelector("#confirmClosureButton");
  setLoading(button, true);
  try {
    const result = await api("/api/closures", {
      method: "POST",
      body: JSON.stringify({
        date: document.querySelector("#closureDate").value,
        services,
        reason: document.querySelector("#closureReason").value,
      }),
    });
    elements.closureDialog.close();
    await loadDashboard();
    showToast(
      `Disponibilidad actualizada. ${result.affected.length} pedidos requieren revisión.`,
    );
    await renderAffected(result.closure.id);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

elements.closureRows.addEventListener("click", async (event) => {
  const viewButton = event.target.closest(".view-affected");
  if (viewButton) {
    try {
      await renderAffected(viewButton.dataset.id);
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }
  const removeButton = event.target.closest(".remove-closure");
  if (!removeButton) return;
  if (
    !window.confirm(
      "¿Volver a habilitar los servicios marcados en esta fecha?",
    )
  ) {
    return;
  }
  try {
    await api(`/api/closures/${removeButton.dataset.id}`, {
      method: "DELETE",
    });
    elements.affectedSection.hidden = true;
    await loadDashboard();
    showToast("La excepción fue eliminada.");
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.affectedRows.addEventListener("click", async (event) => {
  const button = event.target.closest(".notify-order");
  if (!button) return;
  if (
    !window.confirm(
      "Se enviará el mensaje por WhatsApp y se cambiará la fecha del pedido. ¿Continuar?",
    )
  ) {
    return;
  }
  setLoading(button, true);
  try {
    const result = await api(
      `/api/closures/${state.selectedClosureId}/orders/${encodeURIComponent(button.dataset.orderId)}/notify`,
      { method: "POST", body: "{}" },
    );
    showToast(`Pedido reprogramado para ${result.nextSchedule.date}.`);
    await loadDashboard();
    await renderAffected(state.selectedClosureId);
  } catch (error) {
    showToast(error.message, true);
    setLoading(button, false);
  }
});

document.querySelector("#closeAffectedButton").addEventListener("click", () => {
  elements.affectedSection.hidden = true;
  state.selectedClosureId = "";
});

document.querySelector("#automationMode").addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  state.dashboard.automation.mode = button.dataset.mode;
  renderAutomation();
});

function addPhone(list, input) {
  const phone = input.value.replace(/\D/g, "");
  if (phone.length < 10 || phone.length > 15) {
    showToast(
      "Incluye el código de país y escribe entre 10 y 15 dígitos.",
      true,
    );
    return;
  }
  const automation = state.dashboard.automation;
  const target =
    list === "blocked"
      ? automation.blockedPhones
      : automation.allowedPhones;
  const opposite =
    list === "blocked"
      ? automation.allowedPhones
      : automation.blockedPhones;
  if (opposite.includes(phone)) {
    showToast(
      "Quita primero este número de la otra lista.",
      true,
    );
    return;
  }
  if (!target.includes(phone)) target.push(phone);
  input.value = "";
  renderAutomation();
}

document.querySelector("#allowedPhoneForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addPhone("allowed", document.querySelector("#allowedPhoneInput"));
});

document.querySelector("#blockedPhoneForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addPhone("blocked", document.querySelector("#blockedPhoneInput"));
});

document.querySelector("#automationView").addEventListener("click", (event) => {
  const button = event.target.closest(".remove-phone");
  if (!button) return;
  const key =
    button.dataset.list === "blocked"
      ? "blockedPhones"
      : "allowedPhones";
  state.dashboard.automation[key] =
    state.dashboard.automation[key].filter(
      (phone) => phone !== button.dataset.phone,
    );
  renderAutomation();
});

document.querySelector("#saveAutomationButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!automationChanged()) return;
  if (
    state.savedAutomation.mode !== "NORMAL" &&
    state.dashboard.automation.mode === "NORMAL" &&
    !window.confirm(
      "Vas a activar PRODUCCIÓN. El bot responderá a todos los clientes excepto a los números bloqueados. ¿Deseas continuar?",
    )
  ) {
    return;
  }
  setLoading(button, true);
  try {
    const result = await api("/api/automation", {
      method: "PUT",
      body: JSON.stringify({
        automation: state.dashboard.automation,
      }),
    });
    state.dashboard.automation = result.automation;
    state.savedAutomation = clone(result.automation);
    state.dashboard.testMode = result.automation.mode === "TESTING";
    renderAll();
    showToast(
      result.automation.mode === "NORMAL"
        ? "Modo PRODUCCIÓN activado."
        : "Modo SOLO PRUEBAS activado.",
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
    renderAutomation();
  }
});

document.querySelector("#refreshButton").addEventListener("click", () => {
  loadDashboard(true);
});

document.querySelector("#botPowerButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const enable = state.dashboard.botEnabled === false;
  const action = enable ? "continuar" : "pausar";
  if (!window.confirm(`¿Deseas ${action} el bot para todos los chats?`)) return;
  setLoading(button, true);
  try {
    const result = await api("/api/bot-control", {
      method: "PUT",
      body: JSON.stringify({ enabled: enable }),
    });
    state.dashboard.botEnabled = result.enabled;
    renderBotPower();
    showToast(result.enabled
      ? "El bot está activo para recibir mensajes."
      : "El bot está pausado para todos los chats.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

document.querySelector("#saveAiButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const enabled = document.querySelector("#aiEnabled").checked;
  setLoading(button, true);
  try {
    const result = await api("/api/ai", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    state.dashboard.ai = result.ai;
    renderAi();
    showToast(result.ai.operational
      ? "Inteligencia artificial activada."
      : "Inteligencia artificial desactivada; continúa el flujo seguro.");
  } catch (error) {
    showToast(error.message, true);
    await loadDashboard();
  } finally {
    setLoading(button, false);
  }
});

document.querySelector("#testAiButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api("/api/ai/test", {
      method: "POST",
      body: "{}",
    });
    state.dashboard.ai = result.ai;
    renderAi();
    showToast("Conexión con OpenAI verificada correctamente.");
  } catch (error) {
    showToast(error.message, true);
    await loadDashboard();
  } finally {
    setLoading(button, false);
  }
});

document.querySelector("#savePromotionsButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setLoading(button, true);
  try {
    const result = await api("/api/promotions", {
      method: "PUT",
      body: JSON.stringify({
        promotions: {
          freeBramptonDelivery: document.querySelector("#freeBramptonDelivery").checked,
        },
      }),
    });
    state.dashboard.promotions = result.promotions;
    showToast(result.promotions.freeBramptonDelivery
      ? "Delivery gratis en Brampton activado."
      : "Delivery gratis en Brampton desactivado.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setLoading(button, false);
  }
});

loadDashboard();
icons();
