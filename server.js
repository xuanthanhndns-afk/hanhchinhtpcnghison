const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "data", "db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const sessions = new Map();

function readDb() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(text);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid || !sessions.has(sid)) return null;
  const session = sessions.get(sid);
  const db = readDb();
  return db.users.find((u) => u.id === session.userId) || null;
}

function requireUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    json(res, 401, { error: "Chua dang nhap" });
    return null;
  }
  return user;
}

function requireRole(req, res, roles) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!roles.includes(user.role)) {
    json(res, 403, { error: "Khong co quyen thao tac" });
    return null;
  }
  return user;
}

function findUserByLogin(db, login) {
  const value = String(login || "").trim().toLowerCase();
  return db.users.find((u) => {
    const byCode = String(u.employeeCode || "").toLowerCase() === value;
    const byPhone = String(u.phone || "").toLowerCase() === value;
    return byCode || byPhone;
  });
}

function addMonths(month, offset) {
  const [year, mm] = month.split("-").map(Number);
  const date = new Date(year, mm - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function previousMonth() {
  return addMonths(new Date().toISOString().slice(0, 7), -1);
}

function dueDateForMonth(month, graceDays) {
  const [year, mm] = month.split("-").map(Number);
  const due = new Date(year, mm, 1);
  due.setDate(due.getDate() + Number(graceDays || 5));
  return due;
}

function getOverdueDebt(db, employeeCode) {
  const graceDays = Number(db.settings.paymentGraceDays || 5);
  const months = new Set(db.orders.map((o) => o.mealDate.slice(0, 7)));
  for (const month of [...months].sort()) {
    if (new Date() <= dueDateForMonth(month, graceDays)) continue;
    const debt = buildMonthlyDebts(db, month).find((d) => d.employeeCode === employeeCode);
    if (debt && debt.status !== "paid" && debt.totalAmount > 0) return debt;
  }
  return null;
}

function isWorkerRegistrationLocked(db, user) {
  if (!user || user.role !== "worker") return { locked: false };
  if (user.registrationLocked) {
    return { locked: true, reason: user.lockedReason || "Tai khoan dang bi khoa dang ky" };
  }
  const overdue = getOverdueDebt(db, user.employeeCode);
  if (!overdue) return { locked: false };
  return {
    locked: true,
    reason: `Con no tien com ${overdue.month}: ${overdue.totalAmount.toLocaleString("vi-VN")} dong`,
    overdue,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error("Body qua lon"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      const type = req.headers["content-type"] || "";
      if (type.includes("application/json")) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("JSON khong hop le"));
        }
      } else {
        resolve({ raw });
      }
    });
  });
}

function audit(db, actor, action, detail) {
  db.auditLogs.push({
    id: crypto.randomUUID(),
    at: nowIso(),
    actor: actor.employeeCode,
    action,
    detail,
  });
}

function isBeforeCutoff(mealDate, cutoffTime) {
  const [hour, minute] = cutoffTime.split(":").map(Number);
  const cutoff = new Date(`${mealDate}T00:00:00`);
  cutoff.setHours(hour, minute, 0, 0);
  return new Date() < cutoff;
}

function orderKey(employeeCode, mealDate, shift) {
  return `${employeeCode}|${mealDate}|${shift}`;
}

function normalizeShift(shift) {
  if (!["lunch", "dinner"].includes(shift)) {
    throw new Error("Ca an khong hop le");
  }
  return shift;
}

function shiftLabel(shift) {
  return shift === "lunch" ? "Trua" : "Toi";
}

function getMenu(db, mealDate, shift) {
  return db.menus.find((m) => m.mealDate === mealDate && m.shift === shift);
}

function activeBillableOrders(db, month) {
  return db.orders.filter((o) => {
    return (
      o.mealDate.startsWith(month) &&
      ["registered", "locked", "added_after_cutoff"].includes(o.status)
    );
  });
}

function paymentCode(accountId, month) {
  const [year, mm] = month.split("-");
  return `${accountId} COM T${mm}-${year}`;
}

function buildVietQrUrl(settings, amount, content) {
  const p = settings.payment;
  const base = `https://img.vietqr.io/image/${encodeURIComponent(p.bankBin)}-${encodeURIComponent(
    p.accountNo
  )}-${encodeURIComponent(p.template || "compact2")}.png`;
  const params = new URLSearchParams({
    amount: String(amount),
    addInfo: content,
    accountName: p.accountName || "",
  });
  return `${base}?${params.toString()}`;
}

