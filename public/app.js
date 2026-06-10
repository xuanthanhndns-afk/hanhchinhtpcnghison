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
  return Number(value || 0).toLocaleString("vi-VN") + " đ";
}

function shiftLabel(shift) {
  return shift === "lunch" ? "Trưa" : "Tối";
}

function roleLabel(role) {
  return {
    admin: "Admin",
    kitchen: "Nhà bếp",
    accountant: "Kế toán",
    worker: "Công nhân",
  }[role] || role;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Lỗi hệ thống");
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
      <h1>Quản lý cơm ca</h1>
      <p class="muted">Đăng nhập bằng mã nhân viên hoặc tài khoản được cấp.</p>
      <form id="loginForm">
        <label>Mã đăng nhập
          <input name="employeeCode" value="admin" autocomplete="username" />
        </label>
        <label>Mật khẩu
          <input name="password" type="password" value="123456" autocomplete="current-password" />
        </label>
        <button>Đăng nhập</button>
        <div id="loginMessage"></div>
      </form>
      <p class="muted">Mẫu: admin / kitchen / accountant / CN001, mật khẩu 123456.</p>
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
          <div class="mark">CC</div>
          <div>
            <h1>Hệ thống quản lý cơm ca</h1>
            <p>${state.user.fullName} · ${roleLabel(state.user.role)} · ${state.user.department}</p>
          </div>
        </div>
        <div class="actions">
          <span class="userline">Giờ chốt: ${state.settings.cutoffTime}</span>
          <button class="secondary" id="logoutBtn">Đăng xuất</button>
        </div>
      </header>
      <main class="main">
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
  if (state.user.role === "worker") tabs.push(["worker", "Đăng ký của tôi"]);
  if (["admin", "kitchen"].includes(state.user.role)) tabs.push(["kitchen", "Nhà bếp"]);
  if (["admin", "kitchen", "accountant"].includes(state.user.role)) tabs.push(["daily", "Báo cáo ngày"]);
  if (["admin", "accountant", "kitchen", "worker"].includes(state.user.role)) tabs.push(["monthly", "Công nợ tháng"]);
  if (["admin", "accountant"].includes(state.user.role)) tabs.push(["reconcile", "Đối soát & Telegram"]);
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
  if (!order) return `<span class="status">Chưa đăng ký</span>`;
  const labels = {
    registered: "Đã đăng ký",
    locked: "Đã chốt",
    added_after_cutoff: "Bếp bổ sung",
    cancelled_before_cutoff: "Đã hủy trước 08h",
    cancelled_by_admin: "Hủy đặc biệt",
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
        <h2>Đăng ký cơm</h2>
        <div class="row">
          <label>Ngày ăn
            <input id="workerDate" type="date" value="${today}" />
          </label>
          <button id="reloadWorker" class="secondary">Xem ngày</button>
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
  container.innerHTML = html`
    <div class="grid">
      ${["lunch", "dinner"].map((shift) => renderMealCard(date, shift)).join("")}
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

function renderMealCard(date, shift) {
  const menu = menuFor(date, shift);
  const order = orderFor(date, shift);
  return html`
    <article class="panel span-6">
      <h3>Ca ${shiftLabel(shift)}</h3>
      <p>${menu ? menu.dishes : "Nhà bếp chưa nhập thực đơn."}</p>
      <p class="muted">Đơn giá: ${money(menu ? menu.price : state.settings.defaultMealPrice)}</p>
      <p>${statusBadge(order)}</p>
      <div class="actions">
        <button data-register data-date="${date}" data-shift="${shift}">Đăng ký</button>
        <button class="danger" data-cancel data-date="${date}" data-shift="${shift}">Hủy</button>
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
        <h2>Nhập/sửa thực đơn</h2>
        <form id="menuForm" class="form-grid">
          <label>Ngày ăn <input name="mealDate" type="date" value="${today}" /></label>
          <label>Ca ăn
            <select name="shift">
              <option value="lunch">Trưa</option>
              <option value="dinner">Tối</option>
            </select>
          </label>
          <label>Món ăn <textarea name="dishes" placeholder="Cơm, món mặn, rau, canh"></textarea></label>
          <label>Định mức dự kiến <input name="plannedQty" type="number" value="300" /></label>
          <label>Đơn giá <input name="price" type="number" value="${state.settings.defaultMealPrice}" /></label>
          <label>Ghi chú <input name="note" /></label>
          <button>Lưu thực đơn</button>
          <div id="menuMessage"></div>
        </form>
      </section>
      <section class="panel span-6">
        <h2>Bổ sung suất sau 08h</h2>
        <form id="addOrderForm" class="form-grid">
          <label>Ngày ăn <input name="mealDate" type="date" value="${today}" /></label>
          <label>Mã nhân viên
            <select name="employeeCode">
              ${state.users
                .filter((u) => u.role === "worker")
                .map((u) => `<option value="${u.employeeCode}">${u.employeeCode} - ${u.fullName}</option>`)
                .join("")}
            </select>
          </label>
          <label>Ca ăn
            <select name="shift">
              <option value="lunch">Trưa</option>
              <option value="dinner">Tối</option>
            </select>
          </label>
          <label>Ghi chú <input name="note" placeholder="Đăng ký trực tiếp với bếp" /></label>
          <button>Bổ sung suất</button>
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
      setMessage("#menuMessage", "Đã lưu thực đơn.", "success");
    } catch (err) {
      setMessage("#menuMessage", err.message, "error");
    }
  });
  document.querySelector("#addOrderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/orders/register", { method: "POST", body: JSON.stringify(body) });
      setMessage("#kitchenMessage", "Đã bổ sung suất.", "success");
    } catch (err) {
      setMessage("#kitchenMessage", err.message, "error");
    }
  });
}

