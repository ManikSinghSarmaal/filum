// Filum — Web Journey: background service worker.
//
// Keeps a short, per-tab chain of top-level navigations so the popup can show
// how a page was reached the moment it is opened. Nothing leaves the browser
// until the user presses Capture. The chains live in chrome.storage.session —
// memory only, never written to disk, cleared when the browser closes — so a
// service-worker restart does not lose the trail mid-research.
//
// After a capture, the tab is bound to that one trail; each further page in
// the tab is appended and written to Filum. The binding ends when the tab
// closes. No badges, no counters, no always-on content scripts.

import {
  MAX_TRAIL_NODES,
  api,
  emptyNode,
  extractPageContext,
  getServerUrl,
  isCapturableUrl,
  nodeType,
  samePage,
  searchInfo,
  withContext,
} from "./shared.js";

const MAX_CHAIN = 40;
const HISTORY_DEPTH = 4;
const HISTORY_BUDGET_MS = 1500;

const memory = { chains: {}, parents: {}, bindings: {} };

const ready = chrome.storage.session
  .get(["chains", "parents", "bindings"])
  .then((saved) => {
    memory.chains = saved.chains || {};
    memory.parents = saved.parents || {};
    memory.bindings = saved.bindings || {};
  })
  .catch(() => {});

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session.set(memory).catch(() => {});
  }, 150);
}

// ---- Chain tracking ---------------------------------------------------------

function lineage(tabId) {
  const parent = memory.parents[tabId];
  return [...(parent ? parent.chain : []), ...(memory.chains[tabId] || [])];
}

function recordNavigation(details, transitionType, qualifiers) {
  const chain = memory.chains[details.tabId] || (memory.chains[details.tabId] = []);
  const last = chain[chain.length - 1];

  // A reload, or the same page again, is not a new step.
  if (transitionType === "reload" || (last && samePage(last.url, details.url))) {
    if (last) last.timestamp = details.timeStamp;
    return;
  }
  // A page that redirected itself straight away: keep how the user arrived,
  // but remember where they actually landed.
  if (last && qualifiers.includes("client_redirect") && details.timeStamp - last.timestamp < 5000) {
    last.url = details.url;
    last.title = "";
    last.timestamp = details.timeStamp;
    return;
  }
  // Back / forward: the lineage is the path that led here, so dead ends
  // walked back out of are dropped.
  if (qualifiers.includes("forward_back")) {
    const index = chain.findIndex((entry) => samePage(entry.url, details.url));
    if (index >= 0) {
      chain.length = index + 1;
      chain[index].timestamp = details.timeStamp;
      return;
    }
  }
  chain.push({ url: details.url, title: "", transitionType, timestamp: details.timeStamp });
  if (chain.length > MAX_CHAIN) chain.splice(0, chain.length - MAX_CHAIN);
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0 || !isCapturableUrl(details.url)) return;
  await ready;
  recordNavigation(details, details.transitionType, details.transitionQualifiers || []);
  persist();
});

// Single-page apps change the address without a full navigation.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || !isCapturableUrl(details.url)) return;
  await ready;
  recordNavigation(details, "link", []);
  persist();
  followTab(details.tabId, details.url);
});

// A link opened into a new tab carries its parent's lineage with it.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  await ready;
  memory.parents[details.tabId] = {
    sourceTabId: details.sourceTabId,
    chain: lineage(details.sourceTabId).slice(-MAX_CHAIN),
  };
  persist();
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0 || !isCapturableUrl(details.url)) return;
  followTab(details.tabId, details.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title) return;
  await ready;
  const chain = memory.chains[tabId];
  if (!chain || !chain.length) return;
  const entry = [...chain].reverse().find((item) => samePage(item.url, tab.url)) || null;
  if (entry) {
    entry.title = changeInfo.title;
    persist();
  }
});

// Prerendered pages swap in under a new tab id; carry everything across.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ready;
  for (const key of ["chains", "parents", "bindings"]) {
    if (memory[key][removedTabId]) {
      memory[key][addedTabId] = memory[key][removedTabId];
      delete memory[key][removedTabId];
    }
  }
  persist();
});

// The honest boundary: when the tab closes, its chain and any forward
// tracking end with it.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  delete memory.chains[tabId];
  delete memory.parents[tabId];
  delete memory.bindings[tabId];
  persist();
});