function buildMonthlyDebts(db, month) {
  const byUser = new Map();
  for (const user of db.users.filter((u) => u.role === "worker")) {
    byUser.set(user.employeeCode, {
      employeeCode: user.employeeCode,
      fullName: user.fullName,
      department: user.department,
      lunchQty: 0,
      dinnerQty: 0,
      totalQty: 0,
      totalAmount: 0,
      paymentCode: paymentCode(user.phone || user.employeeCode, month),
      status: "unpaid",
      qrUrl: "",
    });
  }

  for (const order of activeBillableOrders(db, month)) {
    const item = byUser.get(order.employeeCode);
    if (!item) continue;
    if (order.shift === "lunch") item.lunchQty += 1;
    if (order.shift === "dinner") item.dinnerQty += 1;
    item.totalQty += 1;
    item.totalAmount += Number(order.price || db.settings.defaultMealPrice || 0);
  }

  const payments = db.payments.filter((p) => p.month === month);
  for (const item of byUser.values()) {
    item.qrUrl = buildVietQrUrl(db.settings, item.totalAmount, item.paymentCode);
    const paid = payments.find((p) => p.employeeCode === item.employeeCode && p.status === "paid");
    if (paid) {
      item.status = "paid";
      item.paidAt = paid.paidAt;
      item.paidBy = paid.paidBy;
    }
  }

  return [...byUser.values()].filter((item) => item.totalQty > 0);
}

function parseCsv(raw) {
  const lines = raw.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || ""]));
  });
}

function pick(row, names) {
  const entries = Object.entries(row);
  for (const name of names) {
    const found = entries.find(([k]) => k.trim().toLowerCase() === name.toLowerCase());
    if (found) return String(found[1] || "").trim();
  }
  return "";
}

function parseMenuItems(raw) {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split(",").map((p) => p.trim());
      const seq = Number(parts[0] || index + 1);
      const name = parts[1] || "";
      const grams = Number(String(parts[2] || "0").replace(/[^\d.-]/g, ""));
      const unitPrice = Number(String(parts[3] || "0").replace(/[^\d.-]/g, ""));
      const amount = Number(String(parts[4] || "").replace(/[^\d.-]/g, "")) || grams * unitPrice;
      return { seq, name, grams, unitPrice, amount };
    })
    .filter((item) => item.name);
}

