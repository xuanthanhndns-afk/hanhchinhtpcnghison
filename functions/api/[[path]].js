let xlsxModule = null;

const SESSION_DAYS = 14;
const ONLINE_WINDOW_MINUTES = 15;
const ONLINE_WINDOW_MS = ONLINE_WINDOW_MINUTES * 60 * 1000;

const seedDb = {
  settings: {
    cutoffTime: "08:00",
    defaultMealPrice: 25000,
    paymentGraceDays: 5,
    telegramTemplates: {
      debtNotice:
        "Kinh gui {hoTen}, tien com thang {thang} cua Anh/Chi la {soTien} dong. Vui long chuyen khoan voi noi dung: {maThanhToan}.",
      debtReminder:
        "Nhac no: Anh/Chi {hoTen} con tien com thang {thang} la {soTien} dong. Vui long thanh toan voi noi dung: {maThanhToan}. {ghiChuKhoa}",
    },
    payment: {
      bankBin: "970436",
      accountNo: "0123456789",
      accountName: "CONG TY ABC",
      template: "compact2",
    },
  },
  users: [
    {
      id: "u-admin",
      employeeCode: "admin",
      password: "123456",
      fullName: "Quan tri he thong",
      department: "Admin",
      role: "admin",
      status: "active",
      phone: "admin",
      mustChangePassword: false,
      registrationLocked: false,
      lockedReason: "",
      lockedAt: "",
      telegramChatId: "",
    },
    {
      id: "u-kitchen",
      employeeCode: "Nhabep",
      password: "123456",
      fullName: "Nha bep",
      department: "Bep an",
      role: "kitchen",
      status: "active",
      phone: "Nhabep",
      mustChangePassword: false,
      registrationLocked: false,
      lockedReason: "",
      lockedAt: "",
      telegramChatId: "",
    },
  ],
  chefs: [],
  menus: [],
  orders: [],
  payments: [],
  bankStatements: [],
  passwordResetCodes: [],
  auditLogs: [],
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
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

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  if (!text) return {};
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(400, "JSON khong hop le");
    }
  }
  return { raw: text };
}

async function ensureSchema(env) {
  if (!env.DB) throw new ApiError(500, "Chua gan Cloudflare D1 binding DB");
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)"
  ).run();
  const sessionColumns = await env.DB.prepare("PRAGMA table_info(sessions)").all();
  const hasLastSeen = (sessionColumns.results || []).some((column) => column.name === "last_seen");
  if (!hasLastSeen) {
    await env.DB.prepare("ALTER TABLE sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0").run();
  }
}

async function readDb(env) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = ?").bind("main").first();
  if (row && row.data) return JSON.parse(row.data);
  const initial = clone(seedDb);
  await writeDb(env, initial);
  return initial;
}

async function writeDb(env, db) {
  await ensureSchema(env);
  await env.DB.prepare(
    "INSERT INTO app_state (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP"
  )
    .bind("main", JSON.stringify(db))
    .run();
}

async function createSession(env, userId) {
  const sid = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await env.DB.prepare("INSERT INTO sessions (sid, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)")
    .bind(sid, userId, createdAt, expiresAt, createdAt)
    .run();
  return sid;
}

async function deleteSession(env, sid) {
  if (!sid) return;
  await env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(sid).run();
}

async function getCurrentUser(request, env) {
  const sid = parseCookies(request).sid;
  if (!sid) return null;
  await ensureSchema(env);
  const session = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE sid = ?").bind(sid).first();
  if (!session || Number(session.expires_at) < Date.now()) {
    await deleteSession(env, sid);
    return null;
  }
  await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE sid = ?").bind(Date.now(), sid).run();
  const db = await readDb(env);
  return db.users.find((u) => u.id === session.user_id) || null;
}

async function requireUser(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user) throw new ApiError(401, "Chua dang nhap");
  return user;
}

async function requireRole(request, env, roles) {
  const user = await requireUser(request, env);
  if (!roles.includes(user.role)) throw new ApiError(403, "Khong co quyen thao tac");
  return user;
}