function renderDaily() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <section class="panel">
      <h2>Báo cáo số suất theo ngày</h2>
      <div class="row">
        <label>Ngày ăn <input id="dailyDate" type="date" value="${today}" /></label>
        <button id="loadDaily">Xem báo cáo</button>
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
          (s) => `<div class="metric"><span>${s.shiftLabel}</span><strong>${s.totalQty}</strong><small>Định mức ${s.plannedQty}, bổ sung ${s.addedAfterCutoffQty}</small></div>`
        )
        .join("")}
    </div>
    <h3>Danh sách chi tiết</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Mã NV</th><th>Họ tên</th><th>Bộ phận</th><th>Ca</th><th>Giá</th><th>Trạng thái</th><th>Nguồn</th></tr></thead>
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
      <h2>Công nợ tiền cơm tháng</h2>
      <div class="row">
        <label>Tháng <input id="monthInput" type="month" value="${currentMonth}" /></label>
        <button id="loadMonthly">Xem công nợ</button>
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
          <tr><th>Mã NV</th><th>Họ tên</th><th>Bộ phận</th><th>Trưa</th><th>Tối</th><th>Tổng tiền</th><th>Nội dung CK</th><th>QR</th><th>Trạng thái</th><th></th></tr>
        </thead>
        <tbody>
          ${data.debts
            .map(
              (d) => `<tr>
                <td>${d.employeeCode}</td><td>${d.fullName}</td><td>${d.department}</td><td>${d.lunchQty}</td><td>${d.dinnerQty}</td><td>${money(d.totalAmount)}</td>
                <td>${d.paymentCode}</td><td><img class="qr" src="${d.qrUrl}" alt="QR ${d.employeeCode}" /></td>
                <td><span class="status ${d.status === "paid" ? "ok" : "warn"}">${d.status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}</span></td>
                <td>${["admin", "accountant"].includes(state.user.role) ? `<button data-paid="${d.employeeCode}" data-month="${data.month}">Đã thu</button>` : ""}</td>
              </tr>`
            )
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
      loadMonthlyReport();
    });
  });
}

function renderReconcile() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Đối soát sao kê CSV</h2>
        <div class="form-grid">
          <label>Tháng <input id="reconcileMonth" type="month" value="${currentMonth}" /></label>
          <label>Nội dung CSV
            <textarea id="csvInput">date,amount,description
2026-07-01,625000,CN001 COM T06-2026</textarea>
          </label>
          <button id="reconcileBtn">Đối soát</button>
        </div>
        <div id="reconcileResult"></div>
      </section>
      <section class="panel span-6">
        <h2>Nhắc Telegram</h2>
        <p class="muted">Gửi nhắc cho các công nhân còn chưa thanh toán trong tháng đã chọn. Server cần có TELEGRAM_BOT_TOKEN.</p>
        <div class="form-grid">
          <label>Tháng <input id="telegramMonth" type="month" value="${currentMonth}" /></label>
          <button id="telegramBtn">Gửi nhắc</button>
        </div>
        <div id="telegramResult"></div>
      </section>
    </div>
  `;
  document.querySelector("#reconcileBtn").addEventListener("click", reconcileCsv);
  document.querySelector("#telegramBtn").addEventListener("click", sendTelegramReminders);
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
    document.querySelector("#reconcileResult").innerHTML = `<p class="success">Khớp ${data.matched.length} giao dịch, chưa khớp ${data.unmatched.length} giao dịch.</p>`;
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
    document.querySelector("#telegramResult").innerHTML = `<p class="success">Đã xử lý ${data.results.length} tin nhắn.</p>`;
  } catch (err) {
    setMessage("#telegramResult", err.message, "error");
  }
}

init().catch((err) => {
  app.innerHTML = `<main class="login"><h1>Lỗi</h1><p class="error">${err.message}</p></main>`;
});
