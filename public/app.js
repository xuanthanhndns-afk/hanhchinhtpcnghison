const app = document.querySelector("#app");

const state = {
  user: null,
  settings: null,
  users: [],
  menus: [],
  orders: [],
  chefs: [],
  tab: "worker",
  adminTab: "members",
  kitchenTab: "menu",
  dailyReport: null,
  monthlyReport: null,
};

const today = new Date().toISOString().slice(0, 10);
const currentMonth = new Date().toISOString().slice(0, 7);

function money(value) {
  return Number(value || 0).toLocaleString("vi-VN") + " đ";
}

function escapeExcel(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excelTable(title, headers, rows) {
  return `
    <h3>${escapeExcel(title)}</h3>
    <table border="1">
      <thead><tr>${headers.map((header) => `<th>${escapeExcel(header)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows
          .map((row) => `<tr>${row.map((cell) => `<td style="mso-number-format:'\\@';">${escapeExcel(cell)}</td>`).join("")}</tr>`)
          .join("")}
      </tbody>
    </table>
    <br />
  `;
}

function downloadExcel(filename, title, sections) {
  const body = sections.map((section) => excelTable(section.title, section.headers, section.rows)).join("");
  const content = `<!doctype html>
    <html>
      <head><meta charset="UTF-8" /></head>
      <body>
        <h2>${escapeExcel(title)}</h2>
        ${body}
      </body>
    </html>`;
  const blob = new Blob(["\ufeff", content], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function shiftLabel(shift) {
  return shift === "lunch" ? "Trưa" : "Tối";
}

function roleLabel(role) {
  return {
    admin: "Admin",
    kitchen: "Nhà bếp",
    worker: "Công nhân",
  }[role] || role;
}

function userDisplayLine(user) {
  if (user.role === "admin") {
    return "Admin";
  }
  if (user.role !== "worker") {
    return `${user.fullName} - ${roleLabel(user.role)} - ${user.department || ""}`;
  }
  return `Họ và tên: ${user.fullName} | Số điện thoại: ${user.phone || ""} | Bộ phận công tác: ${user.department || ""}`;
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

function telegramTemplates() {
  const defaults = {
    debtNotice:
      "Kinh gui {hoTen}, tien com thang {thang} cua Anh/Chi la {soTien} dong. Vui long chuyen khoan voi noi dung: {maThanhToan}.",
    debtReminder:
      "Nhac no: Anh/Chi {hoTen} con tien com thang {thang} la {soTien} dong. Vui long thanh toan voi noi dung: {maThanhToan}. {ghiChuKhoa}",
  };
  return { ...defaults, ...((state.settings && state.settings.telegramTemplates) || {}) };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(new Error("Không đọc được file Excel."));
    reader.readAsDataURL(file);
  });
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  Object.assign(state, data);
}

async function init() {
  const data = await api("/api/me");
  state.user = data.user;
  if (!state.user) return renderLogin();
  state.tab = state.user.role === "worker" ? "worker" : state.user.role === "admin" ? "admin" : "kitchen";
  await loadBootstrap();
  renderShell();
}

function renderLogin() {
  app.innerHTML = html`
    <main class="login">
      <img class="login-logo" src="/logo.jpg" alt="EVNGENCO1 Công ty Nhiệt điện Nghi Sơn" />
      <h1>Hệ thống quản lý cơm ca</h1>
      <p class="muted login-intro">Bạn là thành viên của gia đình EVNGENCO1TPCNGHISON hãy đăng nhập bằng số điện thoại đã đăng ký để sử dụng hệ thống.</p>
      <form id="loginForm">
        <label>Số điện thoại / tài khoản
          <input name="loginId" value="0901000001" autocomplete="username" />
        </label>
        ${passwordField("Mật khẩu", "password", "current-password")}
        <button>Đăng nhập</button>
        <div id="loginMessage"></div>
      </form>
      <p class="muted login-help"><button type="button" id="forgotPasswordBtn" class="link-button">Quên mật khẩu?</button></p>
      <section id="forgotPasswordPanel" class="forgot-panel hidden">
        <h2>Đặt lại mật khẩu</h2>
        <form id="forgotRequestForm" class="form-grid">
          <label>Số điện thoại đã đăng ký
            <input name="phone" autocomplete="tel" />
          </label>
          <button>Gửi mã xác thực qua Telegram</button>
        </form>
        <form id="forgotConfirmForm" class="form-grid hidden">
          <label>Mã xác thực 6 số
            <input name="code" inputmode="numeric" maxlength="6" />
          </label>
          ${passwordField("Mật khẩu mới", "newPassword", "new-password")}
          ${passwordField("Nhắc lại mật khẩu mới", "confirmPassword", "new-password")}
          <button>Đặt lại mật khẩu</button>
        </form>
        <div id="forgotMessage"></div>
      </section>
      <p class="muted copyright">Copyright @2026 EVNGENCO1TPCNGHISON</p>
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
  document.querySelector("#forgotPasswordBtn").addEventListener("click", () => {
    document.querySelector("#forgotPasswordPanel").classList.toggle("hidden");
    setMessage("#forgotMessage", "", "");
  });
  document.querySelector("#forgotRequestForm").addEventListener("submit", requestPasswordReset);
  document.querySelector("#forgotConfirmForm").addEventListener("submit", confirmPasswordReset);
  attachPasswordToggles();
}

async function requestPasswordReset(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const phone = String(form.get("phone") || "").trim();
  try {
    await api("/api/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    document.querySelector("#forgotConfirmForm").classList.remove("hidden");
    document.querySelector("#forgotConfirmForm").dataset.phone = phone;
    setMessage("#forgotMessage", "Đã gửi mã xác thực 6 số qua Telegram. Vui lòng nhập mã để đặt lại mật khẩu.", "success");
  } catch (err) {
    setMessage("#forgotMessage", err.message, "error");
  }
}

async function confirmPasswordReset(event) {
  event.preventDefault();
  const resetForm = event.currentTarget;
  const phone = resetForm.dataset.phone;
  const form = new FormData(resetForm);
  try {
    await api("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({
        phone,
        code: form.get("code"),
        newPassword: form.get("newPassword"),
        confirmPassword: form.get("confirmPassword"),
      }),
    });
    document.querySelector("#loginForm [name='loginId']").value = phone;
    document.querySelector("#forgotConfirmForm").classList.add("hidden");
    document.querySelector("#forgotRequestForm").reset();
    resetForm.reset();
    setMessage("#forgotMessage", "Đã đặt lại mật khẩu. Anh/chị có thể đăng nhập bằng mật khẩu mới.", "success");
  } catch (err) {
    setMessage("#forgotMessage", err.message, "error");
  }
}

