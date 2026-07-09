#!/usr/bin/env node
/*
 * filum — local thread server.
 * Serves the static PWA and persists each thread as one JSON file under the
 * data directory (default ~/.filum):
 *
 *   threads/<id>.json   active threads
 *   archive/<id>.json   archived threads
 *   bin/<id>.json       binned threads (deleted from the UI, kept until emptied)
 *   settings.json       user preferences
 *
 * Zero dependencies. Node 18+ required.
 */

const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.FILUM_PORT) || 4317;
const DATA_DIR = process.env.FILUM_DATA_DIR || path.join(os.homedir(), ".filum");
// Legacy override: FILUM_THREADS_DIR relocates only the active directory.
const THREADS_DIR =
  process.env.FILUM_THREADS_DIR || path.join(DATA_DIR, "threads");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const BIN_DIR = path.join(DATA_DIR, "bin");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const STATIC_DIR = __dirname;
const SCHEMA_VERSION = 2;
const SETTINGS_SCHEMA_VERSION = 1;

// Scope name -> directory. A thread lives in exactly one of these at a time;
// archive / delete / restore are atomic renames between them.
const SCOPES = {
  active: THREADS_DIR,
  archive: ARCHIVE_DIR,
  bin: BIN_DIR,
};

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

async function ensureDataDirs() {
  for (const dir of Object.values(SCOPES)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

function threadPathIn(scope, id) {
  return path.join(SCOPES[scope], `${id}.json`);
}

function isValidId(id) {
  return /^[a-z0-9-]{8,64}$/i.test(id);
}

// Find which scope a thread currently lives in. Order matters only for the
// pathological case of duplicate ids across scopes; active wins.
async function locateThread(id) {
  for (const scope of Object.keys(SCOPES)) {
    const filePath = threadPathIn(scope, id);
    try {
      await fs.access(filePath);
      return { scope, filePath };
    } catch {
      // keep probing
    }
  }
  return null;
}

async function readThreadAt(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeThreadAt(scope, thread) {
  const filePath = threadPathIn(scope, thread.id);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

async function listThreads(scope) {
  const dir = SCOPES[scope];
  const files = await fs.readdir(dir);
  const items = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      const thread = JSON.parse(raw);
      items.push({
        id: thread.id,
        name: thread.name,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    } catch {
      // skip unreadable or malformed files quietly
    }
  }
  items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return items;
}

// ---- Settings --------------------------------------------------------------

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    noteAliases: ["note"],
    noteColor: "#6f5f80",
  };
}

// Pick known keys only, validate each; return null when the body is unusable.
function sanitizeSettings(body) {
  if (!body || typeof body !== "object") return null;
  const out = defaultSettings();
  if (body.noteAliases !== undefined) {
    if (!Array.isArray(body.noteAliases)) return null;
    const aliases = body.noteAliases
      .filter((a) => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => /^[a-z0-9 _-]{1,24}$/i.test(a));
    if (!aliases.length || aliases.length > 8) return null;
    out.noteAliases = aliases;
  }
  if (body.noteColor !== undefined) {
    if (
      typeof body.noteColor !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(body.noteColor.trim())
    ) {
      return null;
    }
    out.noteColor = body.noteColor.trim().toLowerCase();
  }
  return out;
}

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
  }
}

async function writeSettings(settings) {
  const tmp = SETTINGS_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await fs.rename(tmp, SETTINGS_PATH);
}

// ---- HTTP helpers ----------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      // 8 MB fits a couple of inline image references (data URLs) per task.
      if (total > 8 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function emptyState() {
  return { tasks: [], currentStep: "capture", focusIndex: 0 };
}

function nowIso() {
  return new Date().toISOString();
}

// ---- API -------------------------------------------------------------------

async function handleSettingsApi(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, await readSettings());
  }
  if (req.method === "PUT") {
    const body = await readJsonBody(req);
    const settings = sanitizeSettings(body);
    if (!settings) return sendError(res, 400, "invalid settings");
    await writeSettings(settings);
    return sendJson(res, 200, settings);
  }
  res.writeHead(405, { allow: "GET, PUT" });
  res.end();
}

