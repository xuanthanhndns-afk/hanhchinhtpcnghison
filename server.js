const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}
let XLSX = null;
try {
  XLSX = require("xlsx");
} catch {
  XLSX = null;
}

const PORT = Number(process.env.PORT || 3000);
const SEED_DATA_FILE = path.join(__dirname, "data", "db.json");
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : SEED_DATA_FILE;
const PUBLIC_DIR = path.join(__dirname, "public");
const TEMPLATES_DIR = path.join(__dirname, "templates");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const ONLINE_WINDOW_MINUTES = 15;
const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * 60 * 1000;

const sessions = new Map();
let pgPool = null;
let memoryDb = null;

function ensureDataFile() {
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(SEED_DATA_FILE, DATA_FILE);
  }
}

function readDb() {
  if (memoryDb) return JSON.parse(JSON.stringify(memoryDb));
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

async function writeDb(db) {
  if (pgPool) {
    memoryDb = JSON.parse(JSON.stringify(db));
    await pgPool.query(
      "insert into app_state (id, data, updated_at) values ($1, $2::jsonb, now()) on conflict (id) do update set data = excluded.data, updated_at = now()",
      ["main", JSON.stringify(memoryDb)]
    );
    return;
  }
  ensureDataFile();
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

async function initDb() {
  if (!DATABASE_URL) {
    ensureDataFile();
    return;
  }
  if (!Pool) {
    throw new Error("Chua cai thu vien PostgreSQL. Vui long chay npm install hoac doi Render deploy xong.");
  }
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  await pgPool.query(
    "create table if not exists app_state (id text primary key, data jsonb not null, updated_at timestamptz not null default now())"
  );
  const result = await pgPool.query("select data from app_state where id = $1", ["main"]);
  if (result.rows.length) {
    memoryDb = result.rows[0].data;
    return;
  }
  memoryDb = JSON.parse(fs.readFileSync(SEED_DATA_FILE, "utf8"));
  await pgPool.query("insert into app_state (id, data) values ($1, $2::jsonb)", ["main", JSON.stringify(memoryDb)]);
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
  session.lastSeen = Date.now();
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

function getSystemStats(db) {
  const now = Date.now();
  const since = now - ONLINE_WINDOW_MS;
  const workers = db.users.filter((u) => u.role === "worker");
  const onlineUserIds = new Set();
  for (const [sid, session] of sessions.entries()) {
    if (session.expiresAt && session.expiresAt < now) {
      sessions.delete(sid);
      continue;
    }
    if (Number(session.lastSeen || session.createdAt || 0) >= since) {
      onlineUserIds.add(session.userId);
    }
  }
  return {
    totalWorkers: workers.length,
    telegramLinked: workers.filter((u) => u.telegramChatId).length,
    onlineUsers: onlineUserIds.size,
    onlineWorkers: workers.filter((u) => onlineUserIds.has(u.id)).length,
    onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
  };
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
      if (raw.length > 15_000_000) {
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
  db.auditLogs = db.auditLogs || [];
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
  return shift === "lunch" ? "Trưa" : "Tối";
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

function parseXlsxBase64(fileBase64) {
  if (!XLSX) {
    throw new Error("Chua cai thu vien doc Excel. Vui long chay npm install hoac doi Render deploy xong.");
  }
  const buffer = Buffer.from(String(fileBase64 || ""), "base64");
  if (!buffer.length) return [];
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0111\u0110]/g, "d")
    .replace(/[^a-z0-9]/g, "");
}

function pick(row, names) {
  const entries = Object.entries(row);
  const normalizedNames = new Set(names.map(normalizeHeader));
  for (const name of names) {
    const found = entries.find(([k]) => normalizeHeader(k) === normalizeHeader(name) || normalizedNames.has(normalizeHeader(k)));
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

function parseBankAmount(value) {
  const cleaned = String(value || "").replace(/[^\d-]/g, "");
  return Number(cleaned || 0);
}

function normalizeBankRows(rows) {
  return rows
    .map((row) => ({
      date: pick(row, ["date", "ngay", "ngaygiaodich", "transactiondate", "thoigian"]),
      amount: parseBankAmount(pick(row, ["amount", "sotien", "giaodich", "credit", "sotiengd"])),
      description: pick(row, ["description", "noidung", "diengiai", "ghichu", "remark", "content"]),
    }))
    .filter((row) => row.amount || row.description);
}

function reconcileBankRows(db, user, month, rows, method) {
  const debts = buildMonthlyDebts(db, month);
  const matched = [];
  const unmatched = [];
  for (const row of normalizeBankRows(rows)) {
    const description = String(row.description || "").toUpperCase();
    const debt = debts.find((d) => row.amount === d.totalAmount && description.includes(d.paymentCode.toUpperCase()));
    const statement = {
      id: crypto.randomUUID(),
      month,
      date: row.date || "",
      amount: row.amount,
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
        amount: row.amount,
        paymentCode: debt.paymentCode,
        status: "paid",
        paidAt: nowIso(),
        paidBy: user.employeeCode,
        method,
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
  return { matched, unmatched };
}

function defaultTelegramTemplates() {
  return {
    debtNotice:
      "Kinh gui {hoTen}, tien com thang {thang} cua Anh/Chi la {soTien} dong. Vui long chuyen khoan voi noi dung: {maThanhToan}.",
    debtReminder:
      "Nhac no: Anh/Chi {hoTen} con tien com thang {thang} la {soTien} dong. Vui long thanh toan voi noi dung: {maThanhToan}. {ghiChuKhoa}",
  };
}

function renderTelegramTemplate(template, debt, month, worker, overdue) {
  const values = {
    hoTen: debt.fullName || "",
    thang: month,
    soTien: Number(debt.totalAmount || 0).toLocaleString("vi-VN"),
    maThanhToan: debt.paymentCode || "",
    soDienThoai: worker ? worker.phone || "" : "",
    boPhan: debt.department || "",
    ghiChuKhoa: overdue ? "Tai khoan se bi khoa dang ky com den khi thanh toan thanh cong." : "",
  };
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
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

function generateResetCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function cleanupResetCodes(db) {
  const now = Date.now();
  db.passwordResetCodes = (db.passwordResetCodes || []).filter((item) => Number(item.expiresAt || 0) > now);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isTemplate = url.pathname.startsWith("/templates/");
  const rootDir = isTemplate ? TEMPLATES_DIR : PUBLIC_DIR;
  const relativePath = isTemplate ? url.pathname.replace(/^\/templates\//, "") : url.pathname === "/" ? "index.html" : url.pathname;
  let filePath = path.join(rootDir, relativePath);
  if (!filePath.startsWith(rootDir)) return sendText(res, 403, "Forbidden");
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
      : ext === ".xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : ext === ".csv"
      ? "text/csv; charset=utf-8"
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
        return json(res, 401, { error: "Sai tài khoản hoặc mật khẩu" });
      }
      if (!user || user.status !== "active") return json(res, 401, { error: "Sai tài khoản hoặc mật khẩu" });
      const sid = crypto.randomUUID();
      const now = Date.now();
      sessions.set(sid, { userId: user.id, createdAt: now, lastSeen: now });
      res.setHeader("set-cookie", `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`);
      return json(res, 200, { user: sanitizeUser(user) });
    }

    if (route === "POST /api/password-reset/request") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const db = readDb();
      cleanupResetCodes(db);
      const worker = db.users.find((u) => u.role === "worker" && String(u.phone || "").trim() === phone && u.status === "active");
      if (!worker) {
        return json(res, 404, { error: "So dien thoai chua duoc dang ky. Xin vui long lien he admin de duoc cap tai khoan." });
      }
      if (!worker.telegramChatId) {
        return json(res, 400, { error: "Tai khoan chua lien ket Telegram. Xin vui long lien he admin de duoc ho tro dat lai mat khau." });
      }
      const code = generateResetCode();
      db.passwordResetCodes = (db.passwordResetCodes || []).filter((item) => item.userId !== worker.id);
      db.passwordResetCodes.push({
        id: crypto.randomUUID(),
        userId: worker.id,
        phone: worker.phone,
        code,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      const result = await sendTelegram(worker.telegramChatId, `Ma dat lai mat khau he thong com ca cua Anh/Chi la: ${code}. Ma co hieu luc trong 10 phut.`);
      if (!result.ok) return json(res, 400, { error: result.reason || result.description || "Khong gui duoc ma qua Telegram" });
      audit(db, worker, "REQUEST_PASSWORD_RESET", { phone: worker.phone });
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/password-reset/confirm") {
      const body = await readBody(req);
      const phone = String(body.phone || "").trim();
      const code = String(body.code || "").trim();
      const newPassword = String(body.newPassword || "");
      const confirmPassword = String(body.confirmPassword || "");
      if (newPassword.length < 6) return json(res, 400, { error: "Mat khau moi can toi thieu 6 ky tu" });
      if (newPassword !== confirmPassword) return json(res, 400, { error: "Mat khau moi va nhac lai mat khau khong khop" });
      const db = readDb();
      cleanupResetCodes(db);
      const worker = db.users.find((u) => u.role === "worker" && String(u.phone || "").trim() === phone && u.status === "active");
      if (!worker) {
        return json(res, 404, { error: "So dien thoai chua duoc dang ky. Xin vui long lien he admin de duoc cap tai khoan." });
      }
      const reset = (db.passwordResetCodes || []).find((item) => item.userId === worker.id && item.code === code);
      if (!reset) return json(res, 400, { error: "Ma xac thuc khong dung hoac da het han" });
      worker.password = newPassword;
      worker.mustChangePassword = false;
      db.passwordResetCodes = (db.passwordResetCodes || []).filter((item) => item.id !== reset.id);
      audit(db, worker, "CONFIRM_PASSWORD_RESET", { phone: worker.phone });
      await writeDb(db);
      return json(res, 200, { ok: true });
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
        systemStats: user.role === "admin" ? getSystemStats(db) : null,
        users: user.role === "worker" ? [] : db.users.map(sanitizeUser),
        chefs: db.chefs || [],
        menus: db.menus.sort((a, b) => `${a.mealDate}${a.shift}`.localeCompare(`${b.mealDate}${b.shift}`)),
      });
    }

    if (route === "POST /api/admin/import-workers") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const rows = body.fileBase64 ? parseXlsxBase64(body.fileBase64) : parseCsv(String(body.csv || ""));
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        const phone = pick(row, ["phone", "sodienthoai", "so dien thoai", "số điện thoại", "dien thoai", "sdt"]);
        const employeeCode = pick(row, ["employeeCode", "manv", "ma nv", "ma nhan vien"]) || phone;
        const fullName = pick(row, ["fullName", "hoten", "ho ten", "hovaten", "ho va ten", "họ tên", "họ và tên", "ten"]);
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
          department: pick(row, ["department", "bophan", "bo phan", "bộ phận", "phong ban"]) || worker.department || "",
        });
      }
      if (!created && !updated) {
        return json(res, 400, { error: "Khong nhap duoc dong nao. Vui long kiem tra file co dung cot: So thu tu, Ho va ten, Bo phan, So dien thoai." });
      }
      audit(db, user, "IMPORT_WORKERS", { created, updated });
      await writeDb(db);
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
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/admin/reset-worker-password") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const employeeCode = String(body.employeeCode || "");
      const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
      if (!worker) return json(res, 404, { error: "Khong tim thay thanh vien" });
      worker.password = "123456";
      worker.mustChangePassword = true;
      audit(db, user, "RESET_WORKER_PASSWORD", { employeeCode });
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/admin/chefs") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      db.chefs = db.chefs || [];
      const fullName = String(body.fullName || "").trim();
      const phone = String(body.phone || "").trim();
      if (!fullName || !phone) return json(res, 400, { error: "Can nhap ho ten va so dien thoai dau bep" });
      let chef = db.chefs.find((item) => item.phone === phone);
      if (!chef) {
        chef = { id: crypto.randomUUID(), createdAt: nowIso() };
        db.chefs.push(chef);
      }
      Object.assign(chef, { fullName, phone, updatedAt: nowIso(), updatedBy: user.employeeCode });
      audit(db, user, "UPSERT_CHEF", { chefId: chef.id, phone });
      await writeDb(db);
      return json(res, 200, { chef });
    }

    if (route === "POST /api/admin/delete-chef") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      db.chefs = db.chefs || [];
      const id = String(body.id || "");
      const chef = db.chefs.find((item) => item.id === id);
      if (!chef) return json(res, 404, { error: "Khong tim thay dau bep" });
      db.chefs = db.chefs.filter((item) => item.id !== id);
      for (const menu of db.menus) {
        menu.chefIds = (menu.chefIds || []).filter((chefId) => chefId !== id);
        menu.chefs = (menu.chefs || []).filter((item) => item.id !== id);
      }
      audit(db, user, "DELETE_CHEF", { chefId: id, phone: chef.phone });
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/profile/change-password") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const currentPassword = String(body.currentPassword || "");
      const newPassword = String(body.newPassword || "");
      const confirmPassword = String(body.confirmPassword || "");
      if (user.password !== currentPassword) return json(res, 400, { error: "Mat khau hien tai khong dung" });
      if (newPassword.length < 6) return json(res, 400, { error: "Mat khau moi can toi thieu 6 ky tu" });
      if (newPassword !== confirmPassword) return json(res, 400, { error: "Mat khau moi va nhac lai mat khau khong khop" });
      const db = readDb();
      const saved = db.users.find((u) => u.id === user.id);
      saved.password = newPassword;
      saved.mustChangePassword = false;
      audit(db, saved, "CHANGE_PASSWORD", { employeeCode: saved.employeeCode });
      await writeDb(db);
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
      await writeDb(db);
      return json(res, 200, { user: sanitizeUser(saved) });
    }

    if (route === "POST /api/settings/telegram-templates") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const defaults = defaultTelegramTemplates();
      db.settings.telegramTemplates = {
        debtNotice: String(body.debtNotice || defaults.debtNotice).trim(),
        debtReminder: String(body.debtReminder || defaults.debtReminder).trim(),
      };
      audit(db, user, "UPDATE_TELEGRAM_TEMPLATES", {});
      await writeDb(db);
      return json(res, 200, { telegramTemplates: db.settings.telegramTemplates });
    }

    if (route === "POST /api/telegram/manual") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const employeeCode = String(body.employeeCode || "").trim();
      const text = String(body.text || "").trim();
      if (!employeeCode) return json(res, 400, { error: "Vui long chon nguoi nhan" });
      if (!text) return json(res, 400, { error: "Vui long nhap noi dung tin nhan" });
      const db = readDb();
      const worker = db.users.find((u) => u.role === "worker" && u.employeeCode === employeeCode);
      if (!worker) return json(res, 404, { error: "Khong tim thay thanh vien" });
      if (!worker.telegramChatId) return json(res, 400, { error: "Thanh vien nay chua lien ket Telegram Chat ID" });
      const result = await sendTelegram(worker.telegramChatId, text);
      if (!result.ok) return json(res, 400, { error: result.reason || result.description || "Khong gui duoc tin nhan Telegram" });
      audit(db, user, "TELEGRAM_MANUAL", { employeeCode, ok: result.ok === true });
      await writeDb(db);
      return json(res, 200, { result, recipient: sanitizeUser(worker) });
    }

    if (route === "POST /api/menus") {
      const user = requireRole(req, res, ["admin", "kitchen"]);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      const shift = normalizeShift(body.shift);
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const items = Array.isArray(body.items) ? body.items : parseMenuItems(body.itemsText || body.dishes);
      const totalMenuValue = menuTotal(items);
      const price = totalMenuValue || Number(body.price || db.settings.defaultMealPrice);
      const chefIds = Array.isArray(body.chefIds) ? body.chefIds.map(String) : [];
      if (!chefIds.length) {
        return json(res, 400, { error: "Vui long chon it nhat mot dau bep truoc khi luu dinh luong bua an" });
      }
      const selectedChefs = (db.chefs || [])
        .filter((chef) => chefIds.includes(chef.id))
        .map((chef) => ({ id: chef.id, fullName: chef.fullName, phone: chef.phone }));
      if (!selectedChefs.length) {
        return json(res, 400, { error: "Danh sach dau bep khong hop le. Vui long chon lai dau bep." });
      }
      let menu = getMenu(db, mealDate, shift);
      if (!menu) {
        menu = { id: crypto.randomUUID(), mealDate, shift };
        db.menus.push(menu);
      }
      Object.assign(menu, {
        dishes: items.map((item) => item.name).join(", "),
        items,
        chefIds: selectedChefs.map((chef) => chef.id),
        chefs: selectedChefs,
        totalMenuValue,
        plannedQty: Number(body.plannedQty || 0),
        price,
        note: String(body.note || ""),
        updatedBy: user.employeeCode,
        updatedAt: nowIso(),
      });
      audit(db, user, "UPSERT_MENU", { mealDate, shift });
      await writeDb(db);
      return json(res, 200, { menu });
    }

    if (route === "POST /api/orders/register") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      if (user.role === "worker" && user.mustChangePassword) {
        return json(res, 403, { error: "Vui lòng đổi mật khẩu mặc định trước khi đăng ký cơm" });
      }
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
        return json(res, 400, { error: "Đã quá 08h, người dùng không được tự đăng ký suất ăn trong ngày này" });
      }
      if (!beforeCutoff && user.role !== "kitchen" && user.role !== "admin") {
        return json(res, 400, { error: "Sau giờ chốt chỉ nhà bếp hoặc admin được bổ sung suất ăn" });
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
      await writeDb(db);
      return json(res, 200, { order });
    }

    if (route === "POST /api/orders/cancel") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = readDb();
      if (user.role === "worker" && user.mustChangePassword) {
        return json(res, 403, { error: "Vui lòng đổi mật khẩu mặc định trước khi thao tác" });
      }
      const employeeCode = user.role === "worker" ? user.employeeCode : String(body.employeeCode || "");
      const mealDate = String(body.mealDate || "").slice(0, 10);
      const shift = normalizeShift(body.shift);
      const order = db.orders.find(
        (o) => o.employeeCode === employeeCode && o.mealDate === mealDate && o.shift === shift
      );
      if (!order) return json(res, 404, { error: "Khong tim thay dang ky" });
      const beforeCutoff = isBeforeCutoff(mealDate, db.settings.cutoffTime);
      if (user.role === "worker" && !beforeCutoff) return json(res, 400, { error: "Đã quá 08h, không được tự hủy đăng ký suất ăn trong ngày này" });
      order.status = beforeCutoff ? "cancelled_before_cutoff" : "cancelled_by_admin";
      order.cancelledAt = nowIso();
      order.operatedBy = user.employeeCode;
      order.note = String(body.note || order.note || "");
      audit(db, user, "CANCEL_ORDER", { employeeCode, mealDate, shift, status: order.status });
      await writeDb(db);
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
        const totalAmount = rows.reduce((sum, order) => sum + Number(order.price || 0), 0);
        return {
          shift,
          shiftLabel: shiftLabel(shift),
          plannedQty: menu ? menu.plannedQty : 0,
          menuItems: menu ? menu.items || [] : [],
          totalMenuValue: menu ? Number(menu.totalMenuValue || 0) : 0,
          registeredQty: rows.length - added,
          addedAfterCutoffQty: added,
          totalQty: rows.length,
          totalAmount,
        };
      });
      const totalDayAmount = summary.reduce((sum, item) => sum + item.totalAmount, 0);
      return json(res, 200, { mealDate, summary, totalDayAmount, orders });
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
      await writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/payments/reconcile-csv") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const rows = parseCsv(String(body.csv || ""));
      const db = readDb();
      const { matched, unmatched } = reconcileBankRows(db, user, month, rows, "bank_csv");
      audit(db, user, "RECONCILE_CSV", { month, matched: matched.length, unmatched: unmatched.length });
      await writeDb(db);
      return json(res, 200, { matched, unmatched });
    }

    if (route === "POST /api/payments/reconcile-xlsx") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const rows = parseXlsxBase64(body.fileBase64);
      const db = readDb();
      const { matched, unmatched } = reconcileBankRows(db, user, month, rows, "bank_xlsx");
      audit(db, user, "RECONCILE_XLSX", { month, matched: matched.length, unmatched: unmatched.length, fileName: body.fileName || "" });
      await writeDb(db);
      return json(res, 200, { matched, unmatched });
    }

    if (route === "POST /api/telegram/remind") {
      const user = requireRole(req, res, ["admin"]);
      if (!user) return;
      const body = await readBody(req);
      const month = String(body.month || "");
      const db = readDb();
      const defaults = defaultTelegramTemplates();
      if (body.debtNotice || body.debtReminder) {
        db.settings.telegramTemplates = {
          debtNotice: String(body.debtNotice || defaults.debtNotice).trim(),
          debtReminder: String(body.debtReminder || defaults.debtReminder).trim(),
        };
      }
      const templates = { ...defaults, ...(db.settings.telegramTemplates || {}) };
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
        const template = overdue ? templates.debtReminder : templates.debtNotice;
        const text = renderTelegramTemplate(template, debt, month, worker, overdue);
        const result = await sendTelegram(worker ? worker.telegramChatId : "", text);
        results.push({ employeeCode: debt.employeeCode, result });
      }
      audit(db, user, "TELEGRAM_REMIND", { month, count: results.length });
      await writeDb(db);
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

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Meal shift web running at http://localhost:${PORT}`);
      console.log(`Data store: ${DATABASE_URL ? "PostgreSQL" : DATA_FILE}`);
    });
  })
  .catch((err) => {
    console.error("Cannot start server:", err);
    process.exit(1);
  });
