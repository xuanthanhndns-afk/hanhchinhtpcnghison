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

function paymentCode(employeeCode, month) {
  const [year, mm] = month.split("-");
  return `${employeeCode} COM T${mm}-${year}`;
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
      paymentCode: paymentCode(user.employeeCode, month),
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
      const code = String(body.employeeCode || "").trim();
      const user = db.users.find(
        (u) => u.employeeCode.toLowerCase() === code.toLowerCase() && u.password === body.password
      );
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
      return json(res, 200, {
        user: sanitizeUser(user),
        settings: db.settings,
        users: user.role === "worker" ? [] : db.users.map(sanitizeUser),
        menus: db.menus.sort((a, b) => `${a.mealDate}${a.shift}`.localeCompare(`${b.mealDate}${b.shift}`)),
      });
    }

    if (route === "POST /api/menus") {
      const user = requireRole(req, res, ["admin", "kitchen"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const shift = normalizeShift(body.shift);
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const price = Number(body.price || db.settings.defaultMealPrice);
      let menu = getMenu(db, mealDate, shift);
      if (!menu) {
        menu = { id: crypto.randomUUID(), mealDate, shift };
        db.menus.push(menu);
      }
      Object.assign(menu, {
        dishes: String(body.dishes || ""),
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
      const user = requireRole(req, res, ["admin", "kitchen", "accountant"]);
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
          registeredQty: rows.length - added,
          addedAfterCutoffQty: added,
          totalQty: rows.length,
        };
      });
      return json(res, 200, { mealDate, summary, orders });
    }

    if (route === "GET /api/reports/monthly") {
      const user = requireRole(req, res, ["admin", "kitchen", "accountant", "worker"]);
      if (!user) return;
      const db = readDb();
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      let debts = buildMonthlyDebts(db, month);
      if (user.role === "worker") debts = debts.filter((d) => d.employeeCode === user.employeeCode);
      return json(res, 200, { month, debts });
    }

    if (route === "POST /api/payments/mark-paid") {
      const user = requireRole(req, res, ["admin", "accountant"]);
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
      audit(db, user, "MARK_PAID", { month, employeeCode, amount: debt.totalAmount });
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/payments/reconcile-csv") {
      const user = requireRole(req, res, ["admin", "accountant"]);
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
      const user = requireRole(req, res, ["admin", "accountant"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const db = readDb();
      const debts = buildMonthlyDebts(db, month).filter((d) => d.status !== "paid");
      const results = [];
      for (const debt of debts) {
        const worker = db.users.find((u) => u.employeeCode === debt.employeeCode);
        const text = `Anh/chi ${debt.fullName} co tien com thang ${month} la ${debt.totalAmount.toLocaleString(
          "vi-VN"
        )} dong. Vui long chuyen khoan voi noi dung: ${debt.paymentCode}`;
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