function menuTotal(items) {
  return items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    return { ok: false, skipped: true, reason: "Chua cau hinh TELEGRAM_BOT_TOKEN" };
  }
  if (!chatId) {
    return { ok: false, skipped: true, reason: "Nguoi dung chua co telegramChatId" };
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return response.json();
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");
  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
      ? "text/css; charset=utf-8"
      : ext === ".js"
      ? "application/javascript; charset=utf-8"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
      ? "image/png"
      : "application/octet-stream";
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, "Not found");
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "POST /api/login") {
      const body = await readBody(req);
      const db = readDb();
      const user = findUserByLogin(db, body.loginId || body.employeeCode || body.phone);
      if (!user || user.password !== body.password) {
        return json(res, 401, { error: "Sai tai khoan hoac mat khau" });
      }
      if (!user || user.status !== "active") return json(res, 401, { error: "Sai tai khoan hoac mat khau" });
      const sid = crypto.randomUUID();
      sessions.set(sid, { userId: user.id, createdAt: Date.now() });
      res.setHeader("set-cookie", `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`);
      return json(res, 200, { user: sanitizeUser(user) });
    }

    if (route === "POST /api/logout") {
      const cookies = parseCookies(req);
      if (cookies.sid) sessions.delete(cookies.sid);
      res.setHeader("set-cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    if (route === "GET /api/me") {
      const user = getCurrentUser(req);
      return json(res, 200, { user: user ? sanitizeUser(user) : null });
    }

    if (route === "GET /api/bootstrap") {
      const user = requireUser(req, res);
      if (!user) return;
      const db = readDb();
      const lock = isWorkerRegistrationLocked(db, user);
      return json(res, 200, {
        user: { ...sanitizeUser(user), registrationLockedNow: lock.locked, lockReasonNow: lock.reason || "" },
        settings: db.settings,
        users: user.role === "worker" ? [] : db.users.map(sanitizeUser),
        menus: db.menus.sort((a, b) => `${a.mealDate}${a.shift}`.localeCompare(`${b.mealDate}${b.shift}`)),
      });
    }

    if (route === "POST /api/admin/import-workers") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const rows = parseCsv(String(body.csv || ""));
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const phone = pick(row, ["phone", "sodienthoai", "so dien thoai", "dien thoai", "sdt"]);
        const employeeCode = pick(row, ["employeeCode", "manv", "ma nv", "ma nhan vien"]) || phone;
        const fullName = pick(row, ["fullName", "hoten", "ho ten", "ten"]);
        if (!phone || !fullName) continue;
        let worker = db.users.find((u) => u.role === "worker" && (u.phone === phone || u.employeeCode === employeeCode));
        if (!worker) {
          worker = {
            id: crypto.randomUUID(),
            role: "worker",
            status: "active",
            password: "123456",
            mustChangePassword: true,
            registrationLocked: false,
            lockedReason: "",
            lockedAt: "",
            telegramChatId: "",
          };
          db.users.push(worker);
          created += 1;
        } else {
          updated += 1;
        }
        Object.assign(worker, {
          employeeCode,
          phone,
          fullName,
          department: pick(row, ["department", "bophan", "bo phan", "phong ban"]) || worker.department || "",
        });
      }
      audit(db, user, "IMPORT_WORKERS", { created, updated });
      writeDb(db);
      return json(res, 200, { created, updated });
    }

    if (route === "POST /api/admin/delete-worker") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const employeeCode = String(body.employeeCode || "");
      const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
      if (!worker) return json(res, 404, { error: "Khong tim thay cong nhan" });
      db.users = db.users.filter((u) => u.id !== worker.id);
      audit(db, user, "DELETE_WORKER", { employeeCode });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/profile/change-password") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      if (user.password !== currentPassword) return json(res, 400, { error: "Mat khau hien tai khong dung" });
      if (newPassword.length < 6) return json(res, 400, { error: "Mat khau moi can toi thieu 6 ky tu" });
      const db = readDb();
      const saved = db.users.find((u) => u.id === user.id);
      saved.password = newPassword;
      saved.mustChangePassword = false;
      audit(db, saved, "CHANGE_PASSWORD", { employeeCode: saved.employeeCode });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/profile/telegram") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const saved = db.users.find((u) => u.id === user.id);
      saved.telegramChatId = String(body.telegramChatId || "").trim();
      audit(db, saved, "UPDATE_TELEGRAM", { employeeCode: saved.employeeCode });
      writeDb(db);
      return json(res, 200, { user: sanitizeUser(saved) });
    }

    if (route === "POST /api/menus") {
      const user = requireRole(req, res, ["admin", "kitchen"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const shift = normalizeShift(body.shift);
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const price = Number(body.price || db.settings.defaultMealPrice);
      const items = Array.isArray(body.items) ? body.items : parseMenuItems(body.itemsText || body.dishes);
      let menu = getMenu(db, mealDate, shift);
      if (!menu) {
        menu = { id: crypto.randomUUID(), mealDate, shift };
        db.menus.push(menu);
      }
      Object.assign(menu, {
        dishes: items.map((item) => item.name).join(", "),
        items,
        totalMenuValue: menuTotal(items),
        plannedQty: Number(body.plannedQty || 0),
        price,
        note: String(body.note || ""),
        updatedBy: user.employeeCode,
        updatedAt: nowIso(),
      });
      audit(db, user, "UPSERT_MENU", { mealDate, shift });
      writeDb(db);
      return json(res, 200, { menu });
    }

    if (route === "POST /api/orders/register") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const lock = isWorkerRegistrationLocked(db, user);
      if (lock.locked && user.role === "worker") {
        return json(res, 423, { error: `Tai khoan bi khoa dang ky. ${lock.reason}` });
      }
      const employeeCode = user.role === "worker" ? user.employeeCode : String(body.employeeCode || "");
      if (user.role !== "worker" && !["admin", "kitchen"].includes(user.role)) {
        return json(res, 403, { error: "Khong co quyen dang ky ho" });
      }
      const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
      if (!worker) return json(res, 404, { error: "Khong tim thay cong nhan" });
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const shift = normalizeShift(body.shift);
      const beforeCutoff = isBeforeCutoff(mealDate, db.settings.cutoffTime);
      if (!beforeCutoff && user.role === "worker") {
        return json(res, 400, { error: "Da qua 08h, cong nhan khong duoc tu dang ky" });
      }
      if (!beforeCutoff && user.role !== "kitchen" && user.role !== "admin") {
        return json(res, 400, { error: "Sau gio chot chi nha bep/admin duoc bo sung" });
      }
      const menu = getMenu(db, mealDate, shift);
      const key = orderKey(employeeCode, mealDate, shift);
      let order = db.orders.find((o) => orderKey(o.employeeCode, o.mealDate, o.shift) === key);
      if (order && ["registered", "locked", "added_after_cutoff"].includes(order.status)) {
        return json(res, 400, { error: "Nhan vien da co dang ky ca nay" });
      }
      order = {
        id: order ? order.id : crypto.randomUUID(),
        employeeCode,
        fullName: worker.fullName,
        department: worker.department,
        mealDate,
        shift,
        price: menu ? Number(menu.price) : Number(db.settings.defaultMealPrice),
        status: beforeCutoff ? "registered" : "added_after_cutoff",
        source: beforeCutoff ? (user.role === "worker" ? "self_before_cutoff" : "staff_before_cutoff") : "kitchen_after_cutoff",
        createdAt: nowIso(),
        cancelledAt: "",
        operatedBy: user.employeeCode,
        note: String(body.note || ""),
      };
      db.orders = db.orders.filter((o) => o.id !== order.id);
      db.orders.push(order);
      audit(db, user, "REGISTER_ORDER", { employeeCode, mealDate, shift, status: order.status });
      writeDb(db);
      return json(res, 200, { order });
    }

    if (route === "POST /api/orders/cancel") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const employeeCode = user.role === "worker" ? user.employeeCode : String(body.employeeCode || "");
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const shift = normalizeShift(body.shift);
      const order = db.orders.find(
        (o) => o.employeeCode === employeeCode && o.mealDate === mealDate && o.shift === shift
      );
      if (!order) return json(res, 404, { error: "Khong tim thay dang ky" });
      const beforeCutoff = isBeforeCutoff(mealDate, db.settings.cutoffTime);
      if (user.role === "worker" && !beforeCutoff) return json(res, 400, { error: "Da qua 08h, khong duoc tu huy" });
      order.status = beforeCutoff ? "cancelled_before_cutoff" : "cancelled_by_admin";
      order.cancelledAt = nowIso();
      order.operatedBy = user.employeeCode;
      order.note = String(body.note || order.note || "");
      audit(db, user, "CANCEL_ORDER", { employeeCode, mealDate, shift, status: order.status });
      writeDb(db);
      return json(res, 200, { order });
    }

    if (route === "GET /api/orders") {
      const user = requireUser(req, res);
      if (!user) return;
      const db = readDb();
      const mealDate = url.searchParams.get("mealDate") || "";
      let orders = db.orders;
      if (mealDate) orders = orders.filter((o) => o.mealDate === mealDate);
      if (user.role === "worker") orders = orders.filter((o) => o.employeeCode === user.employeeCode);
      return json(res, 200, { orders });
    }

    if (route === "GET /api/reports/daily") {
      const user = requireRole(req, res, ["admin", "kitchen"]);
      if (!user) return;
      const db = readDb();
      const mealDate = url.searchParams.get("mealDate") || new Date().toISOString().slice(0, 10);
      const orders = db.orders.filter(
        (o) => o.mealDate === mealDate && ["registered", "locked", "added_after_cutoff"].includes(o.status)
      );
      const summary = ["lunch", "dinner"].map((shift) => {
        const menu = getMenu(db, mealDate, shift);
        const rows = orders.filter((o) => o.shift === shift);
        const added = rows.filter((o) => o.status === "added_after_cutoff").length;
        return {
          shift,
          shiftLabel: shiftLabel(shift),
          plannedQty: menu ? menu.plannedQty : 0,
          menuItems: menu ? menu.items || [] : [],
          totalMenuValue: menu ? Number(menu.totalMenuValue || 0) : 0,
          registeredQty: rows.length - added,
          addedAfterCutoffQty: added,
          totalQty: rows.length,
        };
      });
      return json(res, 200, { mealDate, summary, orders });
    }

    if (route === "GET /api/reports/monthly") {
      const user = requireRole(req, res, ["admin", "kitchen", "worker"]);
      if (!user) return;
      const db = readDb();
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      let debts = buildMonthlyDebts(db, month);
      if (user.role === "worker") debts = debts.filter((d) => d.employeeCode === user.employeeCode);
      return json(res, 200, { month, debts });
    }

    if (route === "GET /api/reports/locked-users") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const db = readDb();
      const rows = db.users
        .filter((u) => u.role === "worker")
        .map((u) => ({ user: sanitizeUser(u), lock: isWorkerRegistrationLocked(db, u) }))
        .filter((r) => r.lock.locked);
      return json(res, 200, { rows });
    }

    if (route === "POST /api/payments/mark-paid") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const month = String(body.month || "");
      const employeeCode = String(body.employeeCode || "");
      const debts = buildMonthlyDebts(db, month);
      const debt = debts.find((d) => d.employeeCode === employeeCode);
      if (!debt) return json(res, 404, { error: "Khong co cong no thang nay" });
      db.payments = db.payments.filter((p) => !(p.month === month && p.employeeCode === employeeCode));
      db.payments.push({
        id: crypto.randomUUID(),
        month,
        employeeCode,
        amount: debt.totalAmount,
        paymentCode: debt.paymentCode,
        status: "paid",
        paidAt: nowIso(),
        paidBy: user.employeeCode,
        method: body.method || "manual",
      });
      const worker = db.users.find((u) => u.employeeCode === employeeCode);
      if (worker) {
        worker.registrationLocked = false;
        worker.lockedReason = "";
        worker.lockedAt = "";
      }
      audit(db, user, "MARK_PAID", { month, employeeCode, amount: debt.totalAmount });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/payments/reconcile-csv") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const rows = parseCsv(String(body.csv || ""));
      const db = readDb();
      const debts = buildMonthlyDebts(db, month);
      const matched = [];
      const unmatched = [];
      for (const row of rows) {
        const amount = Number(String(row.amount || "").replace(/[^\d.-]/g, ""));
        const description = String(row.description || "").toUpperCase();
        const debt = debts.find((d) => amount === d.totalAmount && description.includes(d.paymentCode.toUpperCase()));
        const statement = {
          id: crypto.randomUUID(),
          month,
          date: row.date || "",
          amount,
          description: row.description || "",
          importedAt: nowIso(),
        };
        db.bankStatements.push(statement);
        if (debt) {
          db.payments = db.payments.filter((p) => !(p.month === month && p.employeeCode === debt.employeeCode));
          db.payments.push({
            id: crypto.randomUUID(),
            month,
            employeeCode: debt.employeeCode,
            amount,
            paymentCode: debt.paymentCode,
            status: "paid",
            paidAt: nowIso(),
            paidBy: user.employeeCode,
            method: "bank_csv",
            bankStatementId: statement.id,
          });
          const worker = db.users.find((u) => u.employeeCode === debt.employeeCode);
          if (worker) {
            worker.registrationLocked = false;
            worker.lockedReason = "";
            worker.lockedAt = "";
          }
          matched.push({ statement, debt });
        } else {
          unmatched.push(statement);
        }
      }
      audit(db, user, "RECONCILE_CSV", { month, matched: matched.length, unmatched: unmatched.length });
      writeDb(db);
      return json(res, 200, { matched, unmatched });
    }

    if (route === "POST /api/telegram/remind") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const db = readDb();
      const debts = buildMonthlyDebts(db, month).filter((d) => d.status !== "paid");
      const results = [];
      for (const debt of debts) {
        const worker = db.users.find((u) => u.employeeCode === debt.employeeCode);
        const overdue = new Date() > dueDateForMonth(month, db.settings.paymentGraceDays || 5);
        if (overdue && worker) {
          worker.registrationLocked = true;
          worker.lockedReason = `Qua han thanh toan tien com ${month}`;
          worker.lockedAt = nowIso();
        }
        const text = `Anh/chi ${debt.fullName} co tien com thang ${month} la ${debt.totalAmount.toLocaleString(
          "vi-VN"
        )} dong. Vui long chuyen khoan voi noi dung: ${debt.paymentCode}${
          overdue ? ". Tai khoan se bi khoa dang ky com den khi thanh toan thanh cong." : ""
        }`;
        const result = await sendTelegram(worker ? worker.telegramChatId : "", text);
        results.push({ employeeCode: debt.employeeCode, result });
      }
      audit(db, user, "TELEGRAM_REMIND", { month, count: results.length });
      writeDb(db);
      return json(res, 200, { results });
    }

    return json(res, 404, { error: "API khong ton tai" });
  } catch (err) {
    return json(res, 500, { error: err.message || "Loi he thong" });
  }
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return api(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Meal shift web running at http://localhost:${PORT}`);
});