// ---- Backward lineage from history -------------------------------------------
//
// The in-memory chain is authoritative. History only fills in what came
// before it — a tab opened before the extension was installed, say. Chrome
// links visits by referringVisitId, but offers no lookup by visit id, so each
// step searches the visits shortly before and matches the id.

function startsFresh(entry) {
  return !!entry && (searchInfo(entry.url) || ["typed", "generated", "auto_bookmark", "keyword"].includes(entry.transitionType));
}

async function historyBefore(url, atTime, deadline) {
  const found = [];
  let currentUrl = url;
  let time = atTime;
  for (let depth = 0; depth < HISTORY_DEPTH && Date.now() < deadline; depth += 1) {
    const visits = await chrome.history.getVisits({ url: currentUrl });
    if (!visits.length) break;
    const prior = visits.filter((v) => v.visitTime <= time + 2000);
    const visit = (prior.length ? prior : visits).reduce((a, b) => (b.visitTime > a.visitTime ? b : a));
    if (!visit.referringVisitId || visit.referringVisitId === "0") break;

    const candidates = await chrome.history.search({
      text: "",
      startTime: visit.visitTime - 2 * 60 * 60 * 1000,
      endTime: visit.visitTime + 1,
      maxResults: 60,
    });
    let match = null;
    for (const item of candidates) {
      if (Date.now() > deadline) break;
      if (!item.url || item.url === currentUrl || !isCapturableUrl(item.url)) continue;
      const itemVisits = await chrome.history.getVisits({ url: item.url });
      const hit = itemVisits.find((v) => v.visitId === visit.referringVisitId);
      if (hit) {
        match = { url: item.url, title: item.title || "", transitionType: hit.transition, timestamp: hit.visitTime };
        break;
      }
    }
    if (!match) break;
    found.unshift(match);
    if (startsFresh(match)) break;
    currentUrl = match.url;
    time = match.timestamp;
  }
  return found;
}

async function getTrail(tabId, url, title) {
  await ready;
  let chain = lineage(tabId).map((entry) => ({ ...entry }));
  if (!chain.length || !samePage(chain[chain.length - 1].url, url)) {
    chain.push({ url, title: title || "", transitionType: "link", timestamp: Date.now() });
  }
  if (!startsFresh(chain[0])) {
    try {
      const earlier = await historyBefore(chain[0].url, chain[0].timestamp, Date.now() + HISTORY_BUDGET_MS);
      const known = new Set(chain.map((entry) => entry.url));
      chain = [...earlier.filter((entry) => !known.has(entry.url)), ...chain];
    } catch {
      // History is a supplement; the in-memory chain stands on its own.
    }
  }
  // Collapse any repeats the merge produced.
  chain = chain.filter((entry, i) => i === 0 || !samePage(entry.url, chain[i - 1].url));
  if (title) chain[chain.length - 1].title = title;
  chain = chain.slice(-MAX_TRAIL_NODES);

  const nodes = chain.map((entry, i) => ({
    ...emptyNode(entry.url),
    title: entry.title || "",
    type: nodeType(entry.url, entry.transitionType),
    referrer: i > 0 ? chain[i - 1].url : "",
    visitedAt: new Date(entry.timestamp || Date.now()).toISOString(),
  }));
  const binding = memory.bindings[tabId] || null;
  return { nodes, following: binding ? { taskTitle: binding.taskTitle || "", threadName: binding.threadName || "" } : null };
}

// ---- Writes to Filum (one at a time) -----------------------------------------
//
// Every write is a read-modify-write of the whole thread file, so writes are
// queued: a capture and a forward-tracked page can never interleave and drop
// each other.

let queue = Promise.resolve();
function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function appendLine(notes, line) {
  const base = typeof notes === "string" ? notes.replace(/\s+$/, "") : "";
  const next = base ? `${base}\n${line}` : line;
  return next.length <= 10000 ? next : base;
}

function newTask(title, notes, trail) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    urgency: "",
    energy: "",
    type: "",
    notes,
    duration: "",
    done: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    images: [],
    deepLinks: [trail],
  };
}