function renderShell() {
  app.innerHTML = html`
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="/logo.jpg" alt="EVNGENCO1" />
          <div>
            <h1>Hệ thống quản lý cơm ca</h1>
            <p>${userDisplayLine(state.user)}</p>
          </div>
        </div>
        <div class="actions">
          <span class="userline">Giờ chốt: ${state.settings.cutoffTime}</span>
          <button class="secondary" id="logoutBtn">Đăng xuất</button>
        </div>
      </header>
      <main class="main">
        ${state.user.registrationLockedNow ? `<div class="notice bad-notice">Tài khoản đang bị khóa đăng ký: ${state.user.lockReasonNow}</div>` : ""}
        ${state.user.mustChangePassword && state.user.role === "worker" ? `<div class="notice bad-notice">Anh/chị phải đổi mật khẩu mặc định trước khi sử dụng hệ thống.</div>` : ""}
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
  if (state.user.mustChangePassword && state.user.role === "worker") {
    return `<nav class="tabs"><button class="tab active" data-tab="profile">Đổi mật khẩu</button></nav>`;
  }
  if (state.user.role === "admin") tabs.push(["admin", "Admin"]);
  if (state.user.role === "worker") tabs.push(["worker", "Đăng ký của tôi"]);
  if (["admin", "kitchen"].includes(state.user.role)) tabs.push(["kitchen", "Nhà bếp"]);
  if (["admin", "kitchen"].includes(state.user.role)) tabs.push(["daily", "Báo cáo ngày"]);
  if (["admin", "kitchen", "worker"].includes(state.user.role)) tabs.push(["monthly", "Dòng tiền"]);
  if (state.user.role === "admin") tabs.push(["reconcile", "Đối soát & Telegram"]);
  tabs.push(["profile", "Hồ sơ"]);
  return `<nav class="tabs">${tabs
    .map(([id, label]) => `<button class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${label}</button>`)
    .join("")}</nav>`;
}

function renderView() {
  if (state.user.mustChangePassword && state.user.role === "worker") return renderProfile(true);
  if (state.tab === "admin") return renderAdmin();
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

function menuItemAmount(item) {
  return Number(item.amount || 0) || Number(item.grams || 0) * Number(item.unitPrice || 0);
}

function menuItemsTotal(items) {
  return (items || []).reduce((sum, item) => sum + menuItemAmount(item), 0);
}

function renderMenuItemsTable(items, compact = false) {
  const rows = items || [];
  if (!rows.length) return `<p class="muted">Chưa có định lượng món ăn.</p>`;
  return html`
    <div class="table-wrap menu-detail">
      <table>
        <thead><tr><th>STT</th><th>Tên món</th><th>Định lượng (gam)</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (item) => `<tr><td>${item.seq}</td><td>${item.name}</td><td>${item.grams}</td><td>${money(item.unitPrice)}</td><td>${money(menuItemAmount(item))}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <p class="${compact ? "muted" : ""}"><strong>Tổng giá tiền mỗi suất:</strong> ${money(menuItemsTotal(rows))}</p>
  `;
}

function chefNames(menu) {
  const chefs = menu && Array.isArray(menu.chefs) ? menu.chefs : [];
  if (!chefs.length) return "Chưa chọn";
  return chefs.map((chef) => `${chef.fullName}${chef.phone ? ` (${chef.phone})` : ""}`).join(", ");
}

function defaultMenuRows() {
  return [
    { seq: 1, name: "Cơm", grams: 250, unitPrice: 20 },
    { seq: 2, name: "Món mặn", grams: 100, unitPrice: 120 },
    { seq: 3, name: "Rau", grams: 100, unitPrice: 30 },
    { seq: 4, name: "Canh", grams: 150, unitPrice: 10 },
  ];
}

