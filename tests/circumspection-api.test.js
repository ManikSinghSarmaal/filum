const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const ROOT = path.resolve(__dirname, "..");
const FIXED_TIME = "2026-07-12T00:00:00.000Z";

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/circumspection`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not become ready");
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const raw = await response.text();
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: response.status, body, raw };
}

function jsonRequest(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function makeEntry(overrides = {}) {
  const content = overrides.content ?? "A thought that is still arriving.";
  return {
    id: "entry-0001",
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    content,
    settledUntil: Math.min(9, content.length),
    manualPageBreaks: [],
    lastMeaningfulAnchor: content.length,
    lastViewedAnchor: content.length,
    status: "active",
    origin: {
      threadId: null,
      threadNameSnapshot: null,
      surface: "filum",
    },
    revision: { lastRevisedAt: null },
    ...overrides,
  };
}

function makeAuditEvent(index, metadata = {}) {
  return {
    id: `audit-${String(index).padStart(4, "0")}`,
    event: "INPUT_ACCEPTED",
    entryId: null,
    threadId: null,
    mode: "writing",
    sourceState: "LISTENING",
    destinationState: "COMPOSING",
    ruleId: null,
    contentLength: 0,
    settledUntil: 0,
    pageIndex: 0,
    metadata,
    occurredAt: FIXED_TIME,
  };
}

test("Circumspection persistence API", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "filum-circumspection-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FILUM_DATA_DIR: dataDir,
      FILUM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, child);
    const storePath = path.join(dataDir, "circumspection.json");

    async function resetStore() {
      await fs.rm(storePath, { force: true });
    }

    async function defaultStore() {
      const result = await request(baseUrl, "/api/circumspection");
      assert.equal(result.status, 200);
      return result.body;
    }

    await t.test("GET returns the schema-v1 v1.1 defaults", async () => {
      await resetStore();
      const store = await defaultStore();
      assert.deepEqual(store, {
        schemaVersion: 1,
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
          writingMeasureCh: 62,
        },
        activeEntryId: null,
        entries: [],
        audit: [],
      });
      await assert.rejects(fs.access(storePath), { code: "ENOENT" });
    });

    await t.test("PUT round-trips canonical content that is still visually pending", async () => {
      await resetStore();
      const store = await defaultStore();
      const entry = makeEntry();
      assert.ok(entry.settledUntil < entry.content.length);
      store.activeEntryId = entry.id;
      store.entries.push(entry);

      const saved = await request(baseUrl, "/api/circumspection", jsonRequest("PUT", store));
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body, store);

      const restored = await request(baseUrl, "/api/circumspection");
      assert.equal(restored.status, 200);
      assert.deepEqual(restored.body, store);
      assert.equal(restored.body.entries[0].content, entry.content);
      assert.equal(restored.body.entries[0].settledUntil, entry.settledUntil);
    });

    await t.test("malformed and oversize PUTs leave the prior file byte-for-byte intact", async () => {
      await resetStore();
      const store = await defaultStore();
      const entry = makeEntry();
      store.activeEntryId = entry.id;
      store.entries.push(entry);
      const seeded = await request(baseUrl, "/api/circumspection", jsonRequest("PUT", store));
      assert.equal(seeded.status, 200);
      const before = await fs.readFile(storePath, "utf8");

      const invalidJson = await request(baseUrl, "/api/circumspection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"schemaVersion":1,"entries":',
      });
      assert.equal(invalidJson.status, 400);

      const malformed = structuredClone(store);
      malformed.entries[0].content = 42;
      const malformedResult = await request(
        baseUrl,
        "/api/circumspection",
        jsonRequest("PUT", malformed)
      );
      assert.equal(malformedResult.status, 400);

      const oversize = structuredClone(store);
      oversize.entries[0] = makeEntry({ content: "x".repeat(2_000_001) });
      const oversizeResult = await request(
        baseUrl,
        "/api/circumspection",
        jsonRequest("PUT", oversize)
      );
      assert.equal(oversizeResult.status, 400);

      assert.equal(await fs.readFile(storePath, "utf8"), before);
      const restored = await request(baseUrl, "/api/circumspection");
      assert.deepEqual(restored.body, store);
    });

    await t.test("duplicate entry IDs are rejected without replacing the store", async () => {
      await resetStore();
      const store = await defaultStore();
      const first = makeEntry();
      store.activeEntryId = first.id;
      store.entries = [first];
      assert.equal(
        (await request(baseUrl, "/api/circumspection", jsonRequest("PUT", store))).status,
        200
      );
      const before = await fs.readFile(storePath, "utf8");

      const duplicate = structuredClone(store);
      duplicate.entries.push(makeEntry({ content: "A different entry with the same id." }));
      const result = await request(
        baseUrl,
        "/api/circumspection",
        jsonRequest("PUT", duplicate)
      );
      assert.equal(result.status, 400);
      assert.match(result.body.error, /duplicate entry id/i);
      assert.equal(await fs.readFile(storePath, "utf8"), before);

      const invalidId = structuredClone(store);
      invalidId.entries[0].id = "bad";
      invalidId.activeEntryId = "bad";
      const invalidIdResult = await request(
        baseUrl,
        "/api/circumspection",
        jsonRequest("PUT", invalidId)
      );
      assert.equal(invalidIdResult.status, 400);
      assert.match(invalidIdResult.body.error, /id is invalid/i);
      assert.equal(await fs.readFile(storePath, "utf8"), before);
    });

    await t.test("audit is bounded and persists allowlisted diagnostics only", async () => {
      await resetStore();
      const store = await defaultStore();
      store.audit = Array.from({ length: 505 }, (_, index) => ({
        ...makeAuditEvent(index, {
          fallbackUsed: false,
          inputLength: index,
          trigger: "diary-body",
          text: "never persist this private sentence",
          excerpt: "nor this private excerpt",
        }),
        privateText: "private writing must not enter audit",
      }));
      const result = await request(baseUrl, "/api/circumspection", jsonRequest("PUT", store));
      assert.equal(result.status, 200);
      assert.equal(result.body.audit.length, 500);
      assert.equal(result.body.audit[0].id, "audit-0005");
      assert.deepEqual(result.body.audit[0].metadata, {
        fallbackUsed: false,
        inputLength: 5,
        trigger: "diary-body",
      });
      const persisted = await fs.readFile(storePath, "utf8");
      assert.doesNotMatch(persisted, /never persist|private writing|private excerpt/);
      assert.equal(Object.hasOwn(result.body.audit[0], "privateText"), false);
    });

    await t.test("deleting an origin thread does not delete its independent entry", async () => {
      await resetStore();
      const created = await request(
        baseUrl,
        "/api/threads",
        jsonRequest("POST", { name: "Temporary outer thread" })
      );
      assert.equal(created.status, 201);
      assert.equal(created.body.schemaVersion, 3);
      assert.deepEqual(created.body.state.circumspectionContext, {
        lastEntryId: null,
        lastVisitedAt: null,
        lastMeaningfulCircumspectionAction: null,
        lastCircumspectionMode: null,
      });
      assert.deepEqual(created.body.state.navigationContext, {
        lastMeaningfulSurface: null,
        lastMeaningfulAction: null,
        updatedAt: null,
      });

      const store = await defaultStore();
      const entry = makeEntry({
        origin: {
          threadId: created.body.id,
          threadNameSnapshot: "Temporary outer thread",
          surface: "filum",
        },
      });
      store.activeEntryId = entry.id;
      store.entries.push(entry);
      assert.equal(
        (await request(baseUrl, "/api/circumspection", jsonRequest("PUT", store))).status,
        200
      );

      const moved = await request(
        baseUrl,
        `/api/threads/${created.body.id}/move`,
        jsonRequest("POST", { to: "bin" })
      );
      assert.equal(moved.status, 200);
      const removed = await request(baseUrl, `/api/threads/${created.body.id}`, { method: "DELETE" });
      assert.equal(removed.status, 200);

      const restored = await request(baseUrl, "/api/circumspection");
      assert.equal(restored.status, 200);
      assert.equal(restored.body.entries.length, 1);
      assert.equal(restored.body.entries[0].id, entry.id);
      assert.equal(restored.body.entries[0].origin.threadId, created.body.id);
    });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await fs.rm(dataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
      throw new Error(`server failed with ${child.exitCode}: ${stderr}`);
    }
  }
});
