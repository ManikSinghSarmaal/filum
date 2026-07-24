const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

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

async function requestPath(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

function request(baseUrl, options = {}) {
  return requestPath(baseUrl, "/api/settings", options);
}

function put(body) {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await request(baseUrl);
      if (response.status === 200) return;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not become ready");
}

test("general settings API", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "filum-settings-test-"));
  const settingsPath = path.join(dataDir, "settings.json");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, FILUM_DATA_DIR: dataDir, FILUM_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, child);

    async function resetSettings() {
      await fs.rm(settingsPath, { force: true });
    }

    await t.test("GET returns the complete defaults", async () => {
      await resetSettings();
      const result = await request(baseUrl);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        schemaVersion: 1,
        noteAliases: ["note"],
        noteColor: "#6f5f80",
        interfaceContrast: "rich",
        textScale: 1,
        spacing: "calm",
        interfaceMotion: "full",
        keyboardAssistedNavigation: true,
        gitVersioningEnabled: false,
      });
    });

    await t.test("GET supplies new defaults for a legacy settings file", async () => {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({
          schemaVersion: 1,
          noteAliases: ["memo"],
          noteColor: "#123456",
        }),
        "utf8"
      );
      const result = await request(baseUrl);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        schemaVersion: 1,
        noteAliases: ["memo"],
        noteColor: "#123456",
        interfaceContrast: "rich",
        textScale: 1,
        spacing: "calm",
        interfaceMotion: "full",
        keyboardAssistedNavigation: true,
        gitVersioningEnabled: false,
      });
    });

    await t.test("PUT validates and round-trips every setting", async () => {
      await resetSettings();
      const desired = {
        schemaVersion: 1,
        noteAliases: ["memo", "later"],
        noteColor: "#756080",
        interfaceContrast: "balanced",
        textScale: 1.2,
        spacing: "open",
        interfaceMotion: "quiet",
        keyboardAssistedNavigation: false,
        gitVersioningEnabled: true,
      };
      const saved = await request(baseUrl, put(desired));
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body, desired);
      assert.deepEqual((await request(baseUrl)).body, desired);
    });

    await t.test("Git tracking can start and stop with a dated boundary commit", async () => {
      const valid = {
        schemaVersion: 1,
        noteAliases: ["note"],
        noteColor: "#6f5f80",
        interfaceContrast: "rich",
        textScale: 1,
        spacing: "calm",
        interfaceMotion: "full",
        keyboardAssistedNavigation: true,
        gitVersioningEnabled: false,
      };
      assert.equal((await request(baseUrl, put(valid))).status, 200);

      const enabled = await requestPath(
        baseUrl,
        "/api/version-control",
        put({ enabled: true })
      );
      assert.equal(enabled.status, 200);
      assert.equal(enabled.body.enabled, true);

      const stopped = await requestPath(
        baseUrl,
        "/api/version-control",
        put({ enabled: false })
      );
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.enabled, false);
      assert.equal(stopped.body.stopRecorded, true);
      assert.equal((await request(baseUrl)).body.gitVersioningEnabled, false);

      const resumed = await requestPath(
        baseUrl,
        "/api/version-control",
        put({ enabled: true })
      );
      assert.equal(resumed.status, 200);
      const stoppedAgain = await requestPath(
        baseUrl,
        "/api/version-control",
        put({ enabled: false })
      );
      assert.equal(stoppedAgain.status, 200);
      assert.equal(stoppedAgain.body.stopRecorded, true);

      const { stdout } = await execFileAsync(
        "git",
        [
          "-c",
          `safe.directory=${dataDir}`,
          "-C",
          dataDir,
          "log",
          "-1",
          "--format=%s%n%aI%n%cI",
        ]
      );
      const [subject, authorDate, committerDate] = stdout.trim().split("\n");
      assert.match(
        subject,
        /stopped tracking the shadows behind me, as enroute git was scared of seeing my soul$/
      );
      assert.equal(authorDate, committerDate);
      const { stdout: boundarySubjects } = await execFileAsync(
        "git",
        [
          "-c",
          `safe.directory=${dataDir}`,
          "-C",
          dataDir,
          "log",
          "-2",
          "--format=%s",
        ]
      );
      assert.match(boundarySubjects, /Resume Filum thread history/);
    });

    await t.test("invalid values are rejected without changing the prior file", async () => {
      const valid = {
        schemaVersion: 1,
        noteAliases: ["note"],
        noteColor: "#6f5f80",
        interfaceContrast: "rich",
        textScale: 1,
        spacing: "calm",
        interfaceMotion: "full",
        keyboardAssistedNavigation: true,
        gitVersioningEnabled: false,
      };
      assert.equal((await request(baseUrl, put(valid))).status, 200);
      const before = await fs.readFile(settingsPath, "utf8");
      const invalidVariants = [
        { ...valid, interfaceContrast: "loud" },
        { ...valid, interfaceContrast: "high" },
        { ...valid, textScale: 0.89 },
        { ...valid, textScale: 1.21 },
        { ...valid, textScale: "1" },
        { ...valid, spacing: "crowded" },
        { ...valid, spacing: "spacious" },
        { ...valid, interfaceMotion: "reduced" },
        { ...valid, interfaceMotion: "spinning" },
        { ...valid, keyboardAssistedNavigation: "yes" },
        { ...valid, gitVersioningEnabled: 1 },
      ];
      for (const invalid of invalidVariants) {
        const result = await request(baseUrl, put(invalid));
        assert.equal(result.status, 400);
        assert.deepEqual(result.body, { error: "invalid settings" });
        assert.equal(await fs.readFile(settingsPath, "utf8"), before);
      }
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