function addMenuInputRow(item = {}) {
  const tbody = document.querySelector("#menuItemsBody");
  const seq = item.seq || tbody.children.length + 1;
  const tr = document.createElement("tr");
  tr.innerHTML = html`
    <td><input class="menu-seq" type="number" value="${seq}" min="1" /></td>
    <td><input class="menu-name" value="${item.name || ""}" placeholder="Tên món" /></td>
    <td><input class="menu-grams" type="number" value="${item.grams || 0}" min="0" /></td>
    <td><input class="menu-unit-price" type="number" value="${item.unitPrice || 0}" min="0" /></td>
    <td><input class="menu-amount" type="number" value="${menuItemAmount(item)}" min="0" readonly /></td>
    <td><button type="button" class="danger menu-remove">Xóa</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelectorAll("input").forEach((input) => input.addEventListener("input", updateMenuInputTotals));
  tr.querySelector(".menu-remove").addEventListener("click", () => {
    tr.remove();
    renumberMenuRows();
    updateMenuInputTotals();
  });
  updateMenuInputTotals();
}

function renumberMenuRows() {
  document.querySelectorAll("#menuItemsBody tr").forEach((tr, index) => {
    tr.querySelector(".menu-seq").value = index + 1;
  });
}

function collectMenuInputRows() {
  return [...document.querySelectorAll("#menuItemsBody tr")]
    .map((tr) => {
      const grams = Number(tr.querySelector(".menu-grams").value || 0);
      const unitPrice = Number(tr.querySelector(".menu-unit-price").value || 0);
      const amount = grams * unitPrice;
      return {
        seq: Number(tr.querySelector(".menu-seq").value || 0),
        name: tr.querySelector(".menu-name").value.trim(),
        grams,
        unitPrice,
        amount,
      };
    })
    .filter((item) => item.name);
}

function updateMenuInputTotals() {
  const rows = collectMenuInputRows();
  document.querySelectorAll("#menuItemsBody tr").forEach((tr) => {
    const grams = Number(tr.querySelector(".menu-grams").value || 0);
    const unitPrice = Number(tr.querySelector(".menu-unit-price").value || 0);
    tr.querySelector(".menu-amount").value = grams * unitPrice;
  });
  const total = menuItemsTotal(rows);
  const totalEl = document.querySelector("#menuItemsTotal");
  const priceInput = document.querySelector("#menuPrice");
  if (totalEl) totalEl.textContent = money(total);
  if (priceInput) priceInput.value = total;
}

function populateMenuInputRows() {
  const form = document.querySelector("#menuForm");
  if (!form) return;
  const mealDate = form.elements.mealDate.value;
  const shift = form.elements.shift.value;
  const existing = menuFor(mealDate, shift);
  const tbody = document.querySelector("#menuItemsBody");
  tbody.innerHTML = "";
  const rows = existing && existing.items && existing.items.length ? existing.items : defaultMenuRows();
  rows.forEach((row) => addMenuInputRow(row));
  form.elements.plannedQty.value = existing ? existing.plannedQty || 0 : 300;
  form.elements.note.value = existing ? existing.note || "" : "";
  populateChefChecks(existing ? existing.chefIds || [] : []);
  updateMenuInputTotals();
}

function renderChefChecklist(selectedIds = []) {
  if (!state.chefs.length) {
    return `<p class="muted">Admin chưa nhập danh sách đầu bếp.</p>`;
  }
  const selected = new Set(selectedIds);
  return html`
    <div class="check-list">
      ${state.chefs
        .map(
          (chef) => `<label class="check-item">
            <input type="checkbox" data-chef-check value="${chef.id}" ${selected.has(chef.id) ? "checked" : ""} />
            <span>${chef.fullName} - ${chef.phone || ""}</span>
          </label>`
        )
        .join("")}
    </div>
  `;
}

function populateChefChecks(selectedIds = []) {
  const target = document.querySelector("#chefChecklist");
  if (target) target.innerHTML = renderChefChecklist(selectedIds);
}

function collectSelectedChefIds() {
  return [...document.querySelectorAll("[data-chef-check]:checked")].map((input) => input.value);
}

function passwordField(label, name, autocomplete) {
  return html`
    <label>${label}
      <span class="password-control">
        <input name="${name}" type="password" autocomplete="${autocomplete}" />
        <button type="button" class="secondary password-toggle" data-toggle-password="${name}">Hiện</button>
      </span>
    </label>
  `;
}

function attachPasswordToggles() {
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.querySelector(`[name="${btn.dataset.togglePassword}"]`);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Ẩn" : "Hiện";
    });
  });
}

function validateSelectedChefs() {
  if (collectSelectedChefIds().length) return true;
  setMessage("#menuMessage", "Vui lòng chọn ít nhất một đầu bếp thực hiện trước khi lưu định lượng bữa ăn.", "error");
  document.querySelector("#chefChecklist")?.scrollIntoView({ behavior: "smooth", block: "center" });
  return false;
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

function renderAdmin() {
  const workers = state.users.filter((u) => u.role === "worker");
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="subtabs">
      <button class="tab ${state.adminTab === "members" ? "active" : ""}" data-admin-tab="members">Thành viên</button>
      <button class="tab ${state.adminTab === "chefs" ? "active" : ""}" data-admin-tab="chefs">Đầu bếp</button>
    </div>
    <div class="grid">
      ${
        state.adminTab === "members"
          ? html`<section class="panel span-6">
        <h2>Nhập danh sách thành viên từ Excel</h2>
        <p class="muted">Chọn file Excel .xlsx theo mẫu gồm các cột: Số thứ tự, Họ và tên, Bộ phận, Số điện thoại. Sau khi nhập, số điện thoại sẽ là tài khoản đăng nhập của thành viên, mật khẩu mặc định là 123456.</p>
        <p><a href="/templates/Mau_nhap_danh_sach_cong_nhan.xlsx" download>Tải file mẫu Excel</a></p>
        <label>File danh sách thành viên
          <input id="workerXlsx" type="file" accept=".xlsx,.xls" />
        </label>
        <div class="actions">
          <button id="importWorkersBtn">Nhập danh sách</button>
        </div>
        <div id="adminImportMessage"></div>
      </section>
      <section class="panel span-6">
        <h2>Thông tin hệ thống</h2>
        <p><strong>Tổng thành viên:</strong> ${workers.length}</p>
        <p><strong>Tài khoản quản lý:</strong> admin, Nhabep</p>
        <p class="muted">Admin có thể xem toàn bộ tài khoản, xóa thành viên và quản lý dòng tiền trong tab Dòng tiền.</p>
      </section>
      <section class="panel span-12">
        <h2>Danh sách tài khoản thành viên</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>STT</th><th>Họ và tên</th><th>Bộ phận</th><th>Số điện thoại</th><th>Telegram</th><th>Trạng thái</th><th>Khóa đăng ký</th><th>Mật khẩu</th><th></th></tr></thead>
            <tbody>
              ${workers
                .map(
                  (u, index) => `<tr>
                    <td>${index + 1}</td><td>${u.fullName}</td><td>${u.department}</td><td>${u.phone || ""}</td><td>${u.telegramChatId || ""}</td>
                    <td>${u.status}</td><td>${u.registrationLocked ? "Đang khóa" : "Mở"}</td>
                    <td><button class="secondary" data-reset-worker="${u.employeeCode}">Đặt lại</button></td>
                    <td><button class="danger" data-delete-worker="${u.employeeCode}">Xóa</button></td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
      `
          : html`<section class="panel span-5">
        <h2>Nhập danh sách đầu bếp</h2>
        <p class="muted">Danh sách này dùng để chọn người thực hiện khi nhập định lượng suất ăn.</p>
        <form id="chefForm" class="form-grid">
          <label>Họ và tên <input name="fullName" /></label>
          <label>Số điện thoại <input name="phone" /></label>
          <button>Thêm / cập nhật đầu bếp</button>
          <div id="chefMessage"></div>
        </form>
      </section>
      <section class="panel span-7">
        <h2>Danh sách đầu bếp</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>STT</th><th>Họ và tên</th><th>Số điện thoại</th><th></th></tr></thead>
            <tbody>
              ${(state.chefs || [])
                .map(
                  (chef, index) => `<tr>
                    <td>${index + 1}</td><td>${chef.fullName}</td><td>${chef.phone || ""}</td>
                    <td><button class="danger" data-delete-chef="${chef.id}">Xóa</button></td>
                  </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </section>`
      }
    </div>
  `;
  document.querySelectorAll("[data-admin-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.adminTab = btn.dataset.adminTab;
      renderAdmin();
    });
  });
  if (state.adminTab === "members") {
    document.querySelector("#importWorkersBtn").addEventListener("click", importWorkers);
    document.querySelectorAll("[data-delete-worker]").forEach((btn) => {
      btn.addEventListener("click", () => deleteWorker(btn.dataset.deleteWorker));
    });
    document.querySelectorAll("[data-reset-worker]").forEach((btn) => {
      btn.addEventListener("click", () => resetWorkerPassword(btn.dataset.resetWorker));
    });
  } else {
    document.querySelector("#chefForm").addEventListener("submit", saveChef);
    document.querySelectorAll("[data-delete-chef]").forEach((btn) => {
      btn.addEventListener("click", () => deleteChef(btn.dataset.deleteChef));
    });
  }
}

