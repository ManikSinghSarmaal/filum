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
 *   circumspection.json independent private writing entries
 *
 * Zero dependencies. Node 18+ required.
 */

const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { URL } = require("node:url");
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.FILUM_PORT) || 4317;
const DATA_DIR = process.env.FILUM_DATA_DIR || path.join(os.homedir(), ".filum");
// Legacy override: FILUM_THREADS_DIR relocates only the active directory.
const THREADS_DIR =
  process.env.FILUM_THREADS_DIR || path.join(DATA_DIR, "threads");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const BIN_DIR = path.join(DATA_DIR, "bin");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const CIRCUMSPECTION_PATH = path.join(DATA_DIR, "circumspection.json");
const STATIC_DIR = __dirname;
const SCHEMA_VERSION = 3;
const SETTINGS_SCHEMA_VERSION = 1;
const CIRCUMSPECTION_SCHEMA_VERSION = 1;
const DEFAULT_BODY_LIMIT = 8 * 1024 * 1024;
const CIRCUMSPECTION_BODY_LIMIT = 64 * 1024 * 1024;
const MAX_CIRCUMSPECTION_ENTRIES = 500;
const MAX_CIRCUMSPECTION_CONTENT = 2_000_000;
const MAX_CIRCUMSPECTION_AUDIT = 500;
let gitCommitChain = Promise.resolve();
const GIT_STOP_MESSAGE =
  "Stop Filum thread history — stopped tracking the shadows behind me, as enroute git was scared of seeing my soul";

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

async function writeThreadAt(scope, thread, history = {}) {
  const filePath = threadPathIn(scope, thread.id);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tmp, filePath);
  queueGitCommit(
    history.message || `Update thread ${thread.id}`,
    history.authorDate || thread.createdAt || nowIso()
  );
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

function searchScore(queryTerms, value, weight) {
  const text = String(value || "").toLowerCase();
  if (!text) return 0;
  let score = 0;
  for (const term of queryTerms) {
    const index = text.indexOf(term);
    if (index < 0) continue;
    score += weight + Math.max(0, 20 - index) / 20;
  }
  return score;
}

