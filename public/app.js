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

const state = {
  dashboard: null,
  selectedClosureId: "",
  savedAutomation: null,
};

const elements = {
  catalogRows: document.querySelector("#catalogRows"),
  catalogSummary: document.querySelector("#catalogSummary"),
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
          <input data-field="sheetName" value="${escapeHtml(product.sheetName)}" aria-label="Nombre en cocina">
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
      return {
        id: existing.id,
        emoji: row.querySelector('[data-field="emoji"]').value,
        name: row.querySelector('[data-field="name"]').value,
        promptName: row.querySelector('[data-field="name"]').value,
        sheetName: row.querySelector('[data-field="sheetName"]').value,
        price: Number(row.querySelector('[data-field="price"]').value),
        active: row.querySelector('[data-field="active"]').checked,
      };
    },
  );
}

function renderSchedules() {
  elements.scheduleRows.innerHTML = state.dashboard.schedules
    .map(
      (schedule, index) => `
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
          <div class="service-editor">
            <label class="switch-line">
              <span class="switch">
                <input data-field="pickupEnabled" type="checkbox" ${schedule.pickupEnabled ? "checked" : ""}>
                <span></span>
              </span>
              Pickup
            </label>
            <input data-field="pickupWindow" value="${escapeHtml(schedule.pickupWindow)}" aria-label="Horario de pickup">
          </div>
          <div class="service-editor delivery">
            <label class="switch-line">
              <span class="switch">
                <input data-field="deliveryEnabled" type="checkbox" ${schedule.deliveryEnabled ? "checked" : ""}>
                <span></span>
              </span>
              Delivery
            </label>
            <input data-field="deliveryWindow" value="${escapeHtml(schedule.deliveryWindow)}" aria-label="Horario de delivery">
          </div>
          <button class="icon-button danger-icon remove-schedule" title="Eliminar día" ${state.dashboard.schedules.length === 1 ? "disabled" : ""}>
            <i data-lucide="trash-2"></i>
          </button>
        </div>`,
    )
    .join("");
  icons();
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
  renderSchedules();
  renderRescheduling();
  renderAutomation();
}

async function loadDashboard(showMessage = false) {
  const button = document.querySelector("#refreshButton");
  setLoading(button, true);
  try {
    state.dashboard = await api("/api/dashboard");
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

loadDashboard();
icons();