async function getSystemStats(env, db) {
  await ensureSchema(env);
  const now = Date.now();
  const since = now - ONLINE_WINDOW_MS;
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  const rows = await env.DB.prepare(
    "SELECT DISTINCT user_id FROM sessions WHERE expires_at >= ? AND COALESCE(NULLIF(last_seen, 0), created_at) >= ?"
  )
    .bind(now, since)
    .all();
  const onlineUserIds = new Set((rows.results || []).map((row) => row.user_id));
  const workers = db.users.filter((u) => u.role === "worker");
  return {
    totalWorkers: workers.length,
    telegramLinked: workers.filter((u) => u.telegramChatId).length,
    onlineUsers: onlineUserIds.size,
    onlineWorkers: workers.filter((u) => onlineUserIds.has(u.id)).length,
    onlineWindowMinutes: ONLINE_WINDOW_MINUTES,
  };
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

function findUserByLogin(db, login) {
  const value = String(login || "").trim().toLowerCase();
  return db.users.find((u) => {
    return String(u.employeeCode || "").toLowerCase() === value || String(u.phone || "").toLowerCase() === value;
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

function addMonths(month, offset) {
  const [year, mm] = month.split("-").map(Number);
  const date = new Date(year, mm - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dueDateForMonth(month, graceDays) {
  const [year, mm] = month.split("-").map(Number);
  const due = new Date(year, mm, 1);
  due.setDate(due.getDate() + Number(graceDays || 5));
  return due;
}

function isBeforeCutoff(mealDate, cutoffTime) {
  const [hour, minute] = String(cutoffTime || "08:00").split(":").map(Number);
  const cutoff = new Date(`${mealDate}T00:00:00`);
  cutoff.setHours(hour, minute, 0, 0);
  return new Date() < cutoff;
}

function orderKey(employeeCode, mealDate, shift) {
  return `${employeeCode}|${mealDate}|${shift}`;
}

function normalizeShift(shift) {
  if (!["lunch", "dinner"].includes(shift)) throw new ApiError(400, "Ca an khong hop le");
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
    return o.mealDate.startsWith(month) && ["registered", "locked", "added_after_cutoff"].includes(o.status);
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
  if (user.registrationLocked) return { locked: true, reason: user.lockedReason || "Tai khoan dang bi khoa dang ky" };
  const overdue = getOverdueDebt(db, user.employeeCode);
  if (!overdue) return { locked: false };
  return {
    locked: true,
    reason: `Con no tien com ${overdue.month}: ${overdue.totalAmount.toLocaleString("vi-VN")} dong`,
    overdue,
  };
}

function parseCsv(raw) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i] || ""]));
  });
}

function base64ToBinary(base64) {
  const clean = String(base64 || "");
  return atob(clean);
}

async function parseXlsxBase64(fileBase64) {
  if (!xlsxModule) xlsxModule = await import("xlsx");
  const XLSX = xlsxModule.default || xlsxModule;
  const binary = base64ToBinary(fileBase64);
  if (!binary) return [];
  const workbook = XLSX.read(binary, { type: "binary", cellDates: false, raw: false });
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
  for (const [key, value] of entries) {
    if (normalizedNames.has(normalizeHeader(key))) return String(value || "").trim();
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

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, skipped: true, reason: "Chua cau hinh TELEGRAM_BOT_TOKEN" };
  if (!chatId) return { ok: false, skipped: true, reason: "Nguoi dung chua co telegramChatId" };
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return response.json();
}

function generateResetCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1_000_000).padStart(6, "0");
}

