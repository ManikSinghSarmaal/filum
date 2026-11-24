// Filum — Web Journey popup. Reads the trail for this tab, lets the user pick
// a thread and task, and hands the capture to the service worker, which owns
// every write to Filum. See engineering.md → "Web Journey".

import {
  DEFAULT_SERVER,
  api,
  crossReference,
  displayTitle,
  extractPageContext,
  getServerUrl,
  isCapturableUrl,
  normalizeServerUrl,
  truncate,
  withContext,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const el = {
  status: $("status"),
  statusText: $("statusText"),
  trailHeading: $("trailHeading"),
  trailList: $("trailList"),
  trailThread: $("trailThread"),
  following: $("following"),
  form: $("captureForm"),
  threadSelect: $("threadSelect"),
  newTaskTitle: $("newTaskTitle"),
  taskSelect: $("taskSelect"),
  userNote: $("userNote"),
  captureButton: $("captureButton"),
  message: $("message"),
  serverToggle: $("serverToggle"),
  serverLabel: $("serverLabel"),
  serverForm: $("serverForm"),
  serverInput: $("serverInput"),
  serverHint: $("serverHint"),
};

const view = {
  server: DEFAULT_SERVER,
  tab: null,
  nodes: [],
  connected: false,
  threads: [],
  thread: null,
  busy: false,
};

// ---- Status -----------------------------------------------------------------

function setStatus(state, text) {
  el.status.dataset.state = state;
  el.statusText.textContent = text;
}

function say(text) {
  el.message.textContent = text || "";
}

function modeValue() {
  const checked = el.form.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "new";
}

function updateCaptureEnabled() {
  const mode = modeValue();
  const ready =
    !view.busy &&
    view.connected &&
    view.nodes.length > 0 &&
    !!view.thread &&
    (mode === "new" ? el.newTaskTitle.value.trim().length > 0 : !!el.taskSelect.value);
  el.captureButton.disabled = !ready;
}

// ---- Trail preview ------------------------------------------------------------

function renderTrail() {
  const nodes = view.nodes;
  el.trailList.innerHTML = "";
  el.trailThread.innerHTML = "";
  if (!nodes.length) {
    el.trailHeading.textContent = "No trail";
    const empty = document.createElement("p");
    empty.className = "trail-empty";
    empty.textContent = view.tab && isCapturableUrl(view.tab.url)
      ? "No navigation trail detected for this tab."
      : "This page cannot be captured.";
    el.trailList.replaceWith(empty);
    el.trailList = empty;
    return;
  }
  el.trailHeading.textContent = `Trail detected · ${nodes.length} step${nodes.length === 1 ? "" : "s"}`;

  // Long trails keep their two poles — where it began, where you are — and
  // fold the middle so the preview stays a glance, not a read.
  const shown = nodes.length <= 6
    ? nodes.map((node, index) => ({ node, index }))
    : [
        { node: nodes[0], index: 0 },
        { fold: nodes.length - 4 },
        ...nodes.slice(-3).map((node, i) => ({ node, index: nodes.length - 3 + i })),
      ];

  for (const entry of shown) {
    const li = document.createElement("li");
    if (entry.fold) {
      li.className = "trail-more";
      li.textContent = `${entry.fold} more page${entry.fold === 1 ? "" : "s"}`;
      el.trailList.appendChild(li);
      continue;
    }
    const { node, index } = entry;
    const isCurrent = index === nodes.length - 1;
    li.className = `trail-item${isCurrent ? " is-current" : ""}`;
    const glyph = document.createElement("span");
    glyph.className = "trail-glyph";
    glyph.setAttribute("aria-hidden", "true");
    // ◎ search origin, ○ a page on the way, ● where you are — drawn rather
    // than typed, so all three sit at one size whatever the font.
    const mark = isCurrent
      ? '<circle cx="7" cy="7" r="5" class="fill"></circle>'
      : node.type === "search"
        ? '<circle cx="7" cy="7" r="4.5" class="ring"></circle><circle cx="7" cy="7" r="1.6" class="fill"></circle>'
        : '<circle cx="7" cy="7" r="3.6" class="ring"></circle>';
    glyph.innerHTML = `<svg viewBox="0 0 14 14" width="14" height="14">${mark}</svg>`;
    const title = document.createElement("span");
    title.className = "trail-title";
    const words = truncate(displayTitle(node), 45);
    title.textContent = words;
    title.title = displayTitle(node);
    li.append(glyph, title);
    if (isCurrent) {
      const hint = document.createElement("span");
      hint.className = "visually-hidden";
      hint.textContent = " (current page)";
      title.appendChild(hint);
      li.setAttribute("aria-current", "page");
    }
    el.trailList.appendChild(li);
  }
  requestAnimationFrame(drawThread);
}

// A soft curve through the glyphs: the eye follows the line, no arrows needed.
function drawThread() {
  const box = el.trailThread.getBoundingClientRect();
  const centers = [...el.trailList.querySelectorAll(".trail-glyph")].map((glyph) => {
    const r = glyph.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
  });
  if (centers.length < 2) return;
  let d = `M ${centers[0].x} ${centers[0].y}`;
  for (let i = 1; i < centers.length; i += 1) {
    const a = centers[i - 1];
    const b = centers[i];
    const sway = i % 2 ? 7 : -7;
    const dy = b.y - a.y;
    d += ` C ${a.x + sway} ${a.y + dy * 0.4}, ${b.x + sway} ${b.y - dy * 0.4}, ${b.x} ${b.y}`;
  }
  el.trailThread.innerHTML = `<path d="${d}"></path>`;
}

// ---- Threads and tasks ----------------------------------------------------------

function option(value, label) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

async function loadThreads() {
  const list = await api(view.server, "/api/threads?scope=active");
  view.threads = (Array.isArray(list) ? list : []).sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
  );
  el.threadSelect.innerHTML = "";
  if (!view.threads.length) {
    el.threadSelect.appendChild(option("", "No threads yet"));
    el.threadSelect.disabled = true;
    say("Start a thread in Filum first.");
    return;
  }
  for (const thread of view.threads) {
    el.threadSelect.appendChild(option(thread.id, truncate(thread.name || "Untitled thread", 48)));
  }
  el.threadSelect.disabled = false;
  el.threadSelect.value = view.threads[0].id;
  await loadThread(view.threads[0].id);
}