async function importWorkers() {
  try {
    const file = document.querySelector("#workerXlsx").files[0];
    if (!file) throw new Error("Vui lòng chọn file Excel .xlsx theo mẫu.");
    const fileBase64 = await fileToBase64(file);
    const data = await api("/api/admin/import-workers", {
      method: "POST",
      body: JSON.stringify({ fileName: file.name, fileBase64 }),
    });
    await loadBootstrap();
    renderAdmin();
    setMessage("#adminImportMessage", `Đã nhập: thêm ${data.created}, cập nhật ${data.updated}.`, "success");
  } catch (err) {
    setMessage("#adminImportMessage", err.message, "error");
  }
}

async function deleteWorker(employeeCode) {
  if (!confirm(`Xóa thành viên ${employeeCode}?`)) return;
  try {
    await api("/api/admin/delete-worker", {
      method: "POST",
      body: JSON.stringify({ employeeCode }),
    });
    await loadBootstrap();
    renderAdmin();
  } catch (err) {
    alert(err.message);
  }
}

async function resetWorkerPassword(employeeCode) {
  if (!confirm(`Đặt lại mật khẩu thành viên ${employeeCode} về 123456?`)) return;
  try {
    await api("/api/admin/reset-worker-password", {
      method: "POST",
      body: JSON.stringify({ employeeCode }),
    });
    await loadBootstrap();
    renderAdmin();
    alert("Đã đặt lại mật khẩu về 123456. Thành viên sẽ phải đổi mật khẩu khi đăng nhập lại.");
  } catch (err) {
    alert(err.message);
  }
}

async function saveChef(event) {
  event.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    await api("/api/admin/chefs", { method: "POST", body: JSON.stringify(body) });
    await loadBootstrap();
    renderAdmin();
    setMessage("#chefMessage", "Đã lưu đầu bếp.", "success");
  } catch (err) {
    setMessage("#chefMessage", err.message, "error");
  }
}

async function deleteChef(id) {
  if (!confirm("Xóa đầu bếp này?")) return;
  try {
    await api("/api/admin/delete-chef", { method: "POST", body: JSON.stringify({ id }) });
    await loadBootstrap();
    renderAdmin();
  } catch (err) {
    alert(err.message);
  }
}