async function captureTrail({ tabId, threadId, mode, taskId, newTaskTitle, trail, crossRef }) {
  const server = await getServerUrl();
  return enqueue(async () => {
    const thread = await api(server, `/api/threads/${encodeURIComponent(threadId)}`);
    const state = thread.state && typeof thread.state === "object" ? { ...thread.state } : {};
    const tasks = Array.isArray(state.tasks) ? state.tasks.slice() : [];
    let task;
    if (mode === "new") {
      task = newTask(String(newTaskTitle || "").trim().slice(0, 300) || trail.label, crossRef, trail);
      tasks.push(task);
    } else {
      const index = tasks.findIndex((entry) => entry && entry.id === taskId);
      if (index < 0) throw new Error("That task is no longer in this thread.");
      const existing = tasks[index];
      task = {
        ...existing,
        notes: appendLine(existing.notes, crossRef),
        deepLinks: [...(Array.isArray(existing.deepLinks) ? existing.deepLinks : []), trail],
        updatedAt: new Date().toISOString(),
      };
      tasks[index] = task;
    }
    await api(server, `/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PUT",
      body: { name: thread.name, state: { ...state, tasks } },
    });

    await ready;
    if (Number.isInteger(tabId)) {
      const anchor = trail.nodes[trail.nodes.length - 1];
      memory.bindings[tabId] = {
        threadId,
        taskId: task.id,
        trailId: trail.id,
        lastUrl: anchor ? anchor.url : "",
        taskTitle: task.title,
        threadName: thread.name,
      };
      persist();
    }
    return { threadName: thread.name || "your thread", taskTitle: task.title };
  });
}

// ---- Forward tracking ---------------------------------------------------------

async function followTab(tabId, url) {
  await ready;
  const binding = memory.bindings[tabId];
  // onCompleted and onHistoryStateUpdated can both report one page; lastUrl
  // is updated synchronously so the second report is a no-op.
  if (!binding || samePage(binding.lastUrl, url)) return;
  try {
    const previous = binding.lastUrl;
    binding.lastUrl = url;
    persist();

    const chain = memory.chains[tabId] || [];
    const entry = [...chain].reverse().find((item) => samePage(item.url, url));
    // activeTab access ends once the tab navigates, so richer context is a
    // best effort; the address, title and timing are always recorded.
    let context = null;
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageContext });
      context = result && result.result;
    } catch {
      context = null;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let node = {
      ...emptyNode(url),
      title: (tab && tab.title) || (entry && entry.title) || "",
      type: nodeType(url, entry ? entry.transitionType : "link"),
      referrer: previous,
    };
    node = withContext(node, context, { includeSnippet: false });

    const server = await getServerUrl();
    await enqueue(async () => {
      const thread = await api(server, `/api/threads/${encodeURIComponent(binding.threadId)}`);
      const tasks = Array.isArray(thread.state && thread.state.tasks) ? thread.state.tasks : [];
      const task = tasks.find((t) => t && t.id === binding.taskId);
      const trail = task && Array.isArray(task.deepLinks) ? task.deepLinks.find((t) => t && t.id === binding.trailId) : null;
      if (!trail || !Array.isArray(trail.nodes)) {
        // The trail was removed in Filum: stop following quietly.
        delete memory.bindings[tabId];
        persist();
        return;
      }
      const last = trail.nodes[trail.nodes.length - 1];
      if (last && samePage(last.url, url)) return;
      trail.nodes.push(node);
      if (trail.nodes.length >= MAX_TRAIL_NODES) {
        delete memory.bindings[tabId];
        persist();
      }
      task.updatedAt = new Date().toISOString();
      await api(server, `/api/threads/${encodeURIComponent(binding.threadId)}`, {
        method: "PUT",
        body: { name: thread.name, state: thread.state },
      });
    });
  } catch {
    // Filum is closed or unreachable: this page is simply not added.
  }
}

// ---- Messages from the popup --------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return false;
  const reply = (promise) => {
    promise
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : "Something went wrong." }));
    return true; // keep the channel open for the async reply
  };
  if (message.type === "getTrail") {
    return reply(getTrail(message.tabId, message.url, message.title));
  }
  if (message.type === "capture") {
    return reply(captureTrail(message));
  }
  if (message.type === "startForwardTracking") {
    // Kept for parity with the design document; capture already binds.
    return reply(
      ready.then(() => {
        const { tabId, threadId, taskId, trailId, lastUrl } = message;
        memory.bindings[tabId] = { threadId, taskId, trailId, lastUrl: lastUrl || "" };
        persist();
        return {};
      })
    );
  }
  if (message.type === "stopForwardTracking") {
    return reply(
      ready.then(() => {
        delete memory.bindings[message.tabId];
        persist();
        return {};
      })
    );
  }
  return false;
});