async function loadThread(id) {
  view.thread = null;
  updateCaptureEnabled();
  el.taskSelect.innerHTML = "";
  try {
    view.thread = await api(view.server, `/api/threads/${encodeURIComponent(id)}`);
  } catch {
    say("Could not open that thread.");
    return;
  }
  const tasks = Array.isArray(view.thread.state && view.thread.state.tasks) ? view.thread.state.tasks : [];
  const open = tasks.filter((task) => task && !task.done && typeof task.id === "string");
  for (const task of open) {
    el.taskSelect.appendChild(option(task.id, truncate(task.title || "Untitled task", 48)));
  }
  const existing = el.form.querySelector('input[value="existing"]');
  const fresh = el.form.querySelector('input[value="new"]');
  existing.disabled = open.length === 0;
  if (!open.length) fresh.checked = true;
  else if (!el.form.querySelector('input[name="mode"]:checked')) existing.checked = true;
  syncMode();
}

function syncMode() {
  const mode = modeValue();
  for (const body of el.form.querySelectorAll(".choice-body")) {
    body.hidden = body.dataset.for !== mode;
  }
  updateCaptureEnabled();
}

// ---- Capture ----------------------------------------------------------------------

function buildTrail() {
  const nodes = view.nodes;
  const anchor = nodes[nodes.length - 1];
  return {
    id: crypto.randomUUID(),
    label: truncate(displayTitle(anchor), 40),
    userNote: el.userNote.value.trim(), // empty when unused — nothing invented
    capturedAt: new Date().toISOString(),
    anchorIndex: nodes.length - 1,
    nodes,
  };
}

