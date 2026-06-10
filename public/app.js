const app = document.querySelector("#app");

const state = {
  user: null,
  settings: null,
  users: [],
  menus: [],
  orders: [],
  tab: "worker",
};

const today = new Date().toISOString().slice(0, 10);
const currentMonth = new Date().toISOString().slice(0, 7);

function money(value) {
  return Number(value || 0).toLocaleString("vi-VN") + " d";
}

function shiftLabel(shift) {
  return shift === "lunch" ? "Trua" : "Toi";
}

function roleLabel(role) {
  return {
    admin: "Admin",
    kitchen: "Nha bep",
    accountant: "Ke toan",
    worker: "Cong nhan",
  }[role] || role;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Loi he thong");
  return data;
}

function html(strings, ...values) {
  return strings.map((s, i) => s + (values[i] ?? "")).join("");
}

function setMessage(target, text, kind = "") {
  const el = document.querySelector(target);
  if (el) el.innerHTML = text ? `<p class="${kind}">${text}</p>` : "";
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  Object.assign(state, data);
}

async function init() {
  const data = await api("/api/me");
  state.user = data.user;
  if (!state.user) return renderLogin();
  state.tab = state.user.role === "worker" ? "worker" : "kitchen";
  await loadBootstrap();
  renderShell();
}

function renderLogin() {
  app.innerHTML = html`
    <main class="login">
      <img class="login-logo" src="/logo.jpg" alt="EVNGENCO1 Cong ty Nhiet dien Nghi Son" />
      <h1>Quan ly com ca</h1>
      <p class="muted">Cong nhan dang nhap bang so dien thoai. Tai khoan noi bo co the dung ma duoc cap.</p>
      <form id="loginForm">
        <label>So dien thoai / tai khoan
          <input name="loginId" value="0901000001" autocomplete="username" />
        </label>
        <label>Mat khau
          <input name="password" type="password" value="123456" autocomplete="current-password" />
        </label>
        <button>Dang nhap</button>
        <div id="loginMessage"></div>
      </form>
      <p class="muted">Mau: 0901000001 / 0901000002 / 0901000003, mat khau 123456. Noi bo: admin, kitchen, accountant.</p>
    </main>
  `;
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(form.entries())),
      });
      await init();
    } catch (err) {
      setMessage("#loginMessage", err.message, "error");
    }
  });
}

function renderShell() {
  app.innerHTML = html`
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="/logo.jpg" alt="EVNGENCO1" />
          <div>
            <h1>He thong quan ly com ca</h1>
            <p>${state.user.fullName} - ${roleLabel(state.user.role)} - ${state.user.department}</p>
          </div>
        </div>
        <div class="actions">
          <span class="userline">Gio chot: ${state.settings.cutoffTime}</span>
          <button class="secondary" id="logoutBtn">Dang xuat</button>
        </div>
      </header>
      <main class="main">
        ${state.user.registrationLockedNow ? `<div class="notice bad-notice">Tai khoan dang bi khoa dang ky: ${state.user.lockReasonNow}</div>` : ""}
        ${state.user.mustChangePassword ? `<div class="notice">Anh/chi dang dung mat khau mac dinh. Vao tab Ho so de doi mat khau.</div>` : ""}
        ${renderTabs()}
        <section id="view"></section>
      </main>
    </div>
  `;
  document.querySelector("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST", body: "{}" });
    state.user = null;
    renderLogin();
  });
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      renderShell();
    });
  });
  renderView();
}

function renderTabs() {
  const tabs = [];
  if (state.user.role === "worker") tabs.push(["worker", "Dang ky cua toi"]);
  if (["admin", "kitchen"].includes(state.user.role)) tabs.push(["kitchen", "Nha bep"]);
  if (["admin", "kitchen", "accountant"].includes(state.user.role)) tabs.push(["daily", "Bao cao ngay"]);
  if (["admin", "accountant", "kitchen", "worker"].includes(state.user.role)) tabs.push(["monthly", "Cong no thang"]);
  if (["admin", "accountant"].includes(state.user.role)) tabs.push(["reconcile", "Doi soat & Telegram"]);
  tabs.push(["profile", "Ho so"]);
  return `<nav class="tabs">${tabs
    .map(([id, label]) => `<button class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`)
    .join("")}</nav>`;
}

