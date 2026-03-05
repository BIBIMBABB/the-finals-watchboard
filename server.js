const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "change-this-admin-token");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const SUPABASE_TABLE = String(process.env.SUPABASE_TABLE || "watch_entries");
const USE_SUPABASE = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE_KEY;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeVerdict(v) {
  const x = norm(v);
  if (x === "confirmed" || x === "suspected" || x === "teaming") return x;
  return "suspected";
}

function normalizeEntry(input, prev = null) {
  const now = new Date().toISOString();
  const playerId = String(input?.playerId || prev?.playerId || "").trim();
  const displayName = String(input?.displayName || prev?.displayName || "").trim();
  const tagsRaw = Array.isArray(input?.tags) ? input.tags : Array.isArray(prev?.tags) ? prev.tags : [];
  const tags = tagsRaw.map((x) => String(x).trim()).filter(Boolean);
  const cheatVerdict = normalizeVerdict(input?.cheatVerdict || prev?.cheatVerdict || input?.status);

  if (!playerId || !displayName) return null;

  return {
    playerId,
    displayName,
    tags,
    cheatVerdict,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    lastSeenAt: prev?.lastSeenAt || now,
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]\n", "utf8");
}

function readEntriesFile() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e) => normalizeEntry(e, e)).filter(Boolean);
  } catch {
    return [];
  }
}

function writeEntriesFile(entries) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function sbRequest(route, options = {}) {
  const headers = {
    Accept: "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(options.headers || {}),
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${route}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Supabase HTTP ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function readEntriesSupabase() {
  const data = await sbRequest(`${encodeURIComponent(SUPABASE_TABLE)}?select=*`);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((e) => normalizeEntry(e, e)).filter(Boolean);
}

async function upsertEntrySupabase(payload) {
  const id = String(payload?.playerId || "").trim();
  if (!id) throw new Error("playerId required");

  const existingRows = await sbRequest(
    `${encodeURIComponent(SUPABASE_TABLE)}?select=*&playerId=eq.${encodeURIComponent(id)}`
  );
  const prev = Array.isArray(existingRows) && existingRows.length > 0 ? normalizeEntry(existingRows[0], existingRows[0]) : null;
  const next = normalizeEntry(payload, prev);
  if (!next) throw new Error("playerId/displayName required");

  if (prev) {
    const updatedRows = await sbRequest(
      `${encodeURIComponent(SUPABASE_TABLE)}?playerId=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(next),
      }
    );
    if (Array.isArray(updatedRows) && updatedRows.length > 0) return normalizeEntry(updatedRows[0], updatedRows[0]);
    return next;
  }

  const insertedRows = await sbRequest(encodeURIComponent(SUPABASE_TABLE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(next),
  });
  if (Array.isArray(insertedRows) && insertedRows.length > 0) return normalizeEntry(insertedRows[0], insertedRows[0]);
  return next;
}

async function deleteEntrySupabase(playerId) {
  const id = String(playerId || "").trim();
  if (!id) return { deleted: false, total: null };

  const deletedRows = await sbRequest(
    `${encodeURIComponent(SUPABASE_TABLE)}?playerId=eq.${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        Prefer: "return=representation",
      },
    }
  );

  const deleted = Array.isArray(deletedRows) && deletedRows.length > 0;
  const all = await readEntriesSupabase();
  return { deleted, total: all.length };
}

async function listEntries() {
  if (USE_SUPABASE) return readEntriesSupabase();
  return readEntriesFile();
}

async function upsertEntry(payload) {
  if (USE_SUPABASE) {
    const entry = await upsertEntrySupabase(payload);
    const all = await readEntriesSupabase();
    return { entry, total: all.length };
  }

  const entries = readEntriesFile();
  const idx = entries.findIndex((e) => norm(e.playerId) === norm(payload?.playerId));
  const prev = idx >= 0 ? entries[idx] : null;
  const next = normalizeEntry(payload, prev);
  if (!next) throw new Error("playerId/displayName required");

  if (idx >= 0) entries[idx] = next;
  else entries.push(next);

  writeEntriesFile(entries);
  return { entry: next, total: entries.length };
}

async function deleteEntry(playerId) {
  if (USE_SUPABASE) return deleteEntrySupabase(playerId);

  const entries = readEntriesFile();
  const next = entries.filter((e) => norm(e.playerId) !== norm(playerId));
  const deleted = next.length !== entries.length;
  if (deleted) writeEntriesFile(next);
  return { deleted, total: next.length };
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function unauthorized(res) {
  sendJson(res, 401, { error: "Unauthorized" });
}

function isAuthorized(req) {
  const token = String(req.headers["x-admin-token"] || "").trim();
  return !!token && token === ADMIN_TOKEN;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(reqPath, res) {
  const safePath = reqPath === "/" ? "/index.html" : reqPath;
  const resolved = path.resolve(ROOT, `.${safePath}`);
  if (!resolved.startsWith(ROOT)) return sendText(res, 403, "Forbidden");
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return sendText(res, 404, "Not found");

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  const file = fs.readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "no-store",
  });
  res.end(file);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        storage: USE_SUPABASE ? "supabase" : "file",
      });
      return;
    }

    if (pathname === "/api/auth/check" && req.method === "GET") {
      if (!isAuthorized(req)) return unauthorized(res);
      sendJson(res, 200, { ok: true, role: "admin" });
      return;
    }

    if (pathname === "/api/entries" && req.method === "GET") {
      const entries = await listEntries();
      sendJson(res, 200, { entries });
      return;
    }

    if (pathname === "/api/entries" && req.method === "POST") {
      if (!isAuthorized(req)) return unauthorized(res);
      const payload = await readJsonBody(req);

      try {
        const result = await upsertEntry(payload);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err.message || "Invalid payload" });
      }
      return;
    }

    if (pathname.startsWith("/api/entries/") && req.method === "DELETE") {
      if (!isAuthorized(req)) return unauthorized(res);

      const id = decodeURIComponent(pathname.slice("/api/entries/".length));
      const result = await deleteEntry(id);
      if (!result.deleted) {
        sendJson(res, 404, { error: "entry not found" });
      } else {
        sendJson(res, 200, { ok: true, total: result.total });
      }
      return;
    }

    serveStatic(pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Internal Server Error" });
  }
});

server.listen(PORT, () => {
  console.log(`[watchboard] http://localhost:${PORT}`);
  console.log(`[watchboard] storage=${USE_SUPABASE ? "supabase" : "file"}`);
  if (ADMIN_TOKEN === "change-this-admin-token") {
    console.log("[watchboard] WARN: set ADMIN_TOKEN env for production.");
  }
  if (USE_SUPABASE) {
    console.log(`[watchboard] supabase table=${SUPABASE_TABLE}`);
  } else {
    console.log("[watchboard] WARN: SUPABASE_* not set, using local file storage.");
  }
});
