// Runs tests/rich-editor.test.html in headless Chrome via the DevTools
// protocol (Node 22's built-in WebSocket; no dependencies). Skips when no
// Chrome is found — set CHROME_PATH to point at one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const CHROME = CANDIDATES.find((candidate) => fs.existsSync(candidate));

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // not ready yet
    }
    await sleep(50);
  }
  throw new Error("timed out");
}

test("rich editor round-trips and maps carets exactly", { skip: !CHROME || typeof WebSocket === "undefined" }, async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "filum-rich-test-"));
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), "filum-rich-chrome-"));
  const port = await availablePort();
  const debugPort = await availablePort();
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, FILUM_DATA_DIR: dataDir, FILUM_PORT: String(port) },
    stdio: "ignore",
  });
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/settings`)).ok);
    const page = await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      return list.find((target) => target.type === "page");
    });
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve));
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const callId = ++id;
        pending.set(callId, resolve);
        ws.send(JSON.stringify({ id: callId, method, params }));
      });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/tests/rich-editor.test.html` });
    const results = await waitFor(async () => {
      const reply = await send("Runtime.evaluate", { expression: "window.__results", returnByValue: true });
      return reply.result?.result?.value;
    });
    ws.close();
    assert.deepEqual(results.failures, [], `${results.fail} failing checks`);
    assert.ok(results.pass > 50, "expected the suite to run");
  } finally {
    chrome.kill();
    server.kill();
    await sleep(200);
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