function renderView() {
  if (state.tab === "worker") return renderWorker();
  if (state.tab === "kitchen") return renderKitchen();
  if (state.tab === "daily") return renderDaily();
  if (state.tab === "monthly") return renderMonthly();
  if (state.tab === "reconcile") return renderReconcile();
  if (state.tab === "profile") return renderProfile();
}

function menuFor(date, shift) {
  return state.menus.find((m) => m.mealDate === date && m.shift === shift);
}

async function loadOrders(date = "") {
  const data = await api(`/api/orders${date ? `?mealDate=${encodeURIComponent(date)}` : ""}`);
  state.orders = data.orders;
}

function orderFor(date, shift, employeeCode = state.user.employeeCode) {
  return state.orders.find((o) => o.mealDate === date && o.shift === shift && o.employeeCode === employeeCode);
}

function statusBadge(order) {
  if (!order) return `<span class="status">Chua dang ky</span>`;
  const labels = {
    registered: "Da dang ky",
    locked: "Da chot",
    added_after_cutoff: "Bep bo sung",
    cancelled_before_cutoff: "Da huy truoc 08h",
    cancelled_by_admin: "Huy dac biet",
  };
  const cls = ["registered", "locked", "added_after_cutoff"].includes(order.status) ? "ok" : "bad";
  return `<span class="status ${cls}">${labels[order.status] || order.status}</span>`;
}