async function renderWorker() {
  await loadOrders();
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-12">
        <h2>Đăng ký cơm</h2>
        <div class="row">
          <label>Ngay an
            <input id="workerDate" type="date" value="${today}" />
          </label>
          <button id="reloadWorker" class="secondary">Xem ngày</button>
          <button id="exportWorkerDay" class="secondary">Xuất Excel theo ngày</button>
        </div>
        <div id="workerMeals"></div>
      </section>
    </div>
  `;
  document.querySelector("#reloadWorker").addEventListener("click", renderWorkerMeals);
  document.querySelector("#exportWorkerDay").addEventListener("click", exportWorkerDay);
  document.querySelector("#workerDate").addEventListener("change", renderWorkerMeals);
  renderWorkerMeals();
}

function renderWorkerMeals() {
  const date = document.querySelector("#workerDate").value;
  const container = document.querySelector("#workerMeals");
  const disabled = state.user.registrationLockedNow ? "disabled" : "";
  container.innerHTML = html`
    ${state.user.registrationLockedNow ? `<div class="notice bad-notice">Không thể đăng ký cơm cho đến khi thanh toán thành công.</div>` : ""}
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
      ${menu ? renderMenuItemsTable(menu.items || [], true) : "<p>Nhà bếp chưa nhập thực đơn.</p>"}
      ${menu ? `<p class="muted"><strong>Đầu bếp:</strong> ${chefNames(menu)}</p>` : ""}
      <p class="muted">Đơn giá suất ăn: ${money(menu ? menu.price : state.settings.defaultMealPrice)}</p>
      <p>${statusBadge(order)}</p>
      <div class="actions">
        <button ${disabled} data-register data-date="${date}" data-shift="${shift}">Đăng ký</button>
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

async function exportWorkerDay() {
  const date = document.querySelector("#workerDate").value;
  const data = await api(`/api/orders?mealDate=${encodeURIComponent(date)}`);
  const statusLabels = {
    registered: "Đã đăng ký",
    locked: "Đã chốt",
    added_after_cutoff: "Bếp bổ sung",
    cancelled_before_cutoff: "Đã hủy trước 08h",
    cancelled_by_admin: "Hủy đặc biệt",
  };
  const rows = ["lunch", "dinner"].map((shift) => {
    const menu = menuFor(date, shift);
    const order = (data.orders || []).find((item) => item.mealDate === date && item.shift === shift);
    const itemText =
      menu && Array.isArray(menu.items)
        ? menu.items.map((item) => `${item.seq}. ${item.name} - ${item.grams}g - ${money(item.amount)}`).join("; ")
        : "Nhà bếp chưa nhập thực đơn";
    return [
      date,
      shiftLabel(shift),
      itemText,
      menu ? chefNames(menu) : "",
      menu ? menu.price : state.settings.defaultMealPrice,
      order ? statusLabels[order.status] || order.status : "Chưa đăng ký",
      order ? order.source : "",
    ];
  });
  downloadExcel(`dang-ky-com-${state.user.phone || state.user.employeeCode}-${date}.xls`, `Đăng ký cơm ngày ${date}`, [
    {
      title: "Thông tin người dùng",
      headers: ["Họ tên", "Số điện thoại", "Bộ phận"],
      rows: [[state.user.fullName, state.user.phone || "", state.user.department || ""]],
    },
    {
      title: "Đăng ký cơm theo ngày",
      headers: ["Ngày ăn", "Ca", "Thực đơn", "Đầu bếp", "Đơn giá", "Trạng thái", "Nguồn"],
      rows,
    },
  ]);
}

function renderKitchen() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="subtabs">
      <button class="tab ${state.kitchenTab === "menu" ? "active" : ""}" data-kitchen-tab="menu">Nhập định lượng suất ăn</button>
      <button class="tab ${state.kitchenTab === "extra" ? "active" : ""}" data-kitchen-tab="extra">Bổ sung suất ăn</button>
    </div>
    <div class="grid">
      ${
        state.kitchenTab === "menu"
          ? html`
      <section class="panel span-12">
        <h2>Nhập định lượng suất ăn</h2>
        <form id="menuForm" class="form-grid">
          <div class="form-grid two-cols">
            <label>Ngày ăn <input name="mealDate" type="date" value="${today}" /></label>
            <label>Ca ăn
              <select name="shift">
                <option value="lunch">Trưa</option>
                <option value="dinner">Tối</option>
              </select>
            </label>
          </div>
          <div>
            <label>Đầu bếp</label>
            <div id="chefChecklist">${renderChefChecklist()}</div>
          </div>
          <div>
            <label>Danh sách món ăn theo định lượng</label>
            <div class="table-wrap input-table">
              <table>
                <thead><tr><th>STT</th><th>Tên món</th><th>Định lượng (gam)</th><th>Đơn giá/gam</th><th>Thành tiền</th><th></th></tr></thead>
                <tbody id="menuItemsBody"></tbody>
              </table>
            </div>
            <div class="row menu-total-row">
              <button type="button" class="secondary" id="addMenuRowBtn">Thêm món</button>
              <strong>Tổng giá tiền mỗi suất: <span id="menuItemsTotal">0 đ</span></strong>
            </div>
          </div>
          <div class="form-grid three-cols">
            <label>Định mức dự kiến <input name="plannedQty" type="number" value="300" /></label>
            <label>Đơn giá suất ăn tự động <input id="menuPrice" name="price" type="number" value="${state.settings.defaultMealPrice}" readonly /></label>
            <label>Ghi chú <input name="note" /></label>
          </div>
          <button>Lưu định lượng bữa ăn</button>
          <div id="menuMessage"></div>
        </form>
      </section>
          `
          : html`
      <section class="panel span-12">
        <h2>Bổ sung suất ăn sau 08h</h2>
        <form id="addOrderForm" class="form-grid">
          <div class="form-grid two-cols">
            <label>Ngày ăn <input name="mealDate" type="date" value="${today}" /></label>
            <label>Mã nhân viên
              <select name="employeeCode">
                ${state.users
                  .filter((u) => u.role === "worker")
                  .map((u) => `<option value="${u.employeeCode}">${u.phone || u.employeeCode} - ${u.fullName}</option>`)
                  .join("")}
              </select>
            </label>
          </div>
          <div class="form-grid two-cols">
            <label>Ca ăn
              <select name="shift">
                <option value="lunch">Trưa</option>
                <option value="dinner">Tối</option>
              </select>
            </label>
            <label>Ghi chú <input name="note" placeholder="Đăng ký trực tiếp với bếp" /></label>
          </div>
          <button>Bổ sung suất</button>
          <div id="kitchenMessage"></div>
        </form>
      </section>
          `
      }
    </div>
  `;
  document.querySelectorAll("[data-kitchen-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.kitchenTab = btn.dataset.kitchenTab;
      renderKitchen();
    });
  });
  if (state.kitchenTab === "menu") {
    populateMenuInputRows();
    document.querySelector("#menuForm [name='mealDate']").addEventListener("change", populateMenuInputRows);
    document.querySelector("#menuForm [name='shift']").addEventListener("change", populateMenuInputRows);
    document.querySelector("#addMenuRowBtn").addEventListener("click", () => addMenuInputRow());
    document.querySelector("#menuForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        if (!validateSelectedChefs()) return;
        const body = Object.fromEntries(new FormData(event.currentTarget));
        body.items = collectMenuInputRows();
        body.chefIds = collectSelectedChefIds();
        body.price = menuItemsTotal(body.items);
        await api("/api/menus", { method: "POST", body: JSON.stringify(body) });
        await loadBootstrap();
        setMessage("#menuMessage", "Đã lưu thực đơn.", "success");
      } catch (err) {
        setMessage("#menuMessage", err.message, "error");
      }
    });
  } else {
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
}

function renderDaily() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <section class="panel">
      <h2>Báo cáo số suất theo ngày</h2>
      <div class="row">
        <label>Ngày ăn <input id="dailyDate" type="date" value="${today}" /></label>
        <button id="loadDaily">Xem báo cáo</button>
        <button id="exportDaily" class="secondary">Xuất Excel theo ngày</button>
      </div>
      <div id="dailyContent"></div>
    </section>
  `;
  document.querySelector("#loadDaily").addEventListener("click", loadDailyReport);
  document.querySelector("#exportDaily").addEventListener("click", exportDailyReport);
  loadDailyReport();
}