async function capture(event) {
  event.preventDefault();
  if (el.captureButton.disabled) return;
  view.busy = true;
  updateCaptureEnabled();
  say("Capturing");
  const trail = buildTrail();
  const response = await chrome.runtime
    .sendMessage({
      type: "capture",
      tabId: view.tab.id,
      threadId: view.thread.id,
      mode: modeValue(),
      taskId: el.taskSelect.value,
      newTaskTitle: el.newTaskTitle.value,
      trail,
      crossRef: crossReference(trail),
    })
    .catch((err) => ({ ok: false, error: err.message }));

  if (!response || !response.ok) {
    view.busy = false;
    updateCaptureEnabled();
    say(response && response.error ? response.error : "Could not reach Filum.");
    return;
  }
  say(`Captured to ${truncate(response.threadName, 40)}`);
  setTimeout(() => window.close(), 2000);
}

// ---- Server setting -------------------------------------------------------------

function showServer() {
  el.serverLabel.textContent = view.server.replace(/^https?:\/\//, "");
}

function toggleServerForm() {
  const open = el.serverForm.hidden;
  el.serverForm.hidden = !open;
  el.serverHint.hidden = true;
  el.serverToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    el.serverInput.value = view.server.replace(/^https?:\/\//, "");
    el.serverInput.focus();
    el.serverInput.select();
  }
}

async function saveServer(event) {
  event.preventDefault();
  const next = normalizeServerUrl(el.serverInput.value);
  if (!next) {
    el.serverHint.hidden = false;
    return;
  }
  await chrome.storage.local.set({ serverUrl: next });
  view.server = next;
  showServer();
  el.serverForm.hidden = true;
  el.serverHint.hidden = true;
  el.serverToggle.setAttribute("aria-expanded", "false");
  await connect();
}

// ---- Start ----------------------------------------------------------------------

async function readContext(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageContext });
    return result ? result.result : null;
  } catch {
    return null;
  }
}

async function readTrail(tab, context) {
  const response = await chrome.runtime
    .sendMessage({ type: "getTrail", tabId: tab.id, url: tab.url, title: (context && context.title) || tab.title })
    .catch(() => null);
  if (!response || !response.ok || !Array.isArray(response.nodes) || !response.nodes.length) return { nodes: [] };
  const nodes = response.nodes.slice();
  const last = nodes.length - 1;
  // The anchor — the page in front of you — gets the full harvested context,
  // including any text you have highlighted.
  nodes[last] = withContext(nodes[last], context, { includeSnippet: true });
  return { nodes, following: response.following };
}

async function connect() {
  setStatus("checking", "Looking for Filum");
  view.connected = false;
  updateCaptureEnabled();
  try {
    await api(view.server, "/api/settings", { timeout: 2500 });
    view.connected = true;
    setStatus("connected", "Connected");
    say("");
    await loadThreads();
  } catch {
    setStatus("disconnected", "Not connected");
    el.threadSelect.innerHTML = "";
    el.threadSelect.appendChild(option("", "Filum is not running"));
    el.threadSelect.disabled = true;
    say(`Start Filum at ${view.server.replace(/^https?:\/\//, "")}, then open this again.`);
  }
  updateCaptureEnabled();
}

async function start() {
  view.server = await getServerUrl();
  showServer();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  view.tab = tab || null;
  const capturable = !!tab && isCapturableUrl(tab.url);

  const trailPromise = capturable
    ? readContext(tab).then((context) => readTrail(tab, context).then((trail) => ({ ...trail, context })))
    : Promise.resolve({ nodes: [], context: null });

  const [trail] = await Promise.all([trailPromise, connect()]);
  view.nodes = trail.nodes;
  renderTrail();
  if (trail.following && trail.following.taskTitle) {
    el.following.textContent = `Following this tab for “${truncate(trail.following.taskTitle, 40)}”.`;
    el.following.hidden = false;
  }
  if (view.nodes.length) {
    const anchor = view.nodes[view.nodes.length - 1];
    el.newTaskTitle.value = truncate(anchor.ogTitle || anchor.title || displayTitle(anchor), 120);
  }
  updateCaptureEnabled();
}

el.form.addEventListener("submit", capture);
el.form.addEventListener("change", (event) => {
  if (event.target.name === "mode") syncMode();
  if (event.target === el.threadSelect) loadThread(el.threadSelect.value);
  if (event.target === el.taskSelect) updateCaptureEnabled();
});
el.newTaskTitle.addEventListener("input", updateCaptureEnabled);
el.serverToggle.addEventListener("click", toggleServerForm);
el.serverForm.addEventListener("submit", saveServer);

start();