async function renderWorker() {
  await loadOrders();
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-12">
        <h2>Dang ky com</h2>
        <div class="row">
          <label>Ngay an
            <input id="workerDate" type="date" value="${today}" />
          </label>
          <button id="reloadWorker" class="secondary">Xem ngay</button>
        </div>
        <div id="workerMeals"></div>
      </section>
    </div>
  `;
  document.querySelector("#reloadWorker").addEventListener("click", renderWorkerMeals);
  document.querySelector("#workerDate").addEventListener("change", renderWorkerMeals);
  renderWorkerMeals();
}

function renderWorkerMeals() {
  const date = document.querySelector("#workerDate").value;
  const container = document.querySelector("#workerMeals");
  const disabled = state.user.registrationLockedNow ? "disabled" : "";
  container.innerHTML = html`
    ${state.user.registrationLockedNow ? `<div class="notice bad-notice">Khong the dang ky com cho den khi thanh toan thanh cong.</div>` : ""}
    <div class="grid">
      ${["lunch", "dinner"].map((shift) => renderMealCard(date, shift, disabled)).join("")}
    </div>
    <div id="workerMessage"></div>
  `;
  container.querySelectorAll("[data-register]").forEach((btn) => {
    btn.addEventListener("click", () => registerOrder(btn.dataset.date, btn.dataset.shift));
  });
  container.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => cancelOrder(btn.dataset.date, btn.dataset.shift));
  });
}

function renderMealCard(date, shift, disabled) {
  const menu = menuFor(date, shift);
  const order = orderFor(date, shift);
  return html`
    <article class="panel span-6">
      <h3>Ca ${shiftLabel(shift)}</h3>
      <p>${menu ? menu.dishes : "Nha bep chua nhap thuc don."}</p>
      <p class="muted">Don gia: ${money(menu ? menu.price : state.settings.defaultMealPrice)}</p>
      <p>${statusBadge(order)}</p>
      <div class="actions">
        <button ${disabled} data-register data-date="${date}" data-shift="${shift}">Dang ky</button>
        <button class="danger" data-cancel data-date="${date}" data-shift="${shift}">Huy</button>
      </div>
    </article>
  `;
}

async function registerOrder(date, shift, employeeCode = "") {
  try {
    await api("/api/orders/register", {
      method: "POST",
      body: JSON.stringify({ mealDate: date, shift, employeeCode }),
    });
    await loadBootstrap();
    await loadOrders(date);
    if (state.tab === "worker") renderWorkerMeals();
    if (state.tab === "kitchen") renderKitchen();
  } catch (err) {
    setMessage(state.tab === "worker" ? "#workerMessage" : "#kitchenMessage", err.message, "error");
  }
}

async function cancelOrder(date, shift, employeeCode = "") {
  try {
    await api("/api/orders/cancel", {
      method: "POST",
      body: JSON.stringify({ mealDate: date, shift, employeeCode }),
    });
    await loadBootstrap();
    await loadOrders(date);
    if (state.tab === "worker") renderWorkerMeals();
    if (state.tab === "kitchen") renderKitchen();
  } catch (err) {
    setMessage(state.tab === "worker" ? "#workerMessage" : "#kitchenMessage", err.message, "error");
  }
}

function renderKitchen() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Nhap/sua thuc don</h2>
        <form id="menuForm" class="form-grid">
          <label>Ngay an <input name="mealDate" type="date" value="${today}" /></label>
          <label>Ca an
            <select name="shift">
              <option value="lunch">Trua</option>
              <option value="dinner">Toi</option>
            </select>
          </label>
          <label>Mon an <textarea name="dishes" placeholder="Com, mon man, rau, canh"></textarea></label>
          <label>Dinh muc du kien <input name="plannedQty" type="number" value="300" /></label>
          <label>Don gia <input name="price" type="number" value="${state.settings.defaultMealPrice}" /></label>
          <label>Ghi chu <input name="note" /></label>
          <button>Luu thuc don</button>
          <div id="menuMessage"></div>
        </form>
      </section>
      <section class="panel span-6">
        <h2>Bo sung suat sau 08h</h2>
        <form id="addOrderForm" class="form-grid">
          <label>Ngay an <input name="mealDate" type="date" value="${today}" /></label>
          <label>Ma nhan vien
            <select name="employeeCode">
              ${state.users
                .filter((u) => u.role === "worker")
                .map((u) => `<option value="${u.employeeCode}">${u.employeeCode} - ${u.phone || ""} - ${u.fullName}</option>`)
                .join("")}
            </select>
          </label>
          <label>Ca an
            <select name="shift">
              <option value="lunch">Trua</option>
              <option value="dinner">Toi</option>
            </select>
          </label>
          <label>Ghi chu <input name="note" placeholder="Dang ky truc tiep voi bep" /></label>
          <button>Bo sung suat</button>
          <div id="kitchenMessage"></div>
        </form>
      </section>
    </div>
  `;
  document.querySelector("#menuForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/menus", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      await loadBootstrap();
      setMessage("#menuMessage", "Da luu thuc don.", "success");
    } catch (err) {
      setMessage("#menuMessage", err.message, "error");
    }
  });
  document.querySelector("#addOrderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/orders/register", { method: "POST", body: JSON.stringify(body) });
      setMessage("#kitchenMessage", "Da bo sung suat.", "success");
    } catch (err) {
      setMessage("#kitchenMessage", err.message, "error");
    }
  });
}

