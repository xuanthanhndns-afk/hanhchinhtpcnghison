const STATE_SHEET_NAME = "State";
const STATE_CELL = "A1";

function defaultDb_() {
  return {
    settings: {
      cutoffTime: "08:00",
      defaultMealPrice: 25000,
      paymentGraceDays: 5,
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
    auditLogs: [],
    sessions: [],
  };
}

function setup() {
  const sheet = getStateSheet_();
  if (!sheet.getRange(STATE_CELL).getValue()) {
    sheet.getRange(STATE_CELL).setValue(JSON.stringify(defaultDb_()));
  }
}

function doGet() {
  return json_({ ok: true, service: "meal-shift-google-apps-script" });
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const result = apiRun(payload);
    return json_(result);
  } catch (err) {
    return json_({ error: err.message || "Loi he thong" });
  }
}

function apiRun(payload) {
  const action = String(payload.action || "");
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const db = readDb_();
    const sessionUser = getSessionUser_(db, payload.sid);

    if (action === "login") {
      const user = findUserByLogin_(db, payload.loginId || payload.phone || payload.employeeCode);
      if (!user || user.password !== payload.password || user.status !== "active") {
        throw new Error("Sai tai khoan hoac mat khau");
      }
      const sid = Utilities.getUuid();
      db.sessions = (db.sessions || []).filter(function (item) {
        return item.userId !== user.id;
      });
      db.sessions.push({
        sid: sid,
        userId: user.id,
        createdAt: new Date().toISOString(),
      });
      writeDb_(db);
      return { sid: sid, user: sanitizeUser_(user) };
    }

    if (action === "logout") {
      db.sessions = (db.sessions || []).filter(function (item) {
        return item.sid !== payload.sid;
      });
      writeDb_(db);
      return { ok: true };
    }

    if (action === "me") {
      return { user: sessionUser ? sanitizeUser_(sessionUser) : null };
    }

    if (action === "bootstrap") {
      requireUser_(sessionUser);
      return {
        user: sanitizeUser_(sessionUser),
        settings: db.settings,
        users: sessionUser.role === "worker" ? [] : db.users.map(sanitizeUser_),
        chefs: db.chefs || [],
        menus: db.menus || [],
      };
    }

    if (action === "importWorkers") {
      requireRole_(sessionUser, ["admin"]);
      const rows = payload.rows || [];
      let created = 0;
      let updated = 0;
      rows.forEach(function (row) {
        const phone = String(row.phone || row["So dien thoai"] || row["Số điện thoại"] || "").trim();
        const fullName = String(row.fullName || row["Ho va ten"] || row["Họ và tên"] || "").trim();
        const department = String(row.department || row["Bo phan"] || row["Bộ phận"] || "").trim();
        if (!phone || !fullName) return;
        let worker = db.users.find(function (u) {
          return u.role === "worker" && (u.phone === phone || u.employeeCode === phone);
        });
        if (!worker) {
          worker = {
            id: Utilities.getUuid(),
            employeeCode: phone,
            password: "123456",
            role: "worker",
            status: "active",
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
        worker.phone = phone;
        worker.fullName = fullName;
        worker.department = department;
      });
      audit_(db, sessionUser, "IMPORT_WORKERS", { created: created, updated: updated });
      writeDb_(db);
      return { created: created, updated: updated };
    }

    throw new Error("Action chua duoc ho tro: " + action);
  } finally {
    lock.releaseLock();
  }
}

function getStateSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(STATE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(STATE_SHEET_NAME);
  return sheet;
}

function readDb_() {
  const raw = getStateSheet_().getRange(STATE_CELL).getValue();
  if (!raw) return defaultDb_();
  return JSON.parse(raw);
}

function writeDb_(db) {
  getStateSheet_().getRange(STATE_CELL).setValue(JSON.stringify(db));
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  const type = e.postData.type || "";
  if (type.indexOf("application/json") >= 0) {
    return JSON.parse(e.postData.contents);
  }
  return e.parameter || {};
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function findUserByLogin_(db, login) {
  const value = String(login || "").trim().toLowerCase();
  return db.users.find(function (u) {
    return String(u.employeeCode || "").toLowerCase() === value || String(u.phone || "").toLowerCase() === value;
  });
}

function getSessionUser_(db, sid) {
  if (!sid) return null;
  const session = (db.sessions || []).find(function (item) {
    return item.sid === sid;
  });
  if (!session) return null;
  return db.users.find(function (u) {
    return u.id === session.userId;
  }) || null;
}

function requireUser_(user) {
  if (!user) throw new Error("Chua dang nhap");
}

function requireRole_(user, roles) {
  requireUser_(user);
  if (roles.indexOf(user.role) < 0) throw new Error("Khong co quyen thao tac");
}

function sanitizeUser_(user) {
  const copy = JSON.parse(JSON.stringify(user));
  delete copy.password;
  return copy;
}

function audit_(db, actor, action, detail) {
  db.auditLogs = db.auditLogs || [];
  db.auditLogs.push({
    id: Utilities.getUuid(),
    at: new Date().toISOString(),
    actor: actor.employeeCode,
    action: action,
    detail: detail,
  });
}