async function searchThreads(query) {
  const terms = String(query || "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
  if (!terms.length) return [];
  const results = [];
  for (const scope of ["active", "archive"]) {
    const dir = SCOPES[scope];
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const thread = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
        const tasks = Array.isArray(thread.state?.tasks) ? thread.state.tasks : [];
        const matches = [];
        for (const task of tasks) {
          const titleScore = searchScore(terms, task.title, 8);
          const noteScore = searchScore(terms, task.notes, 3);
          if (!titleScore && !noteScore) continue;
          matches.push({
            taskId: task.id,
            title: typeof task.title === "string" ? task.title : "Untitled knot",
            excerpt: String(task.notes || "").replace(/\s+/g, " ").trim().slice(0, 180),
            score: titleScore + noteScore,
          });
        }
        const nameScore = searchScore(terms, thread.name, 10);
        if (!nameScore && !matches.length) continue;
        matches.sort((a, b) => b.score - a.score);
        results.push({
          threadId: thread.id,
          threadName: thread.name || "Untitled thread",
          scope,
          updatedAt: thread.updatedAt,
          score: nameScore + matches.reduce((sum, match) => sum + match.score, 0),
          matches: matches.slice(0, 6),
        });
      } catch {
        // A malformed thread remains untouched and is omitted from search.
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 100);
}

function dataLayoutSupportsGit() {
  const root = path.resolve(DATA_DIR);
  const inside = (target) => {
    const resolved = path.resolve(target);
    return resolved === root || resolved.startsWith(root + path.sep);
  };
  return inside(THREADS_DIR) && inside(ARCHIVE_DIR) && inside(BIN_DIR);
}

async function runGit(args, options = {}) {
  return execFileAsync("git", ["-c", `safe.directory=${path.resolve(DATA_DIR)}`, ...args], {
    cwd: DATA_DIR,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

async function exactGitRoot() {
  try {
    const { stdout } = await runGit(["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function ensureGitIdentity() {
  for (const [key, value] of [
    ["user.name", "Filum"],
    ["user.email", "filum@localhost"],
  ]) {
    try {
      await runGit(["config", "--local", "--get", key]);
    } catch {
      await runGit(["config", "--local", key, value]);
    }
  }
}

async function hasStagedGitChanges() {
  try {
    await runGit(["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

async function hasGitCommits() {
  try {
    await runGit(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function commitGitSnapshot(message, authorDate, allowEmpty = false) {
  await runGit(["add", "-A", "--", ".gitignore", "threads", "archive", "bin"]);
  if (!allowEmpty && !(await hasStagedGitChanges())) return false;
  const originalDate = isIsoTimestamp(authorDate) ? authorDate : nowIso();
  const args = ["commit"];
  if (allowEmpty) args.push("--allow-empty");
  args.push("-m", String(message).slice(0, 240));
  await runGit(args, {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: originalDate,
      GIT_COMMITTER_DATE: allowEmpty ? originalDate : nowIso(),
    },
  });
  return true;
}

async function ensureGitHistory() {
  if (!dataLayoutSupportsGit()) {
    const error = new Error(
      "Git history needs FILUM_THREADS_DIR to remain inside FILUM_DATA_DIR"
    );
    error.code = "FILUM_SPLIT_DATA_LAYOUT";
    throw error;
  }
  await runGit(["--version"]);
  const alreadyInitialized = (await exactGitRoot()) === path.resolve(DATA_DIR);
  if (!alreadyInitialized) {
    await runGit(["init"]);
  }
  await ensureGitIdentity();
  const hadCommits = await hasGitCommits();
  const ignore = [
    "settings.json",
    "circumspection.json",
    "*.tmp",
    "*.bak",
    "*.bak-*",
    "",
  ].join("\n");
  await fs.writeFile(path.join(DATA_DIR, ".gitignore"), ignore, "utf8");
  if (!hadCommits) {
    await runGit(["add", "-A", "--", ".gitignore", "threads", "archive", "bin"]);
  }
  if (!hadCommits && (await hasStagedGitChanges())) {
    const timestamp = nowIso();
    await runGit(["commit", "-m", "Start Filum thread history"], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      },
    });
  }
  return { createdHistory: !hadCommits };
}

async function gitVersioningEnabled() {
  try {
    return (await readSettings()).gitVersioningEnabled === true;
  } catch {
    return false;
  }
}

function queueGitCommit(message, authorDate) {
  gitCommitChain = gitCommitChain
    .then(async () => {
      if (!(await gitVersioningEnabled())) return false;
      await ensureGitHistory();
      return commitGitSnapshot(message, authorDate);
    })
    .catch((error) => {
      console.warn("[filum] thread saved; Git history remained unavailable:", error.message);
      return false;
    });
  return gitCommitChain;
}

async function recordGitStopBoundary() {
  await gitCommitChain;
  await ensureGitHistory();
  const stoppedAt = nowIso();
  return commitGitSnapshot(GIT_STOP_MESSAGE, stoppedAt, true);
}

function originalDateForThreadChange(existing, nextState) {
  const before = new Map(
    (Array.isArray(existing.state?.tasks) ? existing.state.tasks : [])
      .filter((task) => task && typeof task.id === "string")
      .map((task) => [task.id, task])
  );
  const changed = (Array.isArray(nextState?.tasks) ? nextState.tasks : []).filter((task) => {
    if (!task || typeof task.id !== "string") return false;
    return JSON.stringify(before.get(task.id)) !== JSON.stringify(task);
  });
  const dated = changed.find(
    (task) => typeof task.createdAt === "string" && isIsoTimestamp(task.createdAt)
  );
  return dated?.createdAt || existing.createdAt || nowIso();
}

// ---- Settings --------------------------------------------------------------

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    noteAliases: ["note"],
    noteColor: "#6f5f80",
    interfaceContrast: "rich",
    textScale: 1,
    spacing: "calm",
    interfaceMotion: "full",
    keyboardAssistedNavigation: true,
    gitVersioningEnabled: false,
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
  if (body.interfaceContrast !== undefined) {
    if (!["soft", "balanced", "rich"].includes(body.interfaceContrast)) return null;
    out.interfaceContrast = body.interfaceContrast;
  }
  if (body.textScale !== undefined) {
    if (
      typeof body.textScale !== "number" ||
      !Number.isFinite(body.textScale) ||
      body.textScale < 0.9 ||
      body.textScale > 1.2
    ) {
      return null;
    }
    out.textScale = body.textScale;
  }
  if (body.spacing !== undefined) {
    if (!["compact", "calm", "open"].includes(body.spacing)) return null;
    out.spacing = body.spacing;
  }
  if (body.interfaceMotion !== undefined) {
    if (!["full", "quiet", "none"].includes(body.interfaceMotion)) return null;
    out.interfaceMotion = body.interfaceMotion;
  }
  if (body.keyboardAssistedNavigation !== undefined) {
    if (typeof body.keyboardAssistedNavigation !== "boolean") return null;
    out.keyboardAssistedNavigation = body.keyboardAssistedNavigation;
  }
  if (body.gitVersioningEnabled !== undefined) {
    if (typeof body.gitVersioningEnabled !== "boolean") return null;
    out.gitVersioningEnabled = body.gitVersioningEnabled;
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

// ---- Circumspection --------------------------------------------------------

const CIRCUMSPECTION_EVENTS = new Set([
  "DIARY_THRESHOLD_FOCUSED",
  "CATALOGUE_STROKES_REVEALED",
  "CATALOGUE_OPENED",
  "CIRCUMSPECTION_ROUTE_RESOLVED",
  "ENTRY_CREATED",
  "ENTRY_RESUMED",
  "ENTRY_OPENED_FOR_READING",
  "REVISION_ENTERED",
  "REVISION_COMMITTED",
  "REVISION_DISCARDED",
  "INPUT_ACCEPTED",
  "WORD_COMMITTED",
  "WORD_REVEAL_SCHEDULED",
  "WORD_REVEAL_STARTED",
  "WORD_SETTLED",
  "PASTE_ACCEPTED",
  "PASTE_SETTLED_IMMEDIATELY",
  "AUTO_PAGE_BREAK_CREATED",
  "MANUAL_PAGE_BREAK_CREATED",
  "LEAF_DELETE_REQUESTED",
  "LEAF_DELETED",
  "PAGE_TURN_STARTED",
  "PAGE_TURN_COMPLETED",
  "OLDER_LEAF_INPUT_DETECTED",
  "AUTO_FORWARDED_TO_LIVING_PAGE",
  "OUTWARD_REQUESTED",
  "OUTWARD_COMPLETED",
  "SAVE_SUCCEEDED",
  "SAVE_FELL_BACK_OFFLINE",
  "STALE_THREAD_POINTER_RECOVERED",
]);

const CIRCUMSPECTION_MODES = new Set([
  "writing",
  "reading",
  "revision",
  "resume",
  "new-entry",
  "catalogue",
  "living-page",
  "earlier-leaf",
]);

const CIRCUMSPECTION_STATES = new Set([
  "FILUM_OUTER",
  "THRESHOLD_ACTIVE",
  "CATALOGUE_ENTERING",
  "CATALOGUE",
  "INTENT_ROUTING",
  "NEW_ENTRY",
  "RESUME_ENTRY",
  "INNER_ENTERING",
  "LIVING_PAGE",
  "EARLIER_LEAF_READING",
  "AUTO_FORWARD_TO_LIVING_PAGE",
  "REVISION",
  "REVISION_ACTIVE",
  "PAGE_TURNING",
  "OUTWARD_PENDING",
  "LISTENING",
  "COMPOSING",
  "BUFFERING_WORD",
  "WORD_COMMITTED",
  "QUEUED",
  "PRESSURE_VISIBLE",
  "REVEALING",
  "SETTLED",
  "PAGE_ACTIVE",
  "OVERFLOW_PREDICTED",
  "NEXT_PAGE_PREPARED",
  "RAW_INPUT",
  "AUTO_FORWARD",
  "EXPLICIT_REVISE",
  "LEAF_DELETE_PENDING",
  "LEAF_DELETED",
  "SETTLE_CHANGES",
  "DISCARD",
  "REPAGINATE",
  "CLEAN",
  "DIRTY",
  "SAVE_SCHEDULED",
  "SAVING",
  "SAVED",
  "OFFLINE_MIRRORED",
  "SAVE_FAILED",
]);

const LEGACY_CIRCUMSPECTION_STATE_ALIASES = new Map([
  ["writing", "LIVING_PAGE"],
  ["reading", "EARLIER_LEAF_READING"],
  ["revision", "REVISION_ACTIVE"],
  ["catalogue", "CATALOGUE"],
  ["outer", "FILUM_OUTER"],
]);

const AUDIT_METADATA_ENUMS = {
  trigger: new Set(["diary-body", "catalogue-strokes", "catalogue-item", "new-entry", "history"]),
  pasteMode: new Set(["settle-immediately", "whisper-quickly", "whisper-normal"]),
  pageMotion: new Set(["full", "reduced", "none"]),
  pointerStatus: new Set(["valid", "missing", "recovered", "none"]),
  inputType: new Set([
    "insertText",
    "insertCompositionText",
    "insertFromComposition",
    "insertFromPaste",
    "insertLineBreak",
    "insertParagraph",
    "deleteContentBackward",
    "deleteContentForward",
    "historyUndo",
    "historyRedo",
  ]),
};

const AUDIT_METADATA_BOOLEANS = new Set([
  "fallbackUsed",
  "automatic",
  "largePaste",
  "recovered",
]);

const AUDIT_METADATA_NUMBERS = new Set([
  "durationMs",
  "pendingCount",
  "wordCount",
  "pageCount",
  "breakOffset",
  "queueDepth",
  "inputLength",
]);

class CircumspectionValidationError extends Error {}

function invalidCircumspection(message) {
  throw new CircumspectionValidationError(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidCircumspection(`${label} contains unknown field ${key}`);
  }
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalidCircumspection(`${label} is out of range`);
  }
  return value;
}

function requireNumber(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) {
    invalidCircumspection(`${label} is out of range`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!isIsoTimestamp(value)) invalidCircumspection(`${label} is not an ISO timestamp`);
  return value;
}

function requireNullableId(value, label) {
  if (value !== null && (typeof value !== "string" || !isValidId(value))) {
    invalidCircumspection(`${label} is not a valid id`);
  }
  return value;
}

function defaultCircumspectionStore() {
  return {
    schemaVersion: CIRCUMSPECTION_SCHEMA_VERSION,
    settings: {
      baseLagMs: 0,
      wordStaggerMs: 0,
      revealDurationMs: 60,
      blurPx: 1,
      spreadRadiusPx: 28,
      pasteMode: "settle-immediately",
      pageMotion: "full",
      inkEffect: "none",
      revisionMarker: "subtle",
      outwardPolicy: "fast-settle",
      liveInkOpacity: 0.7,
      writingSizePx: 19,
      writingMeasureCh: 74,
      writingMeasureVersion: 2,
      diaryLayout: "simple-musky",
    },
    activeEntryId: null,
    entries: [],
    audit: [],
  };
}

function validateCircumspectionSettings(raw) {
  if (!isPlainObject(raw)) invalidCircumspection("settings must be an object");
  rejectUnknownKeys(
    raw,
    new Set([
      "baseLagMs",
      "wordStaggerMs",
      "revealDurationMs",
      "blurPx",
      "spreadRadiusPx",
      "pasteMode",
      "pageMotion",
      "inkEffect",
      "revisionMarker",
      "outwardPolicy",
      "liveInkOpacity",
      "writingSizePx",
      "writingMeasureCh",
      "writingMeasureVersion",
      "diaryLayout",
    ]),
    "settings"
  );
  const settings = { ...defaultCircumspectionStore().settings, ...raw };
  if (!["settle-immediately", "whisper-quickly", "whisper-normal"].includes(settings.pasteMode)) {
    invalidCircumspection("settings.pasteMode is invalid");
  }
  if (!["full", "reduced", "none"].includes(settings.pageMotion)) {
    invalidCircumspection("settings.pageMotion is invalid");
  }
  if (settings.inkEffect !== "none") {
    invalidCircumspection("settings.inkEffect is invalid");
  }
  if (!["visible", "subtle", "none"].includes(settings.revisionMarker)) {
    invalidCircumspection("settings.revisionMarker is invalid");
  }
  if (!["fast-settle", "preserve", "settle-offscreen"].includes(settings.outwardPolicy)) {
    invalidCircumspection("settings.outwardPolicy is invalid");
  }
  const diaryLayout =
    raw.diaryLayout === undefined
      ? requireNumber(settings.writingMeasureCh, 48, 96, "settings.writingMeasureCh") >= 84
        ? "wider-musky"
        : "simple-musky"
      : raw.diaryLayout;
  if (!["simple-musky", "wider-musky"].includes(diaryLayout)) {
    invalidCircumspection("settings.diaryLayout is invalid");
  }
  return {
    baseLagMs: requireNumber(settings.baseLagMs, 0, 1200, "settings.baseLagMs"),
    wordStaggerMs: requireNumber(settings.wordStaggerMs, 0, 260, "settings.wordStaggerMs"),
    revealDurationMs: requireNumber(settings.revealDurationMs, 40, 1800, "settings.revealDurationMs"),
    blurPx: requireNumber(settings.blurPx, 0, 14, "settings.blurPx"),
    spreadRadiusPx: requireNumber(settings.spreadRadiusPx, 0, 72, "settings.spreadRadiusPx"),
    pasteMode: settings.pasteMode,
    pageMotion: settings.pageMotion,
    inkEffect: settings.inkEffect,
    revisionMarker: settings.revisionMarker,
    outwardPolicy: settings.outwardPolicy,
    liveInkOpacity: requireNumber(settings.liveInkOpacity, 0.35, 1, "settings.liveInkOpacity"),
    writingSizePx: requireNumber(settings.writingSizePx, 16, 24, "settings.writingSizePx"),
    writingMeasureCh: requireNumber(settings.writingMeasureCh, 48, 96, "settings.writingMeasureCh"),
    writingMeasureVersion:
      raw.writingMeasureVersion === undefined
        ? 1
        : requireInteger(settings.writingMeasureVersion, 1, 2, "settings.writingMeasureVersion"),
    diaryLayout,
  };
}

function validateCircumspectionEntry(raw, ids, index) {
  const label = `entries[${index}]`;
  if (!isPlainObject(raw)) invalidCircumspection(`${label} must be an object`);
  rejectUnknownKeys(
    raw,
    new Set([
      "id",
      "createdAt",
      "updatedAt",
      "content",
      "settledUntil",
      "manualPageBreaks",
      "lastMeaningfulAnchor",
      "lastViewedAnchor",
      "status",
      "origin",
      "revision",
    ]),
    label
  );
  if (typeof raw.id !== "string" || !isValidId(raw.id)) {
    invalidCircumspection(`${label}.id is invalid`);
  }
  if (ids.has(raw.id)) invalidCircumspection(`duplicate entry id ${raw.id}`);
  ids.add(raw.id);
  if (typeof raw.content !== "string") invalidCircumspection(`${label}.content must be text`);
  if (raw.content.length > MAX_CIRCUMSPECTION_CONTENT) {
    invalidCircumspection(`${label}.content exceeds the entry limit`);
  }
  const contentLength = raw.content.length;
  if (!Array.isArray(raw.manualPageBreaks) || raw.manualPageBreaks.length > 10_000) {
    invalidCircumspection(`${label}.manualPageBreaks is invalid`);
  }
  let previousBreak = -1;
  const manualPageBreaks = raw.manualPageBreaks.map((offset, breakIndex) => {
    requireInteger(offset, 0, contentLength, `${label}.manualPageBreaks[${breakIndex}]`);
    if (offset <= previousBreak) {
      invalidCircumspection(`${label}.manualPageBreaks must be unique and ascending`);
    }
    previousBreak = offset;
    return offset;
  });
  if (!["active", "archived", "binned"].includes(raw.status)) {
    invalidCircumspection(`${label}.status is invalid`);
  }
  if (!isPlainObject(raw.origin)) invalidCircumspection(`${label}.origin must be an object`);
  rejectUnknownKeys(raw.origin, new Set(["threadId", "threadNameSnapshot", "surface"]), `${label}.origin`);
  const originThreadId = requireNullableId(raw.origin.threadId, `${label}.origin.threadId`);
  if (
    raw.origin.threadNameSnapshot !== null &&
    (typeof raw.origin.threadNameSnapshot !== "string" || raw.origin.threadNameSnapshot.length > 80)
  ) {
    invalidCircumspection(`${label}.origin.threadNameSnapshot is invalid`);
  }
  if (raw.origin.surface !== "filum") invalidCircumspection(`${label}.origin.surface is invalid`);
  if (!isPlainObject(raw.revision)) invalidCircumspection(`${label}.revision must be an object`);
  rejectUnknownKeys(raw.revision, new Set(["lastRevisedAt"]), `${label}.revision`);
  if (raw.revision.lastRevisedAt !== null) {
    requireTimestamp(raw.revision.lastRevisedAt, `${label}.revision.lastRevisedAt`);
  }
  return {
    id: raw.id,
    createdAt: requireTimestamp(raw.createdAt, `${label}.createdAt`),
    updatedAt: requireTimestamp(raw.updatedAt, `${label}.updatedAt`),
    content: raw.content,
    settledUntil: requireInteger(raw.settledUntil, 0, contentLength, `${label}.settledUntil`),
    manualPageBreaks,
    lastMeaningfulAnchor: requireInteger(
      raw.lastMeaningfulAnchor,
      0,
      contentLength,
      `${label}.lastMeaningfulAnchor`
    ),
    lastViewedAnchor: requireInteger(raw.lastViewedAnchor, 0, contentLength, `${label}.lastViewedAnchor`),
    status: raw.status,
    origin: {
      threadId: originThreadId,
      threadNameSnapshot: raw.origin.threadNameSnapshot,
      surface: "filum",
    },
    revision: { lastRevisedAt: raw.revision.lastRevisedAt },
  };
}

function validateAuditMetadata(raw, label) {
  if (!isPlainObject(raw)) invalidCircumspection(`${label}.metadata must be an object`);
  const metadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (AUDIT_METADATA_BOOLEANS.has(key)) {
      if (typeof value !== "boolean") invalidCircumspection(`${label}.metadata.${key} is invalid`);
      metadata[key] = value;
    } else if (AUDIT_METADATA_NUMBERS.has(key)) {
      metadata[key] = requireInteger(value, 0, Number.MAX_SAFE_INTEGER, `${label}.metadata.${key}`);
    } else if (AUDIT_METADATA_ENUMS[key]) {
      if (!AUDIT_METADATA_ENUMS[key].has(value)) {
        invalidCircumspection(`${label}.metadata.${key} is invalid`);
      }
      metadata[key] = value;
    }
    // Unknown metadata is deliberately discarded. Audit metadata is a strict
    // allowlist so private writing can never be persisted here accidentally.
  }
  return metadata;
}

function validateNullableAuditEnum(value, allowed, label) {
  if (value !== null && !allowed.has(value)) invalidCircumspection(`${label} is invalid`);
  return value;
}

function validateNullableAuditState(value, label) {
  if (value === null) return null;
  const normalized = LEGACY_CIRCUMSPECTION_STATE_ALIASES.get(value) || value;
  if (!CIRCUMSPECTION_STATES.has(normalized)) invalidCircumspection(`${label} is invalid`);
  return normalized;
}

function validateNullableAuditInteger(value, label) {
  if (value === null) return null;
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function validateCircumspectionAuditEvent(raw, ids, index) {
  const label = `audit[${index}]`;
  if (!isPlainObject(raw)) invalidCircumspection(`${label} must be an object`);
  if (typeof raw.id !== "string" || !isValidId(raw.id)) invalidCircumspection(`${label}.id is invalid`);
  if (ids.has(raw.id)) invalidCircumspection(`duplicate audit id ${raw.id}`);
  ids.add(raw.id);
  if (!CIRCUMSPECTION_EVENTS.has(raw.event)) invalidCircumspection(`${label}.event is invalid`);
  const ruleId = raw.ruleId;
  if (ruleId !== null && (typeof ruleId !== "string" || !/^R\d{1,2}$/.test(ruleId))) {
    invalidCircumspection(`${label}.ruleId is invalid`);
  }
  return {
    id: raw.id,
    event: raw.event,
    entryId: requireNullableId(raw.entryId, `${label}.entryId`),
    threadId: requireNullableId(raw.threadId, `${label}.threadId`),
    mode: validateNullableAuditEnum(raw.mode, CIRCUMSPECTION_MODES, `${label}.mode`),
    sourceState: validateNullableAuditState(raw.sourceState, `${label}.sourceState`),
    destinationState: validateNullableAuditState(raw.destinationState, `${label}.destinationState`),
    ruleId,
    contentLength: validateNullableAuditInteger(raw.contentLength, `${label}.contentLength`),
    settledUntil: validateNullableAuditInteger(raw.settledUntil, `${label}.settledUntil`),
    pageIndex: validateNullableAuditInteger(raw.pageIndex, `${label}.pageIndex`),
    metadata: validateAuditMetadata(raw.metadata, label),
    occurredAt: requireTimestamp(raw.occurredAt, `${label}.occurredAt`),
  };
}

function validateCircumspectionStore(raw) {
  if (!isPlainObject(raw)) invalidCircumspection("store must be an object");
  rejectUnknownKeys(raw, new Set(["schemaVersion", "settings", "activeEntryId", "entries", "audit"]), "store");
  if (raw.schemaVersion !== CIRCUMSPECTION_SCHEMA_VERSION) {
    invalidCircumspection("unsupported circumspection schema");
  }
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_CIRCUMSPECTION_ENTRIES) {
    invalidCircumspection("entries exceeds the store limit");
  }
  if (!Array.isArray(raw.audit) || raw.audit.length > 5_000) {
    invalidCircumspection("audit exceeds the accepted input limit");
  }
  const ids = new Set();
  const entries = raw.entries.map((entry, index) => validateCircumspectionEntry(entry, ids, index));
  const activeEntryId = requireNullableId(raw.activeEntryId, "activeEntryId");
  if (activeEntryId !== null && !ids.has(activeEntryId)) {
    invalidCircumspection("activeEntryId does not reference an entry");
  }
  if (
    activeEntryId !== null &&
    !entries.some((entry) => entry.id === activeEntryId && entry.status !== "binned")
  ) {
    invalidCircumspection("activeEntryId cannot reference a binned entry");
  }
  // Audit is intentionally a rolling debugging window. Dropping the oldest
  // records is the only lossy normalisation performed by this endpoint.
  const auditIds = new Set();
  const validatedAudit = raw.audit.map((event, index) =>
    validateCircumspectionAuditEvent(event, auditIds, index)
  );
  const audit = validatedAudit.slice(-MAX_CIRCUMSPECTION_AUDIT);
  return {
    schemaVersion: CIRCUMSPECTION_SCHEMA_VERSION,
    settings: validateCircumspectionSettings(raw.settings),
    activeEntryId,
    entries,
    audit,
  };
}

async function readCircumspectionStore() {
  try {
    const raw = await fs.readFile(CIRCUMSPECTION_PATH, "utf8");
    return validateCircumspectionStore(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultCircumspectionStore();
    // A corrupt or unsupported file is never converted into an empty store.
    // Surface the error and leave the original bytes untouched for recovery.
    throw err;
  }
}

async function writeCircumspectionStore(store) {
  const tmp = `${CIRCUMSPECTION_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, CIRCUMSPECTION_PATH);
  } finally {
    await fs.unlink(tmp).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
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

class RequestBodyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readJsonBody(req, maxBytes = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new RequestBodyError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new RequestBodyError(400, "invalid JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function emptyState() {
  return {
    tasks: [],
    currentStep: "capture",
    focusIndex: 0,
    circumspectionContext: {
      lastEntryId: null,
      lastVisitedAt: null,
      lastMeaningfulCircumspectionAction: null,
      lastCircumspectionMode: null,
    },
    navigationContext: {
      lastMeaningfulSurface: null,
      lastMeaningfulAction: null,
      updatedAt: null,
    },
  };
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

async function handleVersionControlApi(req, res) {
  if (req.method === "GET") {
    const settings = await readSettings();
    let available = dataLayoutSupportsGit();
    let initialized = false;
    let reason = null;
    if (available) {
      try {
        await runGit(["--version"]);
        initialized = (await exactGitRoot()) === path.resolve(DATA_DIR);
      } catch (error) {
        available = false;
        reason = error.code === "ENOENT" ? "Git is not installed" : error.message;
      }
    } else {
      reason = "Active threads are stored outside FILUM_DATA_DIR";
    }
    return sendJson(res, 200, {
      enabled: settings.gitVersioningEnabled === true,
      available,
      initialized,
      reason,
    });
  }
  if (req.method === "PUT") {
    const body = await readJsonBody(req);
    if (!body || typeof body.enabled !== "boolean") {
      return sendError(res, 400, "enabled must be boolean");
    }
    const settings = await readSettings();
    let stopRecorded = null;
    let reason = null;
    if (body.enabled) {
      try {
        const { createdHistory } = await ensureGitHistory();
        if (settings.gitVersioningEnabled !== true && !createdHistory) {
          await commitGitSnapshot("Resume Filum thread history", nowIso(), true);
        }
      } catch (error) {
        return sendJson(res, 424, {
          error:
            error.code === "ENOENT"
              ? "Git is not installed"
              : error.code === "FILUM_SPLIT_DATA_LAYOUT"
                ? "Git history needs one FILUM_DATA_DIR"
                : "Git history could not be initialized",
        });
      }
    } else if (settings.gitVersioningEnabled === true) {
      try {
        stopRecorded = await recordGitStopBoundary();
      } catch (error) {
        stopRecorded = false;
        reason = "Tracking was stopped, but its final Git marker could not be committed";
        console.warn("[filum] Git tracking stopped without its final marker:", error.message);
      }
    }
    const saved = sanitizeSettings({ ...settings, gitVersioningEnabled: body.enabled });
    if (!saved) return sendError(res, 400, "invalid settings");
    await writeSettings(saved);
    return sendJson(res, 200, {
      enabled: saved.gitVersioningEnabled,
      available: true,
      initialized: body.enabled ? true : (await exactGitRoot()) === path.resolve(DATA_DIR),
      stopRecorded,
      reason,
    });
  }
  res.writeHead(405, { allow: "GET, PUT" });
  res.end();
}

async function handleCircumspectionApi(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, await readCircumspectionStore());
  }
  if (req.method === "PUT") {
    const body = await readJsonBody(req, CIRCUMSPECTION_BODY_LIMIT);
    let store;
    try {
      store = validateCircumspectionStore(body);
    } catch (err) {
      if (err instanceof CircumspectionValidationError) {
        return sendError(res, 400, err.message);
      }
      throw err;
    }
    await writeCircumspectionStore(store);
    return sendJson(res, 200, store);
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
    if (removed) queueGitCommit("Empty the Filum thread bin", nowIso());
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
  if (segments[1] === "version-control" && segments.length === 2) {
    return handleVersionControlApi(req, res);
  }
  if (segments[1] === "search" && segments.length === 2) {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" });
      return res.end();
    }
    return sendJson(res, 200, await searchThreads(url.searchParams.get("q") || ""));
  }
  if (segments[1] === "circumspection" && segments.length === 2) {
    return handleCircumspectionApi(req, res);
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
      await writeThreadAt("active", thread, {
        message: `Create thread ${thread.id}`,
        authorDate: thread.createdAt,
      });
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
      const thread = await readThreadAt(located.filePath);
      await fs.rename(located.filePath, threadPathIn(to, id));
      queueGitCommit(`Move thread ${id} to ${to}`, thread.createdAt || nowIso());
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
    await writeThreadAt(located.scope, thread, {
      message: `Update thread ${id}`,
      authorDate: originalDateForThreadChange(existing, thread.state),
    });
    return sendJson(res, 200, { ...thread, scope: located.scope });
  }

  if (req.method === "DELETE") {
    // Permanent delete is only allowed from the bin; the UI's "delete" is a
    // move to the bin via POST :id/move.
    const located = await locateThread(id);
    if (!located) return sendError(res, 404, "thread not found");
    if (located.scope !== "bin") return sendError(res, 409, "move to the bin first");
    const thread = await readThreadAt(located.filePath);
    await fs.unlink(located.filePath);
    queueGitCommit(`Remove thread ${id} from the bin`, thread.createdAt || nowIso());
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
    if (err instanceof RequestBodyError) {
      if (!res.headersSent) sendError(res, err.statusCode, err.message);
      else res.end();
      return;
    }
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
    console.log(`[filum] archive/bin/settings/circumspection at ${DATA_DIR}`);
  });
})();