async function loadDailyReport() {
  const date = document.querySelector("#dailyDate").value;
  const data = await api(`/api/reports/daily?mealDate=${encodeURIComponent(date)}`);
  state.dailyReport = data;
  document.querySelector("#dailyContent").innerHTML = html`
    <div class="summary">
      ${data.summary
        .map(
          (s) => `<div class="metric"><span>${s.shiftLabel}</span><strong>${s.totalQty}</strong><small>Định mức ${s.plannedQty}, bổ sung ${s.addedAfterCutoffQty}, giá trị thực đơn <span class="money-red">${money(s.totalMenuValue)}</span>, tiền thu <span class="money-red">${money(s.totalAmount)}</span></small></div>`
        )
        .join("")}
      <div class="metric"><span>Tổng tiền thu trong ngày</span><strong class="money-red">${money(data.totalDayAmount)}</strong><small>Tổng tiền ca trưa và ca tối</small></div>
    </div>
    <h3>Định lượng thực đơn</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Ca</th><th>STT</th><th>Tên món</th><th>Định lượng (gam)</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
        <tbody>
          ${data.summary
            .flatMap((s) => (s.menuItems || []).map((item) => ({ shiftLabel: s.shiftLabel, ...item })))
            .map((item) => `<tr><td>${item.shiftLabel}</td><td>${item.seq}</td><td>${item.name}</td><td>${item.grams}</td><td><span class="money-red">${money(item.unitPrice)}</span></td><td><span class="money-red">${money(item.amount)}</span></td></tr>`)
            .join("")}
        </tbody>
      </table>
    </div>
    <h3>Danh sách chi tiết</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Mã NV</th><th>Họ tên</th><th>Bộ phận</th><th>Ca</th><th>Giá</th><th>Trạng thái</th><th>Nguồn</th></tr></thead>
        <tbody>
          ${data.orders
            .map(
              (o) => `<tr><td>${o.employeeCode}</td><td>${o.fullName}</td><td>${o.department}</td><td>${shiftLabel(o.shift)}</td><td><span class="money-red">${money(o.price)}</span></td><td>${o.status}</td><td>${o.source}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function exportDailyReport() {
  const date = document.querySelector("#dailyDate").value;
  const data =
    state.dailyReport && state.dailyReport.mealDate === date
      ? state.dailyReport
      : await api(`/api/reports/daily?mealDate=${encodeURIComponent(date)}`);
  state.dailyReport = data;
  const menuRows = data.summary.flatMap((s) =>
    (s.menuItems || []).map((item) => [
      s.shiftLabel,
      item.seq,
      item.name,
      item.grams,
      item.unitPrice,
      item.amount,
    ])
  );
  const orderRows = data.orders.map((o) => [
    o.employeeCode,
    o.fullName,
    o.department,
    shiftLabel(o.shift),
    o.price,
    o.status,
    o.source,
  ]);
  downloadExcel(`bao-cao-ngay-${date}.xls`, `Báo cáo số suất theo ngày ${date}`, [
    {
      title: "Tổng hợp theo ca",
      headers: ["Ca", "Số suất", "Định mức", "Bổ sung sau 08h", "Giá trị thực đơn", "Tiền thu"],
      rows: [
        ...data.summary.map((s) => [
          s.shiftLabel,
          s.totalQty,
          s.plannedQty,
          s.addedAfterCutoffQty,
          s.totalMenuValue,
          s.totalAmount,
        ]),
        ["Tổng trong ngày", "", "", "", "", data.totalDayAmount],
      ],
    },
    {
      title: "Định lượng thực đơn",
      headers: ["Ca", "STT", "Tên món", "Định lượng (gam)", "Đơn giá", "Thành tiền"],
      rows: menuRows,
    },
    {
      title: "Danh sách chi tiết",
      headers: ["Mã NV", "Họ tên", "Bộ phận", "Ca", "Giá", "Trạng thái", "Nguồn"],
      rows: orderRows,
    },
  ]);
}

function renderMonthly() {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <section class="panel">
      <h2>Công nợ tiền cơm tháng</h2>
      <div class="row">
        <label>Tháng <input id="monthInput" type="month" value="${currentMonth}" /></label>
        <button id="loadMonthly">Xem công nợ</button>
        <button id="exportMonthly" class="secondary">Xuất Excel theo tháng</button>
      </div>
      <div id="monthlyContent"></div>
    </section>
  `;
  document.querySelector("#loadMonthly").addEventListener("click", loadMonthlyReport);
  document.querySelector("#exportMonthly").addEventListener("click", exportMonthlyReport);
  loadMonthlyReport();
}

async function loadMonthlyReport() {
  const month = document.querySelector("#monthInput").value;
  const data = await api(`/api/reports/monthly?month=${encodeURIComponent(month)}`);
  state.monthlyReport = data;
  document.querySelector("#monthlyContent").innerHTML = html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Mã NV</th><th>Số điện thoại</th><th>Họ tên</th><th>Bộ phận</th><th>Trưa</th><th>Tối</th><th>Tổng tiền</th><th>Nội dung CK</th><th>QR</th><th>Trạng thái</th><th></th></tr>
        </thead>
        <tbody>
          ${data.debts
            .map((d) => {
              const user = state.users.find((u) => u.employeeCode === d.employeeCode) || {};
              return `<tr>
                <td>${d.employeeCode}</td><td>${user.phone || state.user.phone || ""}</td><td>${d.fullName}</td><td>${d.department}</td><td>${d.lunchQty}</td><td>${d.dinnerQty}</td><td>${money(d.totalAmount)}</td>
                <td>${d.paymentCode}</td><td><img class="qr" src="${d.qrUrl}" alt="QR ${d.employeeCode}" /></td>
                <td><span class="status ${d.status === "paid" ? "ok" : "warn"}">${d.status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}</span></td>
                <td>${state.user.role === "admin" ? `<button data-paid="${d.employeeCode}" data-month="${data.month}">Đã thu</button>` : ""}</td>
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

async function exportMonthlyReport() {
  const month = document.querySelector("#monthInput").value;
  const data =
    state.monthlyReport && state.monthlyReport.month === month
      ? state.monthlyReport
      : await api(`/api/reports/monthly?month=${encodeURIComponent(month)}`);
  state.monthlyReport = data;
  const rows = data.debts.map((d) => {
    const user = state.users.find((u) => u.employeeCode === d.employeeCode) || {};
    return [
      d.employeeCode,
      user.phone || "",
      d.fullName,
      d.department,
      d.lunchQty,
      d.dinnerQty,
      d.totalAmount,
      d.paymentCode,
      d.qrUrl,
      d.status === "paid" ? "Đã thanh toán" : "Chưa thanh toán",
    ];
  });
  downloadExcel(`cong-no-thang-${month}.xls`, `Công nợ tiền cơm tháng ${month}`, [
    {
      title: "Công nợ tiền cơm tháng",
      headers: ["Mã NV", "Số điện thoại", "Họ tên", "Bộ phận", "Trưa", "Tối", "Tổng tiền", "Nội dung CK", "Link QR", "Trạng thái"],
      rows,
    },
  ]);
}

function renderReconcile() {
  const view = document.querySelector("#view");
  const templates = telegramTemplates();
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Đối soát sao kê Excel</h2>
        <div class="form-grid">
          <label>Tháng <input id="reconcileMonth" type="month" value="${currentMonth}" /></label>
          <p class="muted">Chọn file .xlsx sao kê ngân hàng. Sheet đầu tiên cần có các cột: date/Ngày, amount/Số tiền, description/Nội dung.</p>
          <p><a href="/templates/Mau_doi_soat_sao_ke.xlsx" download>Tải file mẫu Excel đối soát</a></p>
          <label>File sao kê Excel
            <input id="reconcileXlsx" type="file" accept=".xlsx,.xls" />
          </label>
          <button id="reconcileBtn">Đối soát</button>
        </div>
        <div id="reconcileResult"></div>
      </section>
      <section class="panel span-6">
        <h2>Nhắc Telegram và khóa quá hạn</h2>
        <p class="muted">Sau ${state.settings.paymentGraceDays || 5} ngày của tháng kế tiếp, nếu chưa thanh toán thì hệ thống nhắc và khóa quyền đăng ký của công nhân.</p>
        <div class="form-grid">
          <label>Tháng <input id="telegramMonth" type="month" value="${currentMonth}" /></label>
          <label>Mẫu tin nhắn thông báo công nợ
            <textarea id="debtNoticeTemplate" rows="4">${templates.debtNotice}</textarea>
          </label>
          <label>Mẫu tin nhắn nhắc nợ / khóa quá hạn
            <textarea id="debtReminderTemplate" rows="4">${templates.debtReminder}</textarea>
          </label>
          <p class="muted">Có thể dùng biến: {hoTen}, {thang}, {soTien}, {maThanhToan}, {soDienThoai}, {boPhan}, {ghiChuKhoa}.</p>
          <button id="saveTelegramTemplatesBtn" class="secondary">Lưu mẫu tin nhắn</button>
          <button id="telegramBtn">Gửi nhắc / khóa nếu quá hạn</button>
        </div>
        <div id="telegramResult"></div>
      </section>
      <section class="panel span-12">
        <h2>Gửi Telegram thủ công cho cá nhân</h2>
        <p class="muted">Admin chọn thành viên đã liên kết Telegram, soạn nội dung riêng và gửi trực tiếp.</p>
        <div class="form-grid">
          <label>Người nhận
            <select id="manualTelegramEmployee">
              ${state.users
                .filter((u) => u.role === "worker")
                .map(
                  (u) =>
                    `<option value="${u.employeeCode}">${u.fullName} - ${u.phone || u.employeeCode}${u.telegramChatId ? "" : " - chưa liên kết Telegram"}</option>`
                )
                .join("")}
            </select>
          </label>
          <label>Nội dung tin nhắn
            <textarea id="manualTelegramText" rows="5" placeholder="Nhập nội dung cần gửi cho cá nhân"></textarea>
          </label>
          <button id="manualTelegramBtn">Gửi Telegram thủ công</button>
        </div>
        <div id="manualTelegramResult"></div>
      </section>
      <section class="panel span-12">
        <h2>Danh sách đang bị khóa</h2>
        <button id="loadLocked" class="secondary">Tải danh sách</button>
        <div id="lockedContent"></div>
      </section>
    </div>
  `;
  document.querySelector("#reconcileBtn").addEventListener("click", reconcileXlsx);
  document.querySelector("#saveTelegramTemplatesBtn").addEventListener("click", saveTelegramTemplates);
  document.querySelector("#telegramBtn").addEventListener("click", sendTelegramReminders);
  document.querySelector("#manualTelegramBtn").addEventListener("click", sendManualTelegram);
  document.querySelector("#loadLocked").addEventListener("click", loadLockedUsers);
  loadLockedUsers();
}

async function reconcileXlsx() {
  try {
    const file = document.querySelector("#reconcileXlsx").files[0];
    if (!file) throw new Error("Vui lòng chọn file sao kê Excel .xlsx.");
    const fileBase64 = await fileToBase64(file);
    const data = await api("/api/payments/reconcile-xlsx", {
      method: "POST",
      body: JSON.stringify({
        month: document.querySelector("#reconcileMonth").value,
        fileName: file.name,
        fileBase64,
      }),
    });
    document.querySelector("#reconcileResult").innerHTML = `<p class="success">Khớp ${data.matched.length} giao dịch, chưa khớp ${data.unmatched.length} giao dịch.</p>`;
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
      body: JSON.stringify({
        month: document.querySelector("#telegramMonth").value,
        debtNotice: document.querySelector("#debtNoticeTemplate").value,
        debtReminder: document.querySelector("#debtReminderTemplate").value,
      }),
    });
    document.querySelector("#telegramResult").innerHTML = `<p class="success">Đã xử lý ${data.results.length} tin nhắn/nhắc nợ.</p>`;
    await loadBootstrap();
    loadLockedUsers();
  } catch (err) {
    setMessage("#telegramResult", err.message, "error");
  }
}

async function saveTelegramTemplates() {
  try {
    const data = await api("/api/settings/telegram-templates", {
      method: "POST",
      body: JSON.stringify({
        debtNotice: document.querySelector("#debtNoticeTemplate").value,
        debtReminder: document.querySelector("#debtReminderTemplate").value,
      }),
    });
    state.settings.telegramTemplates = data.telegramTemplates;
    setMessage("#telegramResult", "Đã lưu mẫu tin nhắn Telegram.", "success");
  } catch (err) {
    setMessage("#telegramResult", err.message, "error");
  }
}

async function sendManualTelegram() {
  try {
    const data = await api("/api/telegram/manual", {
      method: "POST",
      body: JSON.stringify({
        employeeCode: document.querySelector("#manualTelegramEmployee").value,
        text: document.querySelector("#manualTelegramText").value,
      }),
    });
    document.querySelector("#manualTelegramText").value = "";
    setMessage("#manualTelegramResult", `Đã gửi tin nhắn cho ${data.recipient.fullName}.`, "success");
  } catch (err) {
    setMessage("#manualTelegramResult", err.message, "error");
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
          <thead><tr><th>Mã NV</th><th>Số điện thoại</th><th>Họ tên</th><th>Bộ phận</th><th>Lý do</th></tr></thead>
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

function renderProfile(forcePasswordChange = false) {
  const view = document.querySelector("#view");
  view.innerHTML = html`
    <div class="grid">
      <section class="panel span-6">
        <h2>Thông tin tài khoản</h2>
        <p><strong>Họ tên:</strong> ${state.user.fullName}</p>
        <p><strong>Mã NV:</strong> ${state.user.employeeCode}</p>
        <p><strong>Bộ phận công tác:</strong> ${state.user.department || ""}</p>
        <p><strong>Số điện thoại đăng nhập:</strong> ${state.user.phone || ""}</p>
        <p><strong>Telegram Chat ID:</strong> ${state.user.telegramChatId || "Chưa liên kết"}</p>
        <p class="muted">Telegram Bot không gửi trực tiếp theo số điện thoại nếu người dùng chưa liên kết bot. Anh/chị cần lấy Telegram Chat ID và lưu vào đây.</p>
      </section>
      <section class="panel span-6">
        <h2>${forcePasswordChange ? "Yêu cầu đổi mật khẩu" : "Đổi mật khẩu"}</h2>
        ${forcePasswordChange ? `<p class="notice">Tài khoản đang dùng mật khẩu mặc định 123456. Vui lòng đổi mật khẩu mới để tiếp tục sử dụng.</p>` : ""}
        <form id="passwordForm" class="form-grid">
          ${passwordField("Mật khẩu hiện tại", "currentPassword", "current-password")}
          ${passwordField("Mật khẩu mới", "newPassword", "new-password")}
          ${passwordField("Nhắc lại mật khẩu mới", "confirmPassword", "new-password")}
          <button>Đổi mật khẩu</button>
          <div id="passwordMessage"></div>
        </form>
      </section>
      <section class="panel span-6 ${forcePasswordChange ? "hidden-panel" : ""}">
        <h2>Liên kết Telegram</h2>
        <form id="telegramProfileForm" class="form-grid">
          <label>Telegram Chat ID <input name="telegramChatId" value="${state.user.telegramChatId || ""}" /></label>
          <button>Lưu Telegram</button>
          <div id="profileTelegramMessage"></div>
        </form>
      </section>
    </div>
  `;
  attachPasswordToggles();
  document.querySelector("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/profile/change-password", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
      });
      await loadBootstrap();
      setMessage("#passwordMessage", "Đã đổi mật khẩu.", "success");
      renderShell();
    } catch (err) {
      setMessage("#passwordMessage", err.message, "error");
    }
  });
  const telegramForm = document.querySelector("#telegramProfileForm");
  if (telegramForm) {
    telegramForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/profile/telegram", {
          method: "POST",
          body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
        });
        await loadBootstrap();
        setMessage("#profileTelegramMessage", "Đã lưu Telegram Chat ID.", "success");
      } catch (err) {
        setMessage("#profileTelegramMessage", err.message, "error");
      }
    });
  }
}

init().catch((err) => {
  app.innerHTML = `<main class="login"><h1>Lỗi</h1><p class="error">${err.message}</p></main>`;
});