function renderDaily() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <section class="panel">
      <h2>Bao cao so suat theo ngay</h2>
      <div class="row">
        <label>Ngay an <input id="dailyDate" type="date" value="${today}" /></label>
        <button id="loadDaily">Xem bao cao</button>
      </div>
      <div id="dailyContent"></div>
    </section>
  `;
  document.querySelector("#loadDaily").addEventListener("click", loadDailyReport);
  loadDailyReport();
}

async function loadDailyReport() {
  const date = document.querySelector("#dailyDate").value;
  const data = await api(`/api/reports/daily?mealDate=${encodeURIComponent(date)}`);
  document.querySelector("#dailyContent").innerHTML = html`
    <div class="summary">
      ${data.summary
        .map(
          (s) => `<div class="metric"><span>${s.shiftLabel}</span><strong>${s.totalQty}</strong><small>Dinh muc ${s.plannedQty}, bo sung ${s.addedAfterCutoffQty}</small></div>`
        )
        .join("")}
    </div>
    <h3>Danh sach chi tiet</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Ma NV</th><th>Ho ten</th><th>Bo phan</th><th>Ca</th><th>Gia</th><th>Trang thai</th><th>Nguon</th></tr></thead>
        <tbody>
          ${data.orders
            .map(
              (o) => `<tr><td>${o.employeeCode}</td><td>${o.fullName}</td><td>${o.department}</td><td>${shiftLabel(o.shift)}</td><td>${money(o.price)}</td><td>${o.status}</td><td>${o.source}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMonthly() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <section class="panel">
      <h2>Cong no tien com thang</h2>
      <div class="row">
        <label>Thang <input id="monthInput" type="month" value="${currentMonth}" /></label>
        <button id="loadMonthly">Xem cong no</button>
      </div>
      <div id="monthlyContent"></div>
    </section>
  `;
  document.querySelector("#loadMonthly").addEventListener("click", loadMonthlyReport);
  loadMonthlyReport();
}

async function loadMonthlyReport() {
  const month = document.querySelector("#monthInput").value;
  const data = await api(`/api/reports/monthly?month=${encodeURIComponent(month)}`);
  document.querySelector("#monthlyContent").innerHTML = html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Ma NV</th><th>So dien thoai</th><th>Ho ten</th><th>Bo phan</th><th>Trua</th><th>Toi</th><th>Tong tien</th><th>Noi dung CK</th><th>QR</th><th>Trang thai</th><th></th></tr>
        </thead>
        <tbody>
          ${data.debts
            .map((d) => {
              const user = state.users.find((u) => u.employeeCode === d.employeeCode) || {};
              return `<tr>
                <td>${d.employeeCode}</td><td>${user.phone || state.user.phone || ""}</td><td>${d.fullName}</td><td>${d.department}</td><td>${d.lunchQty}</td><td>${d.dinnerQty}</td><td>${money(d.totalAmount)}</td>
                <td>${d.paymentCode}</td><td><img class="qr" src="${d.qrUrl}" alt="QR ${d.employeeCode}" /></td>
                <td><span class="status ${d.status === "paid" ? "ok" : "warn"}">${d.status === "paid" ? "Da thanh toan" : "Chua thanh toan"}</span></td>
                <td>${["admin", "accountant"].includes(state.user.role) ? `<button data-paid="${d.employeeCode}" data-month="${data.month}">Da thu</button>` : ""}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
  document.querySelectorAll("[data-paid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api("/api/payments/mark-paid", {
        method: "POST",
        body: JSON.stringify({ employeeCode: btn.dataset.paid, month: btn.dataset.month }),
      });
      await loadBootstrap();
      loadMonthlyReport();
    });
  });
}

function renderReconcile() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Doi soat sao ke CSV</h2>
        <div class="form-grid">
          <label>Thang <input id="reconcileMonth" type="month" value="${currentMonth}" /></label>
          <label>Noi dung CSV
            <textarea id="csvInput">date,amount,description
2026-07-01,625000,0901000001 COM T06-2026</textarea>
          </label>
          <button id="reconcileBtn">Doi soat</button>
        </div>
        <div id="reconcileResult"></div>
      </section>
      <section class="panel span-6">
        <h2>Nhac Telegram va khoa qua han</h2>
        <p class="muted">Sau ${state.settings.paymentGraceDays || 5} ngay cua thang ke tiep, neu chua thanh toan thi he thong nhac va khoa quyen dang ky cua cong nhan.</p>
        <div class="form-grid">
          <label>Thang <input id="telegramMonth" type="month" value="${currentMonth}" /></label>
          <button id="telegramBtn">Gui nhac / khoa neu qua han</button>
        </div>
        <div id="telegramResult"></div>
      </section>
      <section class="panel span-12">
        <h2>Danh sach dang bi khoa</h2>
        <button id="loadLocked" class="secondary">Tai danh sach</button>
        <div id="lockedContent"></div>
      </section>
    </div>
  `;
  document.querySelector("#reconcileBtn").addEventListener("click", reconcileCsv);
  document.querySelector("#telegramBtn").addEventListener("click", sendTelegramReminders);
  document.querySelector("#loadLocked").addEventListener("click", loadLockedUsers);
  loadLockedUsers();
}

async function reconcileCsv() {
  try {
    const data = await api("/api/payments/reconcile-csv", {
      method: "POST",
      body: JSON.stringify({
        month: document.querySelector("#reconcileMonth").value,
        csv: document.querySelector("#csvInput").value,
      }),
    });
    document.querySelector("#reconcileResult").innerHTML = `<p class="success">Khop ${data.matched.length} giao dich, chua khop ${data.unmatched.length} giao dich.</p>`;
    await loadBootstrap();
    loadLockedUsers();
  } catch (err) {
    setMessage("#reconcileResult", err.message, "error");
  }
}

async function sendTelegramReminders() {
  try {
    const data = await api("/api/telegram/remind", {
      method: "POST",
      body: JSON.stringify({ month: document.querySelector("#telegramMonth").value }),
    });
    document.querySelector("#telegramResult").innerHTML = `<p class="success">Da xu ly ${data.results.length} tin nhan/nhac no.</p>`;
    await loadBootstrap();
    loadLockedUsers();
  } catch (err) {
    setMessage("#telegramResult", err.message, "error");
  }
}

async function loadLockedUsers() {
  const target = document.querySelector("#lockedContent");
  if (!target) return;
  try {
    const data = await api("/api/reports/locked-users");
    target.innerHTML = html`
      <div class="table-wrap">
        <table>
          <thead><tr><th>Ma NV</th><th>So dien thoai</th><th>Ho ten</th><th>Bo phan</th><th>Ly do</th></tr></thead>
          <tbody>
            ${data.rows
              .map((r) => `<tr><td>${r.user.employeeCode}</td><td>${r.user.phone || ""}</td><td>${r.user.fullName}</td><td>${r.user.department}</td><td>${r.lock.reason}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    target.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function renderProfile() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Thong tin tai khoan</h2>
        <p><strong>Ho ten:</strong> ${state.user.fullName}</p>
        <p><strong>Ma NV:</strong> ${state.user.employeeCode}</p>
        <p><strong>So dien thoai dang nhap:</strong> ${state.user.phone || ""}</p>
        <p><strong>Telegram Chat ID:</strong> ${state.user.telegramChatId || "Chua lien ket"}</p>
        <p class="muted">Telegram Bot khong gui truc tiep theo so dien thoai neu nguoi dung chua lien ket bot. Anh/chị can lay Telegram Chat ID va luu vao day.</p>
      </section>
      <section class="panel span-6">
        <h2>Doi mat khau</h2>
        <form id="passwordForm" class="form-grid">
          <label>Mat khau hien tai <input name="currentPassword" type="password" /></label>
          <label>Mat khau moi <input name="newPassword" type="password" /></label>
          <button>Doi mat khau</button>
          <div id="passwordMessage"></div>
        </form>
      </section>
      <section class="panel span-6">
        <h2>Lien ket Telegram</h2>
        <form id="telegramProfileForm" class="form-grid">
          <label>Telegram Chat ID <input name="telegramChatId" value="${state.user.telegramChatId || ""}" /></label>
          <button>Luu Telegram</button>
          <div id="profileTelegramMessage"></div>
        </form>
      </section>
    </div>
  `;
  document.querySelector("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/profile/change-password", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      await loadBootstrap();
      setMessage("#passwordMessage", "Da doi mat khau.", "success");
      renderShell();
    } catch (err) {
      setMessage("#passwordMessage", err.message, "error");
    }
  });
  document.querySelector("#telegramProfileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/profile/telegram", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      await loadBootstrap();
      setMessage("#profileTelegramMessage", "Da luu Telegram Chat ID.", "success");
    } catch (err) {
      setMessage("#profileTelegramMessage", err.message, "error");
    }
  });
}

init().catch((err) => {
  app.innerHTML = `<main class="login"><h1>Loi</h1><p class="error">${err.message}</p></main>`;
});