function cleanupResetCodes(db) {
  const now = Date.now();
  db.passwordResetCodes = (db.passwordResetCodes || []).filter((item) => Number(item.expiresAt || 0) > now);
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  if (route === "POST /api/login") {
    const body = await readBody(request);
    const db = await readDb(env);
    const user = findUserByLogin(db, body.loginId || body.employeeCode || body.phone);
    if (!user || user.password !== body.password || user.status !== "active") {
      throw new ApiError(401, "Sai tài khoản hoặc mật khẩu");
    }
    const sid = await createSession(env, user.id);
    return json(
      { user: sanitizeUser(user) },
      200,
      { "set-cookie": `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` }
    );
  }

  if (route === "POST /api/password-reset/request") {
    const body = await readBody(request);
    const phone = String(body.phone || "").trim();
    const db = await readDb(env);
    cleanupResetCodes(db);
    const worker = db.users.find((u) => u.role === "worker" && String(u.phone || "").trim() === phone && u.status === "active");
    if (!worker) {
      throw new ApiError(404, "So dien thoai chua duoc dang ky. Xin vui long lien he admin de duoc cap tai khoan.");
    }
    if (!worker.telegramChatId) {
      throw new ApiError(400, "Tai khoan chua lien ket Telegram. Xin vui long lien he admin de duoc ho tro dat lai mat khau.");
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
    const result = await sendTelegram(env, worker.telegramChatId, `Ma dat lai mat khau he thong com ca cua Anh/Chi la: ${code}. Ma co hieu luc trong 10 phut.`);
    if (!result.ok) throw new ApiError(400, result.reason || result.description || "Khong gui duoc ma qua Telegram");
    audit(db, worker, "REQUEST_PASSWORD_RESET", { phone: worker.phone });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/password-reset/confirm") {
    const body = await readBody(request);
    const phone = String(body.phone || "").trim();
    const code = String(body.code || "").trim();
    const newPassword = String(body.newPassword || "");
    const confirmPassword = String(body.confirmPassword || "");
    if (newPassword.length < 6) throw new ApiError(400, "Mat khau moi can toi thieu 6 ky tu");
    if (newPassword !== confirmPassword) throw new ApiError(400, "Mat khau moi va nhac lai mat khau khong khop");
    const db = await readDb(env);
    cleanupResetCodes(db);
    const worker = db.users.find((u) => u.role === "worker" && String(u.phone || "").trim() === phone && u.status === "active");
    if (!worker) {
      throw new ApiError(404, "So dien thoai chua duoc dang ky. Xin vui long lien he admin de duoc cap tai khoan.");
    }
    const reset = (db.passwordResetCodes || []).find((item) => item.userId === worker.id && item.code === code);
    if (!reset) throw new ApiError(400, "Ma xac thuc khong dung hoac da het han");
    worker.password = newPassword;
    worker.mustChangePassword = false;
    db.passwordResetCodes = (db.passwordResetCodes || []).filter((item) => item.id !== reset.id);
    audit(db, worker, "CONFIRM_PASSWORD_RESET", { phone: worker.phone });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/logout") {
    await deleteSession(env, parseCookies(request).sid);
    return json({ ok: true }, 200, { "set-cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (route === "GET /api/me") {
    const user = await getCurrentUser(request, env);
    return json({ user: user ? sanitizeUser(user) : null });
  }

  if (route === "GET /api/bootstrap") {
    const user = await requireUser(request, env);
    const db = await readDb(env);
    const lock = isWorkerRegistrationLocked(db, user);
    return json({
      user: { ...sanitizeUser(user), registrationLockedNow: lock.locked, lockReasonNow: lock.reason || "" },
      settings: db.settings,
      systemStats: user.role === "admin" ? await getSystemStats(env, db) : null,
      users: user.role === "worker" ? [] : db.users.map(sanitizeUser),
      chefs: db.chefs || [],
      menus: db.menus.sort((a, b) => `${a.mealDate}${a.shift}`.localeCompare(`${b.mealDate}${b.shift}`)),
    });
  }

  if (route === "POST /api/admin/import-workers") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const rows = body.fileBase64 ? await parseXlsxBase64(body.fileBase64) : parseCsv(String(body.csv || ""));
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
      throw new ApiError(400, "Khong nhap duoc dong nao. Vui long kiem tra file co dung cot: So thu tu, Ho va ten, Bo phan, So dien thoai.");
    }
    audit(db, user, "IMPORT_WORKERS", { created, updated });
    await writeDb(env, db);
    return json({ created, updated });
  }

  if (route === "POST /api/admin/delete-worker") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const employeeCode = String(body.employeeCode || "");
    const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
    if (!worker) throw new ApiError(404, "Khong tim thay cong nhan");
    db.users = db.users.filter((u) => u.id !== worker.id);
    audit(db, user, "DELETE_WORKER", { employeeCode });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/admin/reset-worker-password") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const employeeCode = String(body.employeeCode || "");
    const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
    if (!worker) throw new ApiError(404, "Khong tim thay thanh vien");
    worker.password = "123456";
    worker.mustChangePassword = true;
    audit(db, user, "RESET_WORKER_PASSWORD", { employeeCode });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/admin/chefs") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    db.chefs = db.chefs || [];
    const fullName = String(body.fullName || "").trim();
    const phone = String(body.phone || "").trim();
    if (!fullName || !phone) throw new ApiError(400, "Can nhap ho ten va so dien thoai dau bep");
    let chef = db.chefs.find((item) => item.phone === phone);
    if (!chef) {
      chef = { id: crypto.randomUUID(), createdAt: nowIso() };
      db.chefs.push(chef);
    }
    Object.assign(chef, { fullName, phone, updatedAt: nowIso(), updatedBy: user.employeeCode });
    audit(db, user, "UPSERT_CHEF", { chefId: chef.id, phone });
    await writeDb(env, db);
    return json({ chef });
  }

  if (route === "POST /api/admin/delete-chef") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const id = String(body.id || "");
    const chef = (db.chefs || []).find((item) => item.id === id);
    if (!chef) throw new ApiError(404, "Khong tim thay dau bep");
    db.chefs = db.chefs.filter((item) => item.id !== id);
    for (const menu of db.menus) {
      menu.chefIds = (menu.chefIds || []).filter((chefId) => chefId !== id);
      menu.chefs = (menu.chefs || []).filter((item) => item.id !== id);
    }
    audit(db, user, "DELETE_CHEF", { chefId: id, phone: chef.phone });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/profile/change-password") {
    const user = await requireUser(request, env);
    const body = await readBody(request);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    const confirmPassword = String(body.confirmPassword || "");
    if (user.password !== currentPassword) throw new ApiError(400, "Mat khau hien tai khong dung");
    if (newPassword.length < 6) throw new ApiError(400, "Mat khau moi can toi thieu 6 ky tu");
    if (newPassword !== confirmPassword) throw new ApiError(400, "Mat khau moi va nhac lai mat khau khong khop");
    const db = await readDb(env);
    const saved = db.users.find((u) => u.id === user.id);
    saved.password = newPassword;
    saved.mustChangePassword = false;
    audit(db, saved, "CHANGE_PASSWORD", { employeeCode: saved.employeeCode });
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/profile/telegram") {
    const user = await requireUser(request, env);
    const body = await readBody(request);
    const db = await readDb(env);
    const saved = db.users.find((u) => u.id === user.id);
    saved.telegramChatId = String(body.telegramChatId || "").trim();
    audit(db, saved, "UPDATE_TELEGRAM", { employeeCode: saved.employeeCode });
    await writeDb(env, db);
    return json({ user: sanitizeUser(saved) });
  }

  if (route === "POST /api/settings/telegram-templates") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const defaults = defaultTelegramTemplates();
    db.settings.telegramTemplates = {
      debtNotice: String(body.debtNotice || defaults.debtNotice).trim(),
      debtReminder: String(body.debtReminder || defaults.debtReminder).trim(),
    };
    audit(db, user, "UPDATE_TELEGRAM_TEMPLATES", {});
    await writeDb(env, db);
    return json({ telegramTemplates: db.settings.telegramTemplates });
  }

  if (route === "POST /api/telegram/manual") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const employeeCode = String(body.employeeCode || "").trim();
    const text = String(body.text || "").trim();
    if (!employeeCode) throw new ApiError(400, "Vui long chon nguoi nhan");
    if (!text) throw new ApiError(400, "Vui long nhap noi dung tin nhan");
    const db = await readDb(env);
    const worker = db.users.find((u) => u.role === "worker" && u.employeeCode === employeeCode);
    if (!worker) throw new ApiError(404, "Khong tim thay thanh vien");
    if (!worker.telegramChatId) throw new ApiError(400, "Thanh vien nay chua lien ket Telegram Chat ID");
    const result = await sendTelegram(env, worker.telegramChatId, text);
    if (!result.ok) throw new ApiError(400, result.reason || result.description || "Khong gui duoc tin nhan Telegram");
    audit(db, user, "TELEGRAM_MANUAL", { employeeCode, ok: result.ok === true });
    await writeDb(env, db);
    return json({ result, recipient: sanitizeUser(worker) });
  }

  if (route === "POST /api/menus") {
    const user = await requireRole(request, env, ["admin", "kitchen"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const shift = normalizeShift(body.shift);
    const mealDate = String(body.mealDate || "").slice(0, 10);
    const items = Array.isArray(body.items) ? body.items : parseMenuItems(body.itemsText || body.dishes);
    const totalMenuValue = menuTotal(items);
    const price = totalMenuValue || Number(body.price || db.settings.defaultMealPrice);
    const chefIds = Array.isArray(body.chefIds) ? body.chefIds.map(String) : [];
    if (!chefIds.length) throw new ApiError(400, "Vui long chon it nhat mot dau bep truoc khi luu dinh luong bua an");
    const selectedChefs = (db.chefs || [])
      .filter((chef) => chefIds.includes(chef.id))
      .map((chef) => ({ id: chef.id, fullName: chef.fullName, phone: chef.phone }));
    if (!selectedChefs.length) throw new ApiError(400, "Danh sach dau bep khong hop le. Vui long chon lai dau bep.");
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
    await writeDb(env, db);
    return json({ menu });
  }

  if (route === "POST /api/orders/register") {
    const user = await requireUser(request, env);
    const body = await readBody(request);
    const db = await readDb(env);
    if (user.role === "worker" && user.mustChangePassword) throw new ApiError(403, "Vui long doi mat khau mac dinh truoc khi dang ky com");
    const lock = isWorkerRegistrationLocked(db, user);
    if (lock.locked && user.role === "worker") throw new ApiError(423, `Tai khoan bi khoa dang ky. ${lock.reason}`);
    const employeeCode = user.role === "worker" ? user.employeeCode : String(body.employeeCode || "");
    if (user.role !== "worker" && !["admin", "kitchen"].includes(user.role)) throw new ApiError(403, "Khong co quyen dang ky ho");
    const worker = db.users.find((u) => u.employeeCode === employeeCode && u.role === "worker");
    if (!worker) throw new ApiError(404, "Khong tim thay cong nhan");
    const mealDate = String(body.mealDate || "").slice(0, 10);
    const shift = normalizeShift(body.shift);
    const beforeCutoff = isBeforeCutoff(mealDate, db.settings.cutoffTime);
    if (!beforeCutoff && user.role === "worker") throw new ApiError(400, "Da qua 08h, cong nhan khong duoc tu dang ky");
    if (!beforeCutoff && user.role !== "kitchen" && user.role !== "admin") throw new ApiError(400, "Sau gio chot chi nha bep/admin duoc bo sung");
    const menu = getMenu(db, mealDate, shift);
    const key = orderKey(employeeCode, mealDate, shift);
    let order = db.orders.find((o) => orderKey(o.employeeCode, o.mealDate, o.shift) === key);
    if (order && ["registered", "locked", "added_after_cutoff"].includes(order.status)) {
      throw new ApiError(400, "Nhan vien da co dang ky ca nay");
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
    await writeDb(env, db);
    return json({ order });
  }

  if (route === "POST /api/orders/cancel") {
    const user = await requireUser(request, env);
    const body = await readBody(request);
    const db = await readDb(env);
    if (user.role === "worker" && user.mustChangePassword) throw new ApiError(403, "Vui long doi mat khau mac dinh truoc khi thao tac");
    const employeeCode = user.role === "worker" ? user.employeeCode : String(body.employeeCode || "");
    const mealDate = String(body.mealDate || "").slice(0, 10);
    const shift = normalizeShift(body.shift);
    const order = db.orders.find((o) => o.employeeCode === employeeCode && o.mealDate === mealDate && o.shift === shift);
    if (!order) throw new ApiError(404, "Khong tim thay dang ky");
    const beforeCutoff = isBeforeCutoff(mealDate, db.settings.cutoffTime);
    if (user.role === "worker" && !beforeCutoff) throw new ApiError(400, "Da qua 08h, khong duoc tu huy");
    order.status = beforeCutoff ? "cancelled_before_cutoff" : "cancelled_by_admin";
    order.cancelledAt = nowIso();
    order.operatedBy = user.employeeCode;
    order.note = String(body.note || order.note || "");
    audit(db, user, "CANCEL_ORDER", { employeeCode, mealDate, shift, status: order.status });
    await writeDb(env, db);
    return json({ order });
  }

  if (route === "GET /api/orders") {
    const user = await requireUser(request, env);
    const db = await readDb(env);
    const mealDate = url.searchParams.get("mealDate") || "";
    let orders = db.orders;
    if (mealDate) orders = orders.filter((o) => o.mealDate === mealDate);
    if (user.role === "worker") orders = orders.filter((o) => o.employeeCode === user.employeeCode);
    return json({ orders });
  }

  if (route === "GET /api/reports/daily") {
    await requireRole(request, env, ["admin", "kitchen"]);
    const db = await readDb(env);
    const mealDate = url.searchParams.get("mealDate") || new Date().toISOString().slice(0, 10);
    const orders = db.orders.filter((o) => o.mealDate === mealDate && ["registered", "locked", "added_after_cutoff"].includes(o.status));
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
    return json({ mealDate, summary, totalDayAmount, orders });
  }

  if (route === "GET /api/reports/monthly") {
    const user = await requireRole(request, env, ["admin", "kitchen", "worker"]);
    const db = await readDb(env);
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    let debts = buildMonthlyDebts(db, month);
    if (user.role === "worker") debts = debts.filter((d) => d.employeeCode === user.employeeCode);
    return json({ month, debts });
  }

  if (route === "GET /api/reports/locked-users") {
    await requireRole(request, env, ["admin"]);
    const db = await readDb(env);
    const rows = db.users
      .filter((u) => u.role === "worker")
      .map((u) => ({ user: sanitizeUser(u), lock: isWorkerRegistrationLocked(db, u) }))
      .filter((r) => r.lock.locked);
    return json({ rows });
  }

  if (route === "POST /api/payments/mark-paid") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const db = await readDb(env);
    const month = String(body.month || "");
    const employeeCode = String(body.employeeCode || "");
    const debt = buildMonthlyDebts(db, month).find((d) => d.employeeCode === employeeCode);
    if (!debt) throw new ApiError(404, "Khong co cong no thang nay");
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
    await writeDb(env, db);
    return json({ ok: true });
  }

  if (route === "POST /api/payments/reconcile-csv") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const month = String(body.month || "");
    const rows = parseCsv(String(body.csv || ""));
    const db = await readDb(env);
    const { matched, unmatched } = reconcileBankRows(db, user, month, rows, "bank_csv");
    audit(db, user, "RECONCILE_CSV", { month, matched: matched.length, unmatched: unmatched.length });
    await writeDb(env, db);
    return json({ matched, unmatched });
  }

  if (route === "POST /api/payments/reconcile-xlsx") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const month = String(body.month || "");
    const rows = await parseXlsxBase64(body.fileBase64);
    const db = await readDb(env);
    const { matched, unmatched } = reconcileBankRows(db, user, month, rows, "bank_xlsx");
    audit(db, user, "RECONCILE_XLSX", { month, matched: matched.length, unmatched: unmatched.length, fileName: body.fileName || "" });
    await writeDb(env, db);
    return json({ matched, unmatched });
  }

  if (route === "POST /api/telegram/remind") {
    const user = await requireRole(request, env, ["admin"]);
    const body = await readBody(request);
    const month = String(body.month || "");
    const db = await readDb(env);
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
      const result = await sendTelegram(env, worker ? worker.telegramChatId : "", text);
      results.push({ employeeCode: debt.employeeCode, result });
    }
    audit(db, user, "TELEGRAM_REMIND", { month, count: results.length });
    await writeDb(env, db);
    return json({ results });
  }

  throw new ApiError(404, "API khong ton tai");
}

export async function onRequest(context) {
  try {
    return await handleApi(context.request, context.env);
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    return json({ error: err.message || "Loi he thong" }, 500);
  }
}
