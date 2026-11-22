const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

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
      const response = await fetch(`${baseUrl}/api/settings`);
      if (response.status === 200) return;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not become ready");
}

test("Web Journey: CORS for the extension and deepLinks round-trip", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "filum-journey-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, FILUM_DATA_DIR: dataDir, FILUM_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForServer(baseUrl, child);

    await t.test("preflight from an extension origin is allowed", async () => {
      const res = await fetch(`${baseUrl}/api/threads/some-thread-id`, {
        method: "OPTIONS",
        headers: {
          origin: EXTENSION_ORIGIN,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);
      assert.match(res.headers.get("access-control-allow-methods"), /PUT/);
      assert.match(res.headers.get("access-control-allow-headers"), /Content-Type/i);
    });

    await t.test("ordinary responses echo only extension origins", async () => {
      const fromExtension = await fetch(`${baseUrl}/api/threads`, { headers: { origin: EXTENSION_ORIGIN } });
      assert.equal(fromExtension.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);

      // A website must never be able to read threads through localhost.
      const fromWebsite = await fetch(`${baseUrl}/api/threads`, { headers: { origin: "https://example.com" } });
      assert.equal(fromWebsite.headers.get("access-control-allow-origin"), null);

      const preflightFromWebsite = await fetch(`${baseUrl}/api/threads`, {
        method: "OPTIONS",
        headers: { origin: "https://example.com", "access-control-request-method": "PUT" },
      });
      assert.equal(preflightFromWebsite.headers.get("access-control-allow-origin"), null);
      assert.equal(preflightFromWebsite.headers.get("access-control-allow-methods"), null);
    });

    await t.test("a captured trail survives PUT and GET untouched", async () => {
      const created = await fetch(`${baseUrl}/api/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Research", state: { tasks: [], currentStep: "line", focusIndex: 0 } }),
      }).then((res) => res.json());

      const trail = {
        id: "trail-1",
        label: "Chaos theory deep dive",
        userNote: "The firing patterns section",
        capturedAt: "2026-10-21T09:22:00.000Z",
        anchorIndex: 1,
        nodes: [
          { url: "https://www.google.com/search?q=chaos", title: "chaos - Google Search", type: "search", visitedAt: "2026-10-21T09:18:12.000Z" },
          { url: "https://en.wikipedia.org/wiki/Chaos_theory", title: "Chaos theory", type: "link", snippet: "edge of chaos", ogImageData: "data:image/jpeg;base64,AAAA", visitedAt: "2026-10-21T09:22:00.000Z" },
        ],
      };
      const task = { id: "task-1", title: "Investigate", notes: "✦ web journey — 2 steps from Google: chaos", done: false, deepLinks: [trail] };
      const put = await fetch(`${baseUrl}/api/threads/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ name: created.name, state: { ...created.state, tasks: [task] } }),
      });
      assert.equal(put.status, 200);
      assert.equal(put.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);

      const loaded = await fetch(`${baseUrl}/api/threads/${created.id}`).then((res) => res.json());
      assert.deepEqual(loaded.state.tasks[0].deepLinks, [trail]);
      assert.equal(loaded.state.tasks[0].notes, task.notes);
    });
  } finally {
    child.kill();
    await once(child, "exit").catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