async function handleBinApi(req, res) {
  if (req.method === "DELETE") {
    const files = await fs.readdir(BIN_DIR);
    let removed = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      await fs.unlink(path.join(BIN_DIR, file));
      removed += 1;
    }
    return sendJson(res, 200, { ok: true, removed });
  }
  res.writeHead(405, { allow: "DELETE" });
  res.end();
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split("/").filter(Boolean); // ["api", resource, maybeId, maybeAction]

  if (segments[1] === "settings" && segments.length === 2) {
    return handleSettingsApi(req, res);
  }
  if (segments[1] === "bin" && segments.length === 2) {
    return handleBinApi(req, res);
  }
  if (segments[1] !== "threads") {
    return sendError(res, 404, "unknown endpoint");
  }

  const id = segments[2];
  const action = segments[3];

  if (!id) {
    if (req.method === "GET") {
      const scope = url.searchParams.get("scope") || "active";
      if (!SCOPES[scope]) return sendError(res, 400, "unknown scope");
      return sendJson(res, 200, await listThreads(scope));
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const thread = {
        id: crypto.randomUUID(),
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : "Untitled thread",
        schemaVersion: SCHEMA_VERSION,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        state:
          body.state && typeof body.state === "object" ? body.state : emptyState(),
      };
      await writeThreadAt("active", thread);
      return sendJson(res, 201, { ...thread, scope: "active" });
    }
    res.writeHead(405, { allow: "GET, POST" });
    return res.end();
  }

  if (!isValidId(id)) {
    return sendError(res, 400, "invalid thread id");
  }

  if (req.method === "POST" && action === "move") {
    const body = await readJsonBody(req);
    const to = body.to;
    if (!SCOPES[to]) return sendError(res, 400, "unknown destination");
    const located = await locateThread(id);
    if (!located) return sendError(res, 404, "thread not found");
    if (located.scope !== to) {
      await fs.rename(located.filePath, threadPathIn(to, id));
    }
    return sendJson(res, 200, { ok: true, scope: to });
  }

  if (action) {
    return sendError(res, 404, "unknown endpoint");
  }

  if (req.method === "GET") {
    const located = await locateThread(id);
    if (!located) return sendError(res, 404, "thread not found");
    const thread = await readThreadAt(located.filePath);
    return sendJson(res, 200, { ...thread, scope: located.scope });
  }

  if (req.method === "PUT") {
    // Strict: never recreate a missing file. A thread deleted on disk stays
    // deleted — the client keeps its in-memory copy and says so quietly.
    const located = await locateThread(id);
    if (!located) return sendError(res, 404, "thread not found");
    if (located.scope === "bin") return sendError(res, 409, "thread is in the bin");
    const body = await readJsonBody(req);
    const existing = await readThreadAt(located.filePath);
    const thread = {
      id,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : existing.name || "Untitled thread",
      schemaVersion: SCHEMA_VERSION,
      createdAt: existing.createdAt || nowIso(),
      updatedAt: nowIso(),
      state:
        body.state && typeof body.state === "object" ? body.state : existing.state || emptyState(),
    };
    await writeThreadAt(located.scope, thread);
    return sendJson(res, 200, { ...thread, scope: located.scope });
  }

  if (req.method === "DELETE") {
    // Permanent delete is only allowed from the bin; the UI's "delete" is a
    // move to the bin via POST :id/move.
    const located = await locateThread(id);
    if (!located) return sendError(res, 404, "thread not found");
    if (located.scope !== "bin") return sendError(res, 409, "move to the bin first");
    await fs.unlink(located.filePath);
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(405, { allow: "GET, PUT, DELETE, POST" });
  res.end();
}

// ---- Static ----------------------------------------------------------------

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(STATIC_DIR, target);
  if (!resolved.startsWith(STATIC_DIR)) return null;
  return resolved;
}

async function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    return res.end();
  }
  const filePath = safeStaticPath(url.pathname);
  if (!filePath) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      const indexPath = path.join(filePath, "index.html");
      return streamFile(res, indexPath);
    }
    return streamFile(res, filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404);
      return res.end("not found");
    }
    throw err;
  }
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache",
  });
  fssync.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await handleStatic(req, res, url);
    }
  } catch (err) {
    console.error("[filum]", err);
    if (!res.headersSent) sendError(res, 500, "internal error");
    else res.end();
  }
});

(async () => {
  try {
    await ensureDataDirs();
  } catch (err) {
    console.error(`[filum] could not create data directories under ${DATA_DIR}`);
    console.error(err.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`[filum] serving on http://localhost:${PORT}`);
    console.log(`[filum] threads at ${THREADS_DIR}`);
    console.log(`[filum] archive/bin/settings at ${DATA_DIR}`);
  });
})();
