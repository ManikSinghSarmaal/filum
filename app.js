const LOCAL_MIRROR_KEY = "filum-state-v1";
const SETTINGS_MIRROR_KEY = "filum-settings-v1";
const DEFAULT_STEP = "capture";
const PERSIST_DEBOUNCE_MS = 400;
const steps = ["capture", "plan", "line"];

const MAX_IMAGE_EDGE = 1000;
const IMAGE_QUALITY = 0.82;
const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}'"])/gi;
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Preset shades for the note-label keyword — all muted, cream-compatible.
// The violet is a scoped colour exception recorded in design.md's drift log.
const NOTE_SHADES = ["#6f5f80", "#7d6890", "#615671"];

const state = {
  threadId: null,
  threadName: "Untitled thread",
  tasks: [],
  currentStep: DEFAULT_STEP,
  focusIndex: 0,
};

let threadList = [];
let archiveList = [];
let binList = [];
let isDirty = false;
let isOffline = false;
let threadMissing = false; // the open thread's file vanished on disk; stop saving it
let persistTimer = null;
let openScope = "active"; // where the open thread's file lives (active | archive)

// Transient, never-persisted UI state.
let captureImages = []; // images staged for the next captured task
let editingTaskId = null; // task currently being edited in place (null = none)
let editingImages = []; // working copy of that task's images while editing
let untangleToken = 0; // bumped to cancel any in-flight svg animation
let threadMenuOpen = false; // is the saved-threads dropdown open?
let threadMenuScope = "active"; // which listing the dropdown shows
let binConfirm = false; // two-step confirm state for "Empty bin"
let retrospectOn = false; // Step 3 look-back view showing completed knots
let prefsOpen = false; // is the preferences pop-down open?
let findOpen = false;
let findResultsCache = [];
let findActiveIndex = 0;
let findInvalid = false;
let findRestoreFocus = null;

let appSettings = defaultSettings();
let noteLabelRegex = null;

const elements = {
  taskForm: document.getElementById("taskForm"),
  taskTitle: document.getElementById("taskTitle"),
  taskNotes: document.getElementById("taskNotes"),
  taskCount: document.getElementById("taskCount"),
  taskPreviewList: document.getElementById("taskPreviewList"),
  miniThreadSvg: document.getElementById("miniThreadSvg"),
  captureAddImageButton: document.getElementById("captureAddImageButton"),
  captureImageInput: document.getElementById("captureImageInput"),
  captureAttachments: document.getElementById("captureAttachments"),
  finishAggregationButton: document.getElementById("finishAggregationButton"),
  resetButton: document.getElementById("resetButton"),
  toLineButton: document.getElementById("toLineButton"),
  focusPrevButton: document.getElementById("focusPrevButton"),
  focusNextButton: document.getElementById("focusNextButton"),
  planningList: document.getElementById("planningList"),
  lineSvg: document.getElementById("lineSvg"),
  linePanel: document.querySelector('.panel[data-step="line"]'),
  linearList: document.getElementById("linearList"),
  focusTitle: document.getElementById("focusTitle"),
  focusNotes: document.getElementById("focusNotes"),
  focusAttachments: document.getElementById("focusAttachments"),
  focusEditButton: document.getElementById("focusEditButton"),
  focusDoneButton: document.getElementById("focusDoneButton"),
  focusArchiveButton: document.getElementById("focusArchiveButton"),
  retrospectButton: document.getElementById("retrospectButton"),
  focusEditor: document.getElementById("focusEditor"),
  stepButtons: Array.from(document.querySelectorAll(".step")),
  panels: Array.from(document.querySelectorAll(".panel")),
  threadMenuButton: document.getElementById("threadMenuButton"),
  threadMenuLabel: document.getElementById("threadMenuLabel"),
  threadMenu: document.getElementById("threadMenu"),
  threadNameInput: document.getElementById("threadNameInput"),
  saveThreadButton: document.getElementById("saveThreadButton"),
  newThreadButton: document.getElementById("newThreadButton"),
  threadStatus: document.getElementById("threadStatus"),
  prefsButton: document.getElementById("prefsButton"),
  prefsPanel: document.getElementById("prefsPanel"),
  findBar: document.getElementById("findBar"),
  findInput: document.getElementById("findInput"),
  findResults: document.getElementById("findResults"),
  findPlanButton: document.getElementById("findPlanButton"),
  findLineButton: document.getElementById("findLineButton"),
};

const storage = {
  async listThreads(scope = "active") {
    const res = await fetch(`/api/threads?scope=${encodeURIComponent(scope)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    return res.json();
  },
  async loadThread(id) {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    return res.json();
  },
  async createThread(name, threadState) {
    const res = await fetch("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, state: threadState }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    return res.json();
  },
  async saveThread(thread) {
    const res = await fetch(`/api/threads/${encodeURIComponent(thread.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: thread.name, state: thread.state }),
    });
    if (!res.ok) {
      const err = new Error(`save failed: ${res.status}`);
      // 404/409: the file is gone or binned — do not recreate it.
      err.gone = res.status === 404 || res.status === 409;
      throw err;
    }
    return res.json();
  },
  async moveThread(id, to) {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });
    if (!res.ok) throw new Error(`move failed: ${res.status}`);
    return res.json();
  },
  async emptyBin() {
    const res = await fetch("/api/bin", { method: "DELETE" });
    if (!res.ok) throw new Error(`empty bin failed: ${res.status}`);
    return res.json();
  },
  async loadSettings() {
    const res = await fetch("/api/settings", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`settings load failed: ${res.status}`);
    return res.json();
  },
  async saveSettings(settings) {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`settings save failed: ${res.status}`);
    return res.json();
  },
};

bootstrap();
registerServiceWorker();

async function bootstrap() {
  bindEvents();
  await loadSettingsIntoApp();
  try {
    await openMostRecentOrNew();
  } catch (err) {
    console.warn("[filum] starting offline:", err);
    isOffline = true;
    hydrate(loadOfflineMirror());
    setStatus("Working offline — server not reachable");
    render();
  }
  renderThreadMenu();
}

// Open the most recently touched active thread, or start a fresh one.
async function openMostRecentOrNew() {
  threadList = await storage.listThreads("active");
  let thread;
  if (threadList.length) {
    thread = await storage.loadThread(threadList[0].id);
  } else {
    thread = await storage.createThread("Untitled thread", emptyStateObject());
    threadList = [
      { id: thread.id, name: thread.name, createdAt: thread.createdAt, updatedAt: thread.updatedAt },
    ];
  }
  hydrate(thread);
  isOffline = false;
  setStatus(`Saved · ${formatTime(thread.updatedAt)}`);
  render();
  renderThreadMenu();
}

function hydrate(thread) {
  state.threadId = thread.id || null;
  state.threadName = thread.name || "Untitled thread";
  const incoming = thread.state || emptyStateObject();
  state.tasks = Array.isArray(incoming.tasks) ? incoming.tasks.map(normalizeTask) : [];
  state.currentStep = steps.includes(incoming.currentStep) ? incoming.currentStep : DEFAULT_STEP;
  state.focusIndex = Number.isInteger(incoming.focusIndex) ? incoming.focusIndex : 0;
  if (state.focusIndex >= state.tasks.length) {
    state.focusIndex = Math.max(0, state.tasks.length - 1);
  }
  openScope = thread.scope === "archive" || thread.scope === "bin" ? thread.scope : "active";
  threadMissing = false;
  retrospectOn = false;
  editingTaskId = null;
  editingImages = [];
  normalizeFocus();
  isDirty = false;
}

function emptyStateObject() {
  return { tasks: [], currentStep: DEFAULT_STEP, focusIndex: 0 };
}

// Back-fill any fields that older thread files predate, so every task the rest
// of the app sees has a predictable shape. This is also the v1 -> v2 migration:
// `done` / `completedAt` appear here, and the legacy triage fields (urgency,
// energy, type, duration) are preserved so old files round-trip untouched even
// though the UI no longer renders them.
function normalizeTask(task) {
  const t = task && typeof task === "object" ? task : {};
  return {
    id: typeof t.id === "string" && t.id ? t.id : crypto.randomUUID(),
    title: typeof t.title === "string" ? t.title : "",
    urgency: typeof t.urgency === "string" ? t.urgency : "",
    energy: typeof t.energy === "string" ? t.energy : "",
    type: typeof t.type === "string" ? t.type : "",
    notes: typeof t.notes === "string" ? t.notes : "",
    duration: typeof t.duration === "string" ? t.duration : "",
    done: t.done === true,
    completedAt: typeof t.completedAt === "string" ? t.completedAt : null,
    images: Array.isArray(t.images)
      ? t.images
          .filter((img) => img && typeof img.src === "string" && img.src)
          .map((img) => ({
            id: typeof img.id === "string" && img.id ? img.id : crypto.randomUUID(),
            src: img.src,
            alt: typeof img.alt === "string" ? img.alt : "",
          }))
      : [],
  };
}

// ---- Focus semantics over completed knots ---------------------------------
//
// focusIndex stays an index into the FULL tasks array (stable across masking,
// old files load unchanged). Completed knots are invisible everywhere except
// the retrospect view; these helpers are the single lens the renderers use.

function visibleTasks() {
  return state.tasks.filter((task) => !task.done);
}

// If the focused task is gone or done, settle on the nearest visible one.
function normalizeFocus() {
  if (!state.tasks.length) {
    state.focusIndex = 0;
    return;
  }
  const current = state.tasks[state.focusIndex];
  if (current && !current.done) return;
  for (let i = state.focusIndex + 1; i < state.tasks.length; i += 1) {
    if (!state.tasks[i].done) {
      state.focusIndex = i;
      return;
    }
  }
  for (let i = Math.min(state.focusIndex, state.tasks.length - 1); i >= 0; i -= 1) {
    if (!state.tasks[i].done) {
      state.focusIndex = i;
      return;
    }
  }
  state.focusIndex = Math.max(0, Math.min(state.focusIndex, state.tasks.length - 1));
}

function setFocusByTaskId(taskId) {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index < 0 || state.tasks[index].done) return;
  if (index === state.focusIndex) return;
  state.focusIndex = index;
  markDirty();
  renderLine();
  renderLineThread();
  bindInlineEditor(); // re-wire the editor if it re-rendered for the new focus
}

function nextFocusTask() {
  for (let i = state.focusIndex + 1; i < state.tasks.length; i += 1) {
    if (!state.tasks[i].done) {
      setFocusByTaskId(state.tasks[i].id);
      return;
    }
  }
}

function prevFocusTask() {
  for (let i = state.focusIndex - 1; i >= 0; i -= 1) {
    if (!state.tasks[i].done) {
      setFocusByTaskId(state.tasks[i].id);
      return;
    }
  }
}

// ---- Completion & retrospect ----------------------------------------------

function completeFocusedTask() {
  const task = state.tasks[state.focusIndex];
  if (!task || task.done) return;
  task.done = true;
  task.completedAt = new Date().toISOString();
  normalizeFocus();
  markDirty();
  // No message, no celebration — the loosening thread is the acknowledgment.
  render();
}

function restoreTask(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task || !task.done) return;
  task.done = false;
  task.completedAt = null;
  normalizeFocus();
  markDirty();
  render();
}

function toggleRetrospect() {
  retrospectOn = !retrospectOn;
  untangleToken += 1; // cancel any in-flight svg animation
  render();
  if (retrospectOn) playRetrospect();
}

function bindEvents() {
  elements.taskForm.addEventListener("submit", handleAddTask);
  elements.finishAggregationButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      elements.taskTitle.focus();
      return;
    }
    setStep("plan");
  });
  elements.toLineButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      setStep("capture");
      return;
    }
    playUntangle();
  });

  bindCaptureImages();
  if (elements.taskNotes) bindMarkShortcuts(elements.taskNotes);
  if (elements.focusNextButton) {
    elements.focusNextButton.addEventListener("click", nextFocusTask);
  }
  if (elements.focusPrevButton) {
    elements.focusPrevButton.addEventListener("click", prevFocusTask);
  }
  elements.resetButton.addEventListener("click", resetState);

  if (elements.focusDoneButton) {
    elements.focusDoneButton.addEventListener("click", completeFocusedTask);
  }
  if (elements.retrospectButton) {
    elements.retrospectButton.addEventListener("click", toggleRetrospect);
  }
  if (elements.focusArchiveButton) {
    elements.focusArchiveButton.addEventListener("click", archiveCurrentThread);
  }

  if (elements.linePanel) {
    elements.linePanel.addEventListener("keydown", (event) => {
      // Never hijack arrows while editing — they belong to the inline editor's
      // fields, not task navigation.
      if (editingTaskId !== null || event.target.closest(".inline-editor")) return;
      if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        nextFocusTask();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prevFocusTask();
      }
    });
  }

  if (elements.linearList) {
    elements.linearList.addEventListener("click", (event) => {
      const restore = event.target.closest("[data-restore-task]");
      if (restore) {
        restoreTask(restore.dataset.restoreTask);
        return;
      }
      const item = event.target.closest(".linear-item[data-task-id]");
      if (!item || item.classList.contains("is-done")) return;
      setFocusByTaskId(item.dataset.taskId);
    });
    elements.linearList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = event.target.closest(".linear-item[data-task-id]");
      if (!item || item.classList.contains("is-done")) return;
      event.preventDefault();
      setFocusByTaskId(item.dataset.taskId);
    });
  }

  if (elements.lineSvg) {
    // The dots on the thread are jump points, same as the rail cards.
    elements.lineSvg.addEventListener("click", (event) => {
      const dot = event.target.closest("[data-task-id]");
      if (dot) setFocusByTaskId(dot.dataset.taskId);
    });
  }

  elements.stepButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.stepTarget;
      if ((target === "plan" || target === "line") && !state.tasks.length) {
        return;
      }
      setStep(target);
    });
  });

  if (elements.taskPreviewList) {
    elements.taskPreviewList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-edit-task]");
      if (!trigger) return;
      startEdit(trigger.dataset.editTask);
    });
  }

  if (elements.focusEditButton) {
    elements.focusEditButton.addEventListener("click", () => {
      const current = state.tasks[state.focusIndex];
      if (current) startEdit(current.id);
    });
  }

  if (elements.threadMenuButton) {
    elements.threadMenuButton.addEventListener("click", toggleThreadMenu);
  }
  if (elements.threadMenu) {
    elements.threadMenu.addEventListener("click", handleThreadMenuClick);
    elements.threadMenu.addEventListener("keydown", handleThreadMenuKeydown);
  }
  if (elements.prefsButton) {
    elements.prefsButton.addEventListener("click", togglePrefsPanel);
  }

  // Close pop-downs on an outside click or Escape. A click that re-rendered
  // its own pop (scope switch, swatch, inline confirm) reaches this handler
  // with a detached target — closest() then finds nothing and would misread
  // it as an outside click, so detached targets are ignored entirely.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.isConnected) return;
    if (threadMenuOpen && !target.closest(".thread-menu")) closeThreadMenu();
    if (prefsOpen && !target.closest(".prefs-menu")) closePrefsPanel();
    if (
      findOpen &&
      !target.closest(".find-bar") &&
      !target.closest("#findPlanButton") &&
      !target.closest("#findLineButton")
    ) {
      closeFind();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (threadMenuOpen) closeThreadMenu();
      if (prefsOpen) closePrefsPanel();
    }
    const typing =
      event.target.closest("input, textarea, select") || editingTaskId !== null;
    const wantsFind =
      (event.key === "/" && !typing) ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k");
    if (wantsFind && state.tasks.length) {
      event.preventDefault();
      if (findOpen) closeFind();
      else openFind();
    }
  });

  if (elements.findPlanButton) elements.findPlanButton.addEventListener("click", openFind);
  if (elements.findLineButton) elements.findLineButton.addEventListener("click", openFind);
  if (elements.findInput) {
    elements.findInput.addEventListener("input", runFind);
    elements.findInput.addEventListener("keydown", handleFindKeydown);
  }
  if (elements.findResults) {
    elements.findResults.addEventListener("click", (event) => {
      const row = event.target.closest("[data-task-id]");
      if (row) selectFindResult(row.dataset.taskId);
    });
  }

  if (elements.threadNameInput) {
    elements.threadNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    });
    elements.threadNameInput.addEventListener("blur", commitRename);
  }

  if (elements.saveThreadButton) {
    elements.saveThreadButton.addEventListener("click", startRename);
  }
  if (elements.newThreadButton) {
    elements.newThreadButton.addEventListener("click", handleNewThread);
  }

  bindPlanDrag();

  window.addEventListener("resize", renderVisuals);
  window.addEventListener("beforeunload", flushPersistOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistOnUnload();
  });
}

function handleAddTask(event) {
  event.preventDefault();

  const title = elements.taskTitle.value.trim();
  if (!title) {
    elements.taskTitle.focus();
    return;
  }

  state.tasks.push({
    id: crypto.randomUUID(),
    title,
    urgency: "",
    energy: "",
    type: "",
    notes: elements.taskNotes.value.trim(),
    duration: "",
    done: false,
    completedAt: null,
    images: captureImages.slice(),
  });

  elements.taskForm.reset();
  captureImages = [];
  renderCaptureAttachments();
  elements.taskTitle.focus();
  markDirty();
  render();
}

function resetState() {
  state.tasks = [];
  state.currentStep = DEFAULT_STEP;
  state.focusIndex = 0;
  captureImages = [];
  editingTaskId = null;
  editingImages = [];
  retrospectOn = false;
  renderCaptureAttachments();
  markDirty();
  render();
}

function setStep(step) {
  // Switching steps cancels any in-progress edit, the retrospect view, and an
  // open find bar — each belongs to the step it was opened in.
  editingTaskId = null;
  editingImages = [];
  if (retrospectOn) {
    retrospectOn = false;
    untangleToken += 1;
  }
  closeFind();
  state.currentStep = steps.includes(step) ? step : DEFAULT_STEP;
  markDirty();
  render();
}

// ---- Saved-threads dropdown (active / archived / bin) ----------------------

function toggleThreadMenu() {
  if (threadMenuOpen) closeThreadMenu();
  else openThreadMenu();
}

async function openThreadMenu() {
  if (!elements.threadMenu) return;
  threadMenuOpen = true;
  threadMenuScope = "active";
  binConfirm = false;
  elements.threadMenu.hidden = false;
  if (elements.threadMenuButton) elements.threadMenuButton.setAttribute("aria-expanded", "true");
  renderThreadMenu(); // show what we already have, then refresh from disk
  await refreshThreadList();
  const first = elements.threadMenu.querySelector("button");
  if (first) first.focus();
}

function closeThreadMenu() {
  if (!threadMenuOpen) return;
  threadMenuOpen = false;
  threadMenuScope = "active";
  binConfirm = false;
  const hadFocusInside =
    elements.threadMenu && elements.threadMenu.contains(document.activeElement);
  if (elements.threadMenu) elements.threadMenu.hidden = true;
  if (elements.threadMenuButton) {
    elements.threadMenuButton.setAttribute("aria-expanded", "false");
    if (hadFocusInside) elements.threadMenuButton.focus();
  }
}

function handleThreadMenuKeydown(event) {
  const rows = Array.from(elements.threadMenu.querySelectorAll("button"));
  if (!rows.length) return;
  const idx = rows.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    rows[Math.min(rows.length - 1, idx + 1)].focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    rows[Math.max(0, idx - 1)].focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    rows[0].focus();
  } else if (event.key === "End") {
    event.preventDefault();
    rows[rows.length - 1].focus();
  }
}

async function handleThreadMenuClick(event) {
  const scopeButton = event.target.closest("[data-menu-scope]");
  if (scopeButton) {
    threadMenuScope = scopeButton.dataset.menuScope;
    binConfirm = false;
    renderThreadMenu();
    return;
  }
  const restore = event.target.closest("[data-menu-restore]");
  if (restore) {
    await restoreThreadFromMenu(restore.dataset.menuRestore);
    return;
  }
  const action = event.target.closest("[data-menu-action]");
  if (action) {
    await handleThreadMenuAction(action.dataset.menuAction);
    return;
  }
  const row = event.target.closest("[data-thread-id]");
  if (row) openThreadById(row.dataset.threadId);
}

async function handleThreadMenuAction(action) {
  if (action === "archive-current") {
    await archiveCurrentThread();
  } else if (action === "bin-current") {
    await binCurrentThread();
  } else if (action === "return-current") {
    try {
      await storage.moveThread(state.threadId, "active");
      openScope = "active";
      setStatus("Thread returned to the active list");
      await refreshThreadList();
    } catch (err) {
      console.warn("[filum] return failed:", err);
      setStatus("Could not return this thread");
    }
  } else if (action === "empty-bin") {
    if (!binConfirm) {
      binConfirm = true;
      renderThreadMenu();
      return;
    }
    try {
      await storage.emptyBin();
      binConfirm = false;
      setStatus("Bin emptied");
      await refreshThreadList();
    } catch (err) {
      console.warn("[filum] empty bin failed:", err);
      setStatus("Could not empty the bin");
    }
  } else if (action === "keep-bin") {
    binConfirm = false;
    renderThreadMenu();
  }
}

async function restoreThreadFromMenu(id) {
  try {
    await storage.moveThread(id, "active");
    if (id === state.threadId) openScope = "active";
    setStatus("Thread returned to the active list");
    await refreshThreadList();
  } catch (err) {
    console.warn("[filum] restore failed:", err);
    setStatus("Could not restore this thread");
  }
}

// Build the dropdown from the directory listings. The active view lists active
// threads; quiet footer actions reach the current thread, Archived, and Bin.
function renderThreadMenu() {
  if (elements.threadMenuLabel) {
    elements.threadMenuLabel.textContent = state.threadName || "Untitled thread";
  }
  if (!elements.threadMenu) return;

  if (threadMenuScope === "archive" || threadMenuScope === "bin") {
    renderThreadMenuScope(threadMenuScope);
    return;
  }

  const rows = threadList
    .map((thread) => {
      const isCurrent = thread.id === state.threadId;
      const name = thread.name || "Untitled thread";
      const when = isCurrent ? "open now" : formatTime(thread.updatedAt);
      return `
        <button class="thread-menu-row ${isCurrent ? "is-current" : ""}" type="button" role="option"
          data-thread-id="${escapeHtml(thread.id)}" ${isCurrent ? 'aria-current="true"' : ""}>
          <span class="thread-menu-row-name">${escapeHtml(name)}</span>
          <span class="thread-menu-row-time">${escapeHtml(when)}</span>
        </button>`;
    })
    .join("");

  const empty = !threadList.length
    ? `<p class="thread-menu-empty">${
        isOffline ? "Threads list when the server is running." : "No saved threads yet."
      }</p>`
    : "";

  elements.threadMenu.innerHTML = rows + empty + renderThreadMenuFooter();
}

function renderThreadMenuFooter() {
  const parts = [];
  if (state.threadId && !threadMissing) {
    if (openScope === "active") {
      parts.push(
        '<button class="thread-menu-action" type="button" data-menu-action="archive-current">Archive this thread</button>',
        '<button class="thread-menu-action" type="button" data-menu-action="bin-current">Move this thread to bin</button>'
      );
    } else if (openScope === "archive") {
      parts.push(
        '<button class="thread-menu-action" type="button" data-menu-action="return-current">Return this thread to the active list</button>'
      );
    }
  }
  if (archiveList.length) {
    parts.push('<button class="thread-menu-action" type="button" data-menu-scope="archive">Archived</button>');
  }
  if (binList.length) {
    parts.push('<button class="thread-menu-action" type="button" data-menu-scope="bin">Bin</button>');
  }
  if (!parts.length) return "";
  return `<div class="thread-menu-footer">${parts.join("")}</div>`;
}

function renderThreadMenuScope(scope) {
  const list = scope === "archive" ? archiveList : binList;
  const head = `
    <div class="thread-menu-head">
      <button class="thread-menu-action" type="button" data-menu-scope="active">‹ Threads</button>
      <span class="thread-menu-head-label">${scope === "archive" ? "Archived" : "Bin"}</span>
    </div>`;

  const rows = list.length
    ? list
        .map((thread) => {
          const name = escapeHtml(thread.name || "Untitled thread");
          const when = escapeHtml(formatTime(thread.updatedAt));
          if (scope === "archive") {
            return `
              <div class="thread-menu-row thread-menu-row--split">
                <button class="thread-menu-row-open" type="button" data-thread-id="${escapeHtml(thread.id)}">
                  <span class="thread-menu-row-name">${name}</span>
                  <span class="thread-menu-row-time">${when}</span>
                </button>
                <button class="thread-menu-row-action" type="button" data-menu-restore="${escapeHtml(thread.id)}">Return</button>
              </div>`;
          }
          return `
            <div class="thread-menu-row thread-menu-row--split is-binned">
              <span class="thread-menu-row-name">${name}</span>
              <button class="thread-menu-row-action" type="button" data-menu-restore="${escapeHtml(thread.id)}">Restore</button>
            </div>`;
        })
        .join("")
    : `<p class="thread-menu-empty">${scope === "archive" ? "Nothing archived." : "The bin is empty."}</p>`;

  const footer =
    scope === "bin" && binList.length
      ? `<div class="thread-menu-footer">
          <button class="thread-menu-action" type="button" data-menu-action="empty-bin">${
            binConfirm ? "Really empty the bin? Yes, empty it" : "Empty bin"
          }</button>
          ${binConfirm ? '<button class="thread-menu-action" type="button" data-menu-action="keep-bin">Keep everything</button>' : ""}
        </div>`
      : "";

  elements.threadMenu.innerHTML = head + rows + footer;
}

// Open a saved thread, saving the current one in its present state first.
async function openThreadById(id) {
  if (!id || id === state.threadId) {
    closeThreadMenu();
    return;
  }
  closeThreadMenu();
  await flushPersistImmediate();
  try {
    const thread = await storage.loadThread(id);
    hydrate(thread);
    setStatus(`Opened · ${formatTime(thread.updatedAt)}`);
    render();
    renderThreadMenu();
  } catch (err) {
    console.warn("[filum] open failed:", err);
    setStatus("Could not open thread");
  }
}

// ---- Thread lifecycle: archive / bin ---------------------------------------

async function archiveCurrentThread() {
  if (!state.threadId) return;
  closeThreadMenu();
  await flushPersistImmediate();
  if (isDirty || threadMissing) {
    // The pre-move save did not land; moving now would archive a stale file.
    setStatus("Could not save before archiving");
    return;
  }
  try {
    await storage.moveThread(state.threadId, "archive");
    setStatus("Thread archived");
    await openMostRecentOrNew();
  } catch (err) {
    console.warn("[filum] archive failed:", err);
    setStatus("Could not archive this thread");
  }
}

async function binCurrentThread() {
  if (!state.threadId) return;
  closeThreadMenu();
  await flushPersistImmediate();
  if (threadMissing) return; // already gone from disk; nothing to bin
  if (isDirty) {
    setStatus("Could not save before moving to the bin");
    return;
  }
  try {
    await storage.moveThread(state.threadId, "bin");
    setStatus("Thread moved to bin");
    await openMostRecentOrNew();
  } catch (err) {
    console.warn("[filum] bin failed:", err);
    setStatus("Could not move this thread to the bin");
  }
}

// ---- Inline rename ----------------------------------------------------------

function startRename() {
  if (!elements.threadNameInput) return;
  closeThreadMenu();
  elements.threadNameInput.value = state.threadName || "";
  elements.threadNameInput.hidden = false;
  if (elements.threadMenuButton) elements.threadMenuButton.hidden = true;
  elements.threadNameInput.focus();
  elements.threadNameInput.select();
}

async function commitRename() {
  if (!elements.threadNameInput || elements.threadNameInput.hidden) return;
  const trimmed = elements.threadNameInput.value.trim() || "Untitled thread";
  hideRenameInput(); // hide first so the resulting blur is a no-op
  state.threadName = trimmed;
  if (elements.threadMenuLabel) elements.threadMenuLabel.textContent = trimmed;
  await flushPersistImmediate();
  await refreshThreadList();
  setStatus(`Saved as “${trimmed}”`);
}

function cancelRename() {
  hideRenameInput();
}

function hideRenameInput() {
  if (!elements.threadNameInput) return;
  elements.threadNameInput.hidden = true;
  if (elements.threadMenuButton) elements.threadMenuButton.hidden = false;
}

async function handleNewThread() {
  await flushPersistImmediate(); // autosave already persists; save current silently
  try {
    const thread = await storage.createThread("Untitled thread", emptyStateObject());
    hydrate(thread);
    await refreshThreadList();
    setStatus("New thread started");
    render();
  } catch (err) {
    console.warn("[filum] create failed:", err);
    setStatus("Could not start a new thread");
  }
}

async function refreshThreadList() {
  try {
    const [active, archived, binned] = await Promise.all([
      storage.listThreads("active"),
      storage.listThreads("archive"),
      storage.listThreads("bin"),
    ]);
    threadList = active;
    archiveList = archived;
    binList = binned;
    isOffline = false;
  } catch (err) {
    console.warn("[filum] list failed:", err);
    isOffline = true;
  }
  renderThreadMenu();
}

// ---- Persistence ------------------------------------------------------------

function markDirty() {
  isDirty = true;
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersistImmediate, PERSIST_DEBOUNCE_MS);
}

async function flushPersistImmediate() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  // The file was removed on disk. Keep the on-screen copy, never rewrite it —
  // the thread menu and "Start new thread" are the ways forward.
  if (threadMissing) return;
  if (!state.threadId) {
    saveOfflineMirror();
    return;
  }
  const thread = {
    id: state.threadId,
    name: state.threadName,
    state: { tasks: state.tasks, currentStep: state.currentStep, focusIndex: state.focusIndex },
  };
  try {
    const saved = await storage.saveThread(thread);
    isDirty = false;
    if (isOffline) {
      isOffline = false;
    }
    setStatus(`Saved · ${formatTime(saved.updatedAt)}`);
  } catch (err) {
    if (err.gone) {
      threadMissing = true;
      console.warn("[filum] thread file is gone; keeping the on-screen copy:", err);
      setStatus("This thread was removed from disk");
      return;
    }
    console.warn("[filum] save failed, mirroring locally:", err);
    isOffline = true;
    saveOfflineMirror();
    setStatus(`Working offline — local copy at ${formatTime(new Date().toISOString())}`);
  }
}

function flushPersistOnUnload() {
  if (threadMissing) return; // deliberately deleted — do not resurrect on close
  // Nothing unsaved: stay silent. An unawaited keepalive PUT can land late —
  // after an archive/bin move — and rewrite the moved file with stale state,
  // so it must only ever fire when it actually has something to say.
  if (!isDirty) return;
  if (!state.threadId) {
    saveOfflineMirror();
    return;
  }
  saveOfflineMirror();
  const body = JSON.stringify({
    name: state.threadName,
    state: { tasks: state.tasks, currentStep: state.currentStep, focusIndex: state.focusIndex },
  });
  // keepalive PUT is the reliable cross-browser path for unload writes.
  try {
    fetch(`/api/threads/${encodeURIComponent(state.threadId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore — the localStorage mirror above is the safety net.
  }
}

function saveOfflineMirror() {
  try {
    localStorage.setItem(
      LOCAL_MIRROR_KEY,
      JSON.stringify({
        threadId: state.threadId,
        threadName: state.threadName,
        tasks: state.tasks,
        currentStep: state.currentStep,
        focusIndex: state.focusIndex,
        mirroredAt: new Date().toISOString(),
      })
    );
  } catch {
    // storage may be full or disabled; ignore quietly
  }
}

function loadOfflineMirror() {
  try {
    const raw = localStorage.getItem(LOCAL_MIRROR_KEY);
    if (!raw) return { id: null, name: "Untitled thread", state: emptyStateObject() };
    const parsed = JSON.parse(raw);
    return {
      id: parsed.threadId || null,
      name: parsed.threadName || "Untitled thread",
      state: {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        currentStep: parsed.currentStep || DEFAULT_STEP,
        focusIndex: parsed.focusIndex || 0,
      },
    };
  } catch {
    return { id: null, name: "Untitled thread", state: emptyStateObject() };
  }
}

function setStatus(text) {
  if (!elements.threadStatus) return;
  elements.threadStatus.textContent = text;
}

function formatTime(iso) {
  if (!iso) return "just now";
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "just now";
  }
}

// ---- Render loop -------------------------------------------------------------

function render() {
  normalizeFocus();
  renderStepState();
  renderTaskPreview();
  renderCaptureAttachments();
  renderPlanningList();
  renderVisuals();
  renderLine();
  renderHeaderControls();
  bindInlineEditor();
  if (elements.threadMenuLabel) {
    elements.threadMenuLabel.textContent = state.threadName || "Untitled thread";
  }
}

function renderStepState() {
  const activeStep = state.currentStep || DEFAULT_STEP;

  elements.stepButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.stepTarget === activeStep);
  });

  elements.panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.step === activeStep);
  });
}

function renderHeaderControls() {
  const hasTasks = state.tasks.length > 0;
  if (elements.findPlanButton) elements.findPlanButton.hidden = !hasTasks;
  if (elements.findLineButton) elements.findLineButton.hidden = !hasTasks;
}

function renderTaskPreview() {
  const visible = visibleTasks();
  const count = visible.length;
  elements.taskCount.textContent = `${count} task${count === 1 ? "" : "s"}`;

  if (!count) {
    elements.taskPreviewList.innerHTML =
      '<div class="empty-state empty-state--soft">Start with a simple task name. Add details only when they help.</div>';
    return;
  }

  const recent = visible.slice(-3).reverse();
  const overflow = count - recent.length;
  const chips = recent
    .map((task) => {
      if (editingTaskId === task.id && state.currentStep === "capture") {
        return `<article class="task-chip task-chip--editing">${renderInlineEditor(task)}</article>`;
      }
      return `
        <article class="task-chip">
          <div class="task-chip-head">
            <strong>${escapeHtml(task.title)}</strong>
            <button class="ghost-button mini-edit" type="button" data-edit-task="${task.id}">Edit</button>
          </div>
          <p>${linkify(summarizeTask(task))}</p>
          ${renderThumbStrip(task.images)}
        </article>
      `;
    })
    .join("");
  const more = overflow > 0 ? `<div class="task-chip-more">+${overflow} earlier</div>` : "";

  elements.taskPreviewList.innerHTML = chips + more;
}

// The capture form's own attachment tray (images staged for the next task).
function renderCaptureAttachments() {
  renderEditableTray(elements.captureAttachments, captureImages, (id) => {
    captureImages = captureImages.filter((img) => img.id !== id);
    renderCaptureAttachments();
  });
}

// Step 1 preview: a tangled thread that knots tighter as tasks are added.
function renderMiniThread() {
  const svg = elements.miniThreadSvg;
  if (!svg) return;
  const tasks = visibleTasks();
  const count = tasks.length;
  const width = 220;
  const height = 180;

  const a11y = `
    <title id="miniThreadTitle">A small preview of your knot</title>
    <desc id="miniThreadDesc">${
      count === 0
        ? "No tasks gathered yet."
        : `A thread tangled by ${count} task${count === 1 ? "" : "s"}; it knots further as you add more.`
    }</desc>`;

  if (!count) {
    svg.innerHTML =
      a11y +
      '<text x="110" y="92" text-anchor="middle" font-family="Iowan Old Style, Palatino, Georgia, serif" font-size="13" fill="rgba(110,103,92,0.6)">a quiet thread</text>';
    return;
  }

  const points = tangleScatter(tasks, width, height, 28);
  // Knot density rises with count but is capped so the preview stays legible.
  const knot = Math.min(1, 0.5 + count * 0.06);
  const d = knottedPath(points, knot, 0.3);
  const lastIndex = count - 1;

  const dots = points
    .map((point, index) => {
      const isNew = index === lastIndex;
      const r = isNew ? 5 : 4;
      const cls = isNew ? "mini-node mini-node--enter" : "mini-node";
      return `<circle class="${cls}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${r}" />`;
    })
    .join("");

  svg.innerHTML = `
    ${a11y}
    <g class="mini-thread-line">
      <path d="${d}" fill="none" stroke="var(--line-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </g>
    ${dots}
  `;
}

function renderPlanningList() {
  const visible = visibleTasks();
  if (!visible.length) {
    elements.planningList.innerHTML =
      '<div class="empty-state">Your ordered thread will appear here once tasks are added.</div>';
    return;
  }

  elements.planningList.innerHTML = visible
    .map((task, index) => {
      if (editingTaskId === task.id && state.currentStep === "plan") {
        return `<article class="plan-item plan-item--editing" data-task-id="${task.id}">${renderInlineEditor(task)}</article>`;
      }
      return `
        <article class="plan-item" data-task-id="${task.id}">
          <button class="drag-handle" type="button" tabindex="-1" aria-hidden="true"></button>
          <div class="plan-item-head">
            <div>
              <strong>${index + 1}. ${escapeHtml(task.title)}</strong>
              <p>${linkify(summarizeTask(task))}</p>
              ${renderThumbStrip(task.images)}
            </div>
            <div class="plan-controls">
              <button class="ghost-button mini-edit" type="button" data-edit aria-label="Edit task">Edit</button>
              <button class="mini-button" type="button" data-move="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
              <button class="mini-button" type="button" data-move="down" ${index === visible.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  elements.planningList.querySelectorAll(".plan-item").forEach((item) => {
    // The item being edited shows the inline editor; bindInlineEditor wires it.
    if (item.classList.contains("plan-item--editing")) return;
    const taskId = item.dataset.taskId;
    const edit = item.querySelector("[data-edit]");
    const up = item.querySelector('[data-move="up"]');
    const down = item.querySelector('[data-move="down"]');
    if (edit) edit.addEventListener("click", () => startEdit(taskId));
    if (up) up.addEventListener("click", () => moveTask(taskId, -1));
    if (down) down.addEventListener("click", () => moveTask(taskId, 1));
  });
}

// Move a task one step among its visible neighbours (the up/down buttons).
function moveTask(taskId, direction) {
  const visible = visibleTasks();
  const from = visible.findIndex((task) => task.id === taskId);
  if (from < 0) return;
  const to = from + direction;
  if (to < 0 || to >= visible.length) return;
  moveTaskToVisibleIndex(taskId, to);
}

// Reorder within the visible sequence while completed knots keep their places
// in the underlying array. Focus follows the focused task by id — no index math.
function moveTaskToVisibleIndex(taskId, newVisibleIndex) {
  const from = state.tasks.findIndex((task) => task.id === taskId);
  if (from < 0) return;
  const focusedId = state.tasks[state.focusIndex] ? state.tasks[state.focusIndex].id : null;
  const [task] = state.tasks.splice(from, 1);
  const visibleAfter = state.tasks.filter((entry) => !entry.done);
  const clamped = Math.max(0, Math.min(newVisibleIndex, visibleAfter.length));
  const insertAt =
    clamped >= visibleAfter.length ? state.tasks.length : state.tasks.indexOf(visibleAfter[clamped]);
  state.tasks.splice(insertAt, 0, task);
  if (focusedId) {
    const fi = state.tasks.findIndex((entry) => entry.id === focusedId);
    if (fi >= 0) state.focusIndex = fi;
  }
  normalizeFocus();
  markDirty();
  renderPlanningList();
  renderVisuals();
  renderLine();
  bindInlineEditor();
}

// ---- Step 2 drag reordering -------------------------------------------------
//
// Pointer-event drag on the handle only; the up/down buttons remain as the
// keyboard path. The dragged card slides slot to slot (FLIP, 180ms) rather
// than gliding pixel-for-pixel — calmer, and honest about what reordering is.
function bindPlanDrag() {
  const list = elements.planningList;
  if (!list) return;
  let drag = null;

  const flipMove = (items, mutate) => {
    if (prefersReducedMotion) {
      mutate();
      return;
    }
    const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
    mutate();
    for (const el of items) {
      const delta = before.get(el) - el.getBoundingClientRect().top;
      if (!delta) continue;
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
    }
    requestAnimationFrame(() => {
      for (const el of items) {
        el.style.transition = "transform 180ms ease";
        el.style.transform = "";
      }
    });
  };

  list.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".drag-handle");
    if (!handle || editingTaskId !== null) return;
    const item = handle.closest(".plan-item");
    if (!item) return;
    event.preventDefault();
    drag = { item, taskId: item.dataset.taskId, startY: event.clientY, engaged: false, pointerId: event.pointerId };
    handle.setPointerCapture(event.pointerId);
  });

  list.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.engaged) {
      if (Math.abs(event.clientY - drag.startY) < 6) return;
      drag.engaged = true;
      drag.item.classList.add("is-dragging");
      document.body.classList.add("is-plan-dragging");
    }
    const items = Array.from(list.querySelectorAll(".plan-item"));
    let insertBefore = null;
    for (const el of items) {
      if (el === drag.item) continue;
      const rect = el.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        insertBefore = el;
        break;
      }
    }
    if (insertBefore === drag.item.nextElementSibling) return; // already there
    flipMove(items, () => list.insertBefore(drag.item, insertBefore));
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { item, taskId, engaged } = drag;
    drag = null;
    item.classList.remove("is-dragging");
    document.body.classList.remove("is-plan-dragging");
    if (!engaged) return;
    const items = Array.from(list.querySelectorAll(".plan-item"));
    moveTaskToVisibleIndex(taskId, items.indexOf(item));
  };
  list.addEventListener("pointerup", endDrag);
  list.addEventListener("pointercancel", endDrag);
}

function renderVisuals() {
  renderMiniThread();
  renderLineThread();
}

function renderLine() {
  normalizeFocus();
  const all = state.tasks;
  const visible = visibleTasks();
  const doneCount = all.length - visible.length;
  const allDone = all.length > 0 && visible.length === 0;
  const focused = all[state.focusIndex];
  const currentTask = focused && !focused.done ? focused : null;
  const editingHere = !!(currentTask && editingTaskId === currentTask.id && state.currentStep === "line");

  // The editor renders in place of the read-only "Do this now" content.
  if (elements.focusEditor) {
    elements.focusEditor.innerHTML = editingHere ? renderInlineEditor(currentTask, "focus") : "";
    elements.focusEditor.hidden = !editingHere;
  }
  [elements.focusTitle, elements.focusNotes, elements.focusAttachments].forEach((el) => {
    if (el) el.hidden = editingHere;
  });

  if (elements.retrospectButton) {
    elements.retrospectButton.hidden = doneCount === 0;
    elements.retrospectButton.classList.toggle("is-active", retrospectOn);
    elements.retrospectButton.setAttribute("aria-pressed", retrospectOn ? "true" : "false");
  }
  if (elements.focusArchiveButton) {
    elements.focusArchiveButton.hidden = !allDone || openScope !== "active";
  }

  const showTaskActions = !!currentTask && !editingHere;
  if (elements.focusEditButton) elements.focusEditButton.hidden = !showTaskActions;
  if (elements.focusDoneButton) elements.focusDoneButton.hidden = !showTaskActions;

  if (editingHere) {
    // read view hidden; the editor carries the card
  } else if (!all.length) {
    elements.focusTitle.textContent = "This thread is empty";
    elements.focusNotes.innerHTML =
      '<span class="focus-notes-empty">Gather a few thoughts in Step 1 first.</span>';
  } else if (allDone) {
    elements.focusTitle.textContent = "The thread is clear.";
    elements.focusNotes.innerHTML =
      '<span class="focus-notes-empty">Every knot on this thread is loose.</span>';
  } else if (currentTask) {
    elements.focusTitle.textContent = currentTask.title;
    elements.focusNotes.innerHTML = currentTask.notes
      ? renderRichNotes(currentTask.notes)
      : '<span class="focus-notes-empty">No extra notes. Just begin.</span>';
  }
  renderReadonlyTray(elements.focusAttachments, currentTask && !editingHere ? currentTask.images : []);

  const visiblePos = currentTask ? visible.findIndex((task) => task.id === currentTask.id) : -1;
  if (elements.focusPrevButton) {
    elements.focusPrevButton.disabled = visiblePos <= 0;
  }
  if (elements.focusNextButton) {
    elements.focusNextButton.disabled = visiblePos < 0 || visiblePos >= visible.length - 1;
  }

  if (!all.length) {
    elements.linearList.innerHTML =
      '<div class="empty-state">Once you have a sequence, the thread will appear here.</div>';
    return;
  }

  const shown = retrospectOn ? all : visible;
  if (!shown.length) {
    elements.linearList.innerHTML = "";
    return;
  }

  elements.linearList.innerHTML = shown
    .map((task, index) => {
      if (task.done) {
        const when = task.completedAt ? ` · ${formatTime(task.completedAt)}` : "";
        return `
          <article class="linear-item is-done" data-task-id="${task.id}">
            <div class="linear-item-index">Step ${index + 1}</div>
            <strong>${escapeHtml(task.title)}</strong>
            <p>done${escapeHtml(when)}</p>
            <button class="ghost-button mini-edit linear-restore" type="button" data-restore-task="${task.id}">Return to thread</button>
          </article>
        `;
      }
      const isCurrent = currentTask && task.id === currentTask.id;
      return `
        <article class="linear-item ${isCurrent ? "is-current" : "is-muted"}"
          data-task-id="${task.id}"
          role="button"
          tabindex="0"
          ${isCurrent ? 'aria-current="step"' : ""}>
          <div class="linear-item-index">Step ${index + 1}</div>
          <strong>${escapeHtml(task.title)}</strong>
          <p>${escapeHtml(lineCardSubtitle(task))}</p>
        </article>
      `;
    })
    .join("");
}

// Shared geometry for the Step 3 thread. The curve loosens as knots complete:
// its sway scales with the share of tasks still open, so finishing work is
// visible as the line physically relaxing toward straight.
function lineThreadLayout(count) {
  const svg = elements.lineSvg;
  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const startX = 70;
  const endX = width - 70;
  const midY = 80;
  const stepX = count <= 1 ? 0 : (endX - startX) / (count - 1);
  return { width, height, startX, endX, midY, stepX };
}

function lineThreadPath(layout) {
  const all = state.tasks;
  const doneCount = all.filter((task) => task.done).length;
  const sway = all.length ? 16 * (1 - doneCount / all.length) : 16;
  const { width, startX, endX, midY } = layout;
  return `M ${startX} ${midY} C ${width * 0.3} ${midY - sway}, ${width * 0.65} ${midY + sway}, ${endX} ${midY}`;
}

function lineThreadDot(task, x, midY, isCurrent) {
  if (task.done) {
    return `<circle data-task-id="${task.id}" cx="${x}" cy="${midY}" r="6" fill="none" stroke="rgba(22,22,22,0.55)" stroke-width="2" />`;
  }
  return `<circle data-task-id="${task.id}" class="line-dot" cx="${x}" cy="${midY}" r="${isCurrent ? 10 : 7}" fill="#111111" />`;
}

function renderLineThread() {
  const svg = elements.lineSvg;
  if (!svg) return;
  const all = state.tasks;
  if (!all.length) {
    svg.innerHTML =
      '<title id="lineTitle">An empty thread</title><desc id="lineDesc">No tasks ordered yet.</desc>';
    return;
  }

  const shown = retrospectOn ? all : visibleTasks();
  const layout = lineThreadLayout(shown.length);
  const path = `
    <path d="${lineThreadPath(layout)}" fill="none" stroke="rgba(18,18,18,0.86)" stroke-width="3" stroke-linecap="round" />`;

  if (!shown.length) {
    // Every knot loose, retrospect off: a quiet straight line, nothing else.
    svg.innerHTML = `
      <title id="lineTitle">A loose thread</title>
      <desc id="lineDesc">Every knot on this thread is complete.</desc>
      ${path}`;
    return;
  }

  const currentId = state.tasks[state.focusIndex] ? state.tasks[state.focusIndex].id : null;
  const a11y = `
    <title id="lineTitle">A clear thread of ${shown.length} step${shown.length === 1 ? "" : "s"}</title>
    <desc id="lineDesc">Each dot is one task in the chosen order. The current focus is the larger dot. Completed knots appear hollow when looking back.</desc>
  `;

  const dots = shown
    .map((task, index) => {
      const x = layout.startX + layout.stepX * index;
      const isCurrent = task.id === currentId && !task.done;
      const number = `
        <text x="${x}" y="${layout.midY - 22}" text-anchor="middle" font-family="Avenir Next, Segoe UI, sans-serif" font-size="11" fill="rgba(22,22,22,0.5)">${index + 1}</text>`;
      return lineThreadDot(task, x, layout.midY, isCurrent) + number;
    })
    .join("");

  svg.innerHTML = `${a11y}${path}${dots}`;
}

// Retrospect entrance: completed knots return as particles binding back into
// dots on the thread, staggered, ~360ms each. Reduced motion skips straight
// to the settled render.
function playRetrospect() {
  const svg = elements.lineSvg;
  const all = state.tasks;
  const done = all.map((task, index) => ({ task, index })).filter((entry) => entry.task.done);
  if (!svg || prefersReducedMotion || !done.length) {
    renderLineThread();
    return;
  }

  const token = ++untangleToken;
  const layout = lineThreadLayout(all.length);
  const scatter = tangleScatter(all, layout.width, layout.height, 26);
  const currentId = all[state.focusIndex] ? all[state.focusIndex].id : null;
  const DURATION = 360;
  const STAGGER = 70;
  const total = DURATION + STAGGER * (done.length - 1);
  const begin = performance.now();

  const base = () => {
    const path = `
      <path d="${lineThreadPath(layout)}" fill="none" stroke="rgba(18,18,18,0.86)" stroke-width="3" stroke-linecap="round" />`;
    const dots = all
      .map((task, index) => {
        if (task.done) return ""; // arriving via particles
        const x = layout.startX + layout.stepX * index;
        return lineThreadDot(task, x, layout.midY, task.id === currentId);
      })
      .join("");
    return path + dots;
  };

  const frame = (now) => {
    if (token !== untangleToken || !retrospectOn) return;
    const elapsed = now - begin;
    let overlay = "";
    done.forEach((entry, order) => {
      const local = clamp((elapsed - order * STAGGER) / DURATION, 0, 1);
      const t = easeInOutCubic(local);
      const target = {
        x: layout.startX + layout.stepX * entry.index,
        y: layout.midY,
      };
      const rand = seededRand(`${entry.task.id}-retro`);
      for (let p = 0; p < 5; p += 1) {
        const sx = scatter[entry.index].x + (rand() - 0.5) * 64;
        const sy = scatter[entry.index].y + (rand() - 0.5) * 48;
        const x = sx + (target.x - sx) * t;
        const y = sy + (target.y - sy) * t;
        overlay += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" fill="rgba(22,22,22,${(0.2 + 0.5 * t).toFixed(2)})" />`;
      }
      if (local >= 1) {
        overlay += `<circle cx="${target.x}" cy="${target.y}" r="6" fill="none" stroke="rgba(22,22,22,0.55)" stroke-width="2" />`;
      }
    });
    svg.innerHTML = base() + overlay;
    if (elapsed < total) {
      requestAnimationFrame(frame);
    } else {
      renderLineThread(); // settle into the full retrospect thread
    }
  };

  // Draw the particle-free base immediately so the settled dots never flash
  // in for a frame before the bind-back begins.
  svg.innerHTML = base();
  requestAnimationFrame(frame);
}

function seededRand(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

// Deterministic scatter of one point per task, used by the Step 1 preview and
// the untangle animation. Same task ids always land in the same place.
function tangleScatter(tasks, width, height, pad) {
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.3;

  return tasks.map((task, i) => {
    const rand = seededRand((task && task.id) || `task-${i}`);
    const angle = i * 1.82 + rand() * Math.PI * 2;
    const radius = baseRadius + ((i % 5) - 2) * (baseRadius * 0.18) + rand() * (baseRadius * 0.3);
    const x = centerX + Math.cos(angle) * radius + Math.sin(i * 0.7 + rand()) * (width * 0.08);
    const y = centerY + Math.sin(angle * 1.12) * (radius * 0.7) + Math.cos(i * 0.52 + rand()) * (height * 0.1);
    return {
      x: clamp(x, pad, width - pad),
      y: clamp(y, pad, height - pad),
    };
  });
}

// A single smooth path through `points`. `knot` (0..1) scales the loop overshoot
// of each segment — 1 is a heavy tangle, 0 is a clean line. `amp` scales the
// overshoot to the canvas size.
function knottedPath(points, knot, amp) {
  const scale = typeof amp === "number" ? amp : 1;
  if (!points.length) return "";
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    const k = knot * scale;
    const c1x = (prev.x + point.x) / 2 + Math.sin(i * 1.4) * 82 * k;
    const c1y = prev.y + Math.cos(i * 0.8) * 58 * k;
    const c2x = (prev.x + point.x) / 2 + Math.cos(i * 1.1) * -76 * k;
    const c2y = point.y + Math.sin(i * 1.2) * 52 * k;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }
  return d;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function summarizeTask(task) {
  return task.notes ? truncate(task.notes, 140) : "No notes yet";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegex(value) {
  return String(value == null ? "" : value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(text, max) {
  const clean = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---- Rich notes -------------------------------------------------------------
//
// Notes are stored as plain text, always. Rendering is an ordered transform
// where every user character passes through escapeHtml exactly once and all
// tags come from our own templates — nothing typed is ever interpreted as
// HTML. The subset is closed: fenced code, `- ` bullets, `inline code`,
// **bold**, *italic*, __underline__, bare-URL links, and alias-prefixed note
// lines (the violet exception — see design.md's drift log).

// Bare URLs -> anchors on already-truncated plain summaries (chips, plan
// items). Marks are deliberately not rendered there: truncation could split a
// pair. The full parser below handles the focus card.
function linkify(text) {
  const raw = String(text == null ? "" : text);
  let out = "";
  let lastIndex = 0;
  URL_PATTERN.lastIndex = 0;
  let match;
  while ((match = URL_PATTERN.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(lastIndex, match.index));
    const urlText = match[0];
    const href = urlText.startsWith("www.") ? `https://${urlText}` : urlText;
    out += `<a class="rich-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(urlText)}</a>`;
    lastIndex = match.index + urlText.length;
  }
  out += escapeHtml(raw.slice(lastIndex));
  return out;
}

// Inline pass: extract code spans and URLs from the raw text into placeholder
// tokens, escape the remainder, apply the marks on escaped text, substitute
// the tokens back. Unmatched markers stay literal — safe by construction.
function inlineMarkup(raw) {
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return `\x00${tokens.length - 1}\x00`;
  };

  let work = String(raw == null ? "" : raw);
  work = work.replace(/`([^`\n]+)`/g, (m, body) =>
    stash(`<code class="note-code-inline">${escapeHtml(body)}</code>`)
  );
  work = work.replace(URL_PATTERN, (urlText) => {
    const href = urlText.startsWith("www.") ? `https://${urlText}` : urlText;
    return stash(
      `<a class="rich-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(urlText)}</a>`
    );
  });

  let out = escapeHtml(work);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/__([^_]+)__/g, "<u>$1</u>");
  return out.replace(/\x00(\d+)\x00/g, (m, i) => tokens[Number(i)]);
}

function renderNoteLine(line) {
  const html = inlineMarkup(line);
  return noteLabelRegex && noteLabelRegex.test(line)
    ? `<span class="note-line">${html}</span>`
    : html;
}

function renderRichNotes(notes) {
  const raw = String(notes == null ? "" : notes).replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const blocks = [];
  let plainRun = [];
  let listRun = [];
  let fenceRun = null;

  const flushPlain = () => {
    if (plainRun.length) {
      blocks.push(plainRun.map(renderNoteLine).join("<br />"));
      plainRun = [];
    }
  };
  const flushList = () => {
    if (listRun.length) {
      blocks.push(
        `<ul class="note-list">${listRun.map((item) => `<li>${inlineMarkup(item)}</li>`).join("")}</ul>`
      );
      listRun = [];
    }
  };

  for (const line of lines) {
    if (fenceRun) {
      if (line.trim().startsWith("```")) {
        blocks.push(`<pre class="note-code">${escapeHtml(fenceRun.join("\n"))}</pre>`);
        fenceRun = null;
      } else {
        fenceRun.push(line);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushPlain();
      flushList();
      fenceRun = [];
      continue;
    }
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch) {
      flushPlain();
      listRun.push(listMatch[1]);
      continue;
    }
    flushList();
    plainRun.push(line);
  }
  if (fenceRun) {
    // Unclosed fence: render what is there rather than losing it.
    blocks.push(`<pre class="note-code">${escapeHtml(fenceRun.join("\n"))}</pre>`);
  }
  flushPlain();
  flushList();
  return blocks.join("");
}

function renderThumbStrip(images) {
  if (!Array.isArray(images) || !images.length) return "";
  const thumbs = images
    .slice(0, 4)
    .map(
      (img) =>
        `<img class="thumb thumb--xs" src="${escapeHtml(img.src)}" alt="${escapeHtml(
          img.alt || "reference image"
        )}" loading="lazy" />`
    )
    .join("");
  const more = images.length > 4 ? `<span class="thumb-more">+${images.length - 4}</span>` : "";
  return `<div class="thumb-strip">${thumbs}${more}</div>`;
}

// Editable tray (capture form + inline editor): thumbnails with a remove button.
function renderEditableTray(container, images, onRemove) {
  if (!container) return;
  if (!Array.isArray(images) || !images.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = images
    .map(
      (img) => `
        <div class="attachment" data-img-id="${img.id}">
          <img class="thumb" src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || "reference image")}" />
          <button class="thumb-remove" type="button" data-remove-img="${img.id}" aria-label="Remove image">×</button>
        </div>`
    )
    .join("");
  container.querySelectorAll("[data-remove-img]").forEach((btn) => {
    btn.addEventListener("click", () => onRemove(btn.dataset.removeImg));
  });
}

// Read-only tray (focus card): thumbnails that open full size in a new tab.
function renderReadonlyTray(container, images) {
  if (!container) return;
  if (!Array.isArray(images) || !images.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = images
    .map(
      (img) => `
        <a class="attachment-link" href="${escapeHtml(img.src)}" target="_blank" rel="noopener noreferrer">
          <img class="thumb thumb--lg" src="${escapeHtml(img.src)}" alt="${escapeHtml(
            img.alt || "reference image"
          )}" loading="lazy" />
        </a>`
    )
    .join("");
}

// Step 3 card subtitle: the start of the notes, or a quiet placeholder.
function lineCardSubtitle(task) {
  if (task.notes && task.notes.trim()) return truncate(task.notes, 70);
  return "No details yet";
}

// ---- Image attachment plumbing ------------------------------------------

function bindCaptureImages() {
  if (elements.captureAddImageButton && elements.captureImageInput) {
    elements.captureAddImageButton.addEventListener("click", () => elements.captureImageInput.click());
    elements.captureImageInput.addEventListener("change", async (event) => {
      await addFilesToImages(event.target.files, captureImages, renderCaptureAttachments);
      event.target.value = "";
    });
  }
  if (elements.taskNotes) {
    elements.taskNotes.addEventListener("paste", (event) =>
      handleImagePaste(event, captureImages, renderCaptureAttachments)
    );
  }
}

async function addFilesToImages(fileList, target, rerender) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  for (const file of files) {
    try {
      const src = await fileToDownscaledDataUrl(file);
      target.push({ id: crypto.randomUUID(), src, alt: file.name || "" });
    } catch (err) {
      console.warn("[filum] could not read image:", err);
    }
  }
  if (files.length) rerender();
}

function handleImagePaste(event, target, rerender) {
  const clip = event.clipboardData;
  if (!clip || !clip.items) return;
  const files = [];
  for (const item of clip.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length) return;
  // Keep the pasted image binary out of the plain-text field.
  event.preventDefault();
  addFilesToImages(files, target, rerender);
}

// Decode, downscale to a sane edge, and re-encode as a compact JPEG data URL so
// images stay small enough to live inside the thread's own JSON file.
function fileToDownscaledDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- In-place task editor -----------------------------------------------
//
// Editing happens on the task itself: the read view swaps for this form right
// where the task sits (Step 1 chip, Step 2 plan item, or Step 3 focus card).
// The focus-card variant is writing-first: a quiet title over a large notes
// area, because by Step 3 editing is mostly appending thought.

function renderInlineEditor(task, variant) {
  const isFocus = variant === "focus";
  return `
    <form class="inline-editor ${isFocus ? "inline-editor--focus" : ""}" data-editor novalidate>
      <label class="inline-field">
        <span${isFocus ? ' class="visually-hidden"' : ""}>Task</span>
        <input class="ie-title" type="text" maxlength="720" value="${escapeHtml(task.title)}" required />
      </label>
      <label class="inline-field">
        <span${isFocus ? ' class="visually-hidden"' : ""}>Notes</span>
        <textarea class="ie-notes" rows="${isFocus ? 12 : 4}" maxlength="10000" placeholder="Context, links, references — drop it all here. Paste an image straight in.">${escapeHtml(task.notes)}</textarea>
      </label>
      <div class="inline-attach-row">
        <button type="button" class="ghost-button attach-button ie-add-image">Add image</button>
        <input type="file" class="ie-image-input visually-hidden" accept="image/*" multiple />
      </div>
      <div class="ie-attachments attachment-tray"></div>
      <div class="inline-actions">
        <button type="button" class="ghost-button danger-ghost ie-remove">Remove task</button>
        <span class="inline-actions-right">
          <button type="button" class="ghost-button ie-cancel">Cancel</button>
          <button type="submit" class="primary-button ie-save">Save</button>
        </span>
      </div>
    </form>
  `;
}

function startEdit(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  editingTaskId = taskId;
  editingImages = task.images.map((img) => ({ ...img }));
  render();
  // Step 3 editing lands in the notes body (writing-first); the Step 1 / 2
  // editors keep the title, which is usually what those edits are about.
  const form = document.querySelector(".inline-editor[data-editor]");
  if (!form) return;
  const target =
    state.currentStep === "line" ? form.querySelector(".ie-notes") : form.querySelector(".ie-title");
  if (target) {
    target.focus();
    const caret = target.value.length;
    target.setSelectionRange(caret, caret);
  }
}

function cancelEdit() {
  editingTaskId = null;
  editingImages = [];
  render();
}

function saveEdit(formEl) {
  const task = state.tasks.find((entry) => entry.id === editingTaskId);
  if (!task) {
    cancelEdit();
    return;
  }
  const titleInput = formEl.querySelector(".ie-title");
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }

  task.title = title;
  task.notes = formEl.querySelector(".ie-notes").value.trim();
  task.images = editingImages.map((img) => ({ ...img }));

  editingTaskId = null;
  editingImages = [];
  markDirty();
  render();
}

function removeEditingTask() {
  const index = state.tasks.findIndex((entry) => entry.id === editingTaskId);
  if (index < 0) {
    cancelEdit();
    return;
  }
  state.tasks.splice(index, 1);
  if (index < state.focusIndex) {
    state.focusIndex -= 1;
  }
  if (state.focusIndex >= state.tasks.length) {
    state.focusIndex = Math.max(0, state.tasks.length - 1);
  }
  if (!state.tasks.length) {
    state.currentStep = DEFAULT_STEP;
  }
  editingTaskId = null;
  editingImages = [];
  normalizeFocus();
  markDirty();
  render();
}

// Wire up whichever single inline editor is on the page now. Called at the end
// of every render(); there is at most one because of the step guards.
function bindInlineEditor() {
  const form = document.querySelector(".inline-editor[data-editor]");
  if (!form) return;
  // Each render rebuilds the form node; guard so a node is only wired once even
  // if bindInlineEditor runs more than once for the same render.
  if (form.dataset.bound === "1") return;
  form.dataset.bound = "1";

  const tray = form.querySelector(".ie-attachments");
  const renderTray = () => {
    renderEditableTray(tray, editingImages, (id) => {
      editingImages = editingImages.filter((img) => img.id !== id);
      renderTray();
    });
  };
  renderTray();

  const addBtn = form.querySelector(".ie-add-image");
  const fileInput = form.querySelector(".ie-image-input");
  if (addBtn && fileInput) {
    addBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (event) => {
      await addFilesToImages(event.target.files, editingImages, renderTray);
      event.target.value = "";
    });
  }

  const notes = form.querySelector(".ie-notes");
  if (notes) {
    notes.addEventListener("paste", (event) => handleImagePaste(event, editingImages, renderTray));
    bindMarkShortcuts(notes);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEdit(form);
  });
  form.querySelector(".ie-cancel").addEventListener("click", cancelEdit);
  form.querySelector(".ie-remove").addEventListener("click", removeEditingTask);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  });
}

// Cmd/Ctrl+B / I / U wrap the selection in the matching mark. The textarea
// stays a plain textarea — the marks render in the read views.
function bindMarkShortcuts(textarea) {
  textarea.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const mark = key === "b" ? "**" : key === "i" ? "*" : key === "u" ? "__" : null;
    if (!mark) return;
    event.preventDefault();
    wrapSelection(textarea, mark);
  });
}

function wrapSelection(textarea, mark) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  textarea.setRangeText(mark + selected + mark, start, end, "select");
  textarea.setSelectionRange(start + mark.length, end + mark.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---- Find within the thread -------------------------------------------------
//
// Hidden until invoked ("/" or Cmd/Ctrl+K, or the quiet Find buttons), so the
// empty state pays nothing. Fuzzy subsequence match by default; wrap the query
// in /slashes/ for a regular expression. Thread-scoped only — no actions, no
// command palette.

function openFind() {
  if (!elements.findBar || !state.tasks.length) return;
  findRestoreFocus = document.activeElement;
  findOpen = true;
  elements.findBar.hidden = false;
  elements.findInput.value = "";
  findResultsCache = [];
  findActiveIndex = 0;
  findInvalid = false;
  renderFindResults();
  elements.findInput.focus();
}

function closeFind() {
  if (!findOpen || !elements.findBar) return;
  findOpen = false;
  elements.findBar.hidden = true;
  if (findRestoreFocus && document.contains(findRestoreFocus)) findRestoreFocus.focus();
  findRestoreFocus = null;
}

function handleFindKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeFind();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (findResultsCache.length) {
      findActiveIndex = Math.min(findResultsCache.length - 1, findActiveIndex + 1);
      renderFindResults();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (findResultsCache.length) {
      findActiveIndex = Math.max(0, findActiveIndex - 1);
      renderFindResults();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    const active = findResultsCache[findActiveIndex];
    if (active) selectFindResult(active.task.id);
  }
}

function parseFindQuery(query) {
  const trimmed = query.trim();
  if (trimmed.length > 2 && trimmed.startsWith("/") && trimmed.endsWith("/")) {
    try {
      return { regex: new RegExp(trimmed.slice(1, -1), "i") };
    } catch {
      return { invalid: true };
    }
  }
  return { fuzzy: trimmed };
}

// Case-insensitive subsequence match with consecutive-run and word-start
// bonuses, length-normalized. Returns null when the query does not fit.
function fuzzyMatch(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return null;
  const t = String(text || "").toLowerCase();
  const positions = [];
  let qi = 0;
  let run = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      run += 1;
      const wordStart = ti === 0 || /[\s\-_.,:;([]/.test(t[ti - 1]);
      score += 1 + run * 0.6 + (wordStart ? 2 : 0);
      positions.push(ti);
      qi += 1;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return null;
  return { score: score / Math.sqrt(t.length + 1), positions };
}

function markMatched(text, positions) {
  const set = new Set(positions);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? `<mark class="find-hit">${ch}</mark>` : ch;
  }
  return out;
}

function regexSnippet(text, regex) {
  const m = String(text || "").match(regex);
  if (!m || m.index === undefined || !m[0]) return null;
  const start = Math.max(0, m.index - 40);
  const end = Math.min(text.length, m.index + m[0].length + 40);
  return (
    (start > 0 ? "…" : "") +
    escapeHtml(text.slice(start, m.index)) +
    `<mark class="find-hit">${escapeHtml(m[0])}</mark>` +
    escapeHtml(text.slice(m.index + m[0].length, end)) +
    (end < text.length ? "…" : "")
  );
}

function runFind() {
  const query = elements.findInput.value;
  const parsed = parseFindQuery(query);
  findInvalid = !!parsed.invalid;
  findActiveIndex = 0;
  findResultsCache = [];

  if (!findInvalid && query.trim()) {
    const pool = retrospectOn ? state.tasks : visibleTasks();
    for (const task of pool) {
      if (parsed.regex) {
        const titleSnippet = regexSnippet(task.title, parsed.regex);
        const notesSnippet = regexSnippet(task.notes, parsed.regex);
        if (titleSnippet || notesSnippet) {
          findResultsCache.push({
            task,
            score: titleSnippet ? 2 : 1,
            titleHtml: titleSnippet || escapeHtml(task.title),
            snippetHtml: titleSnippet ? "" : notesSnippet,
          });
        }
      } else {
        const titleHit = fuzzyMatch(parsed.fuzzy, task.title);
        const notesHit = fuzzyMatch(parsed.fuzzy, task.notes);
        if (!titleHit && !notesHit) continue;
        const titleScore = titleHit ? titleHit.score * 1.5 : 0;
        const notesScore = notesHit ? notesHit.score : 0;
        findResultsCache.push({
          task,
          score: Math.max(titleScore, notesScore),
          titleHtml: titleHit ? markMatched(task.title, titleHit.positions) : escapeHtml(task.title),
          snippetHtml: !titleHit && notesHit ? escapeHtml(truncate(task.notes, 90)) : "",
        });
      }
    }
    findResultsCache.sort((a, b) => b.score - a.score);
    findResultsCache = findResultsCache.slice(0, 8);
  }
  renderFindResults();
}

function renderFindResults() {
  const box = elements.findResults;
  if (!box) return;
  if (findInvalid) {
    box.innerHTML = '<p class="find-hint">That pattern did not parse. Plain words work too.</p>';
    return;
  }
  if (!elements.findInput.value.trim()) {
    box.innerHTML = "";
    return;
  }
  if (!findResultsCache.length) {
    box.innerHTML = '<p class="find-hint">No knots match.</p>';
    return;
  }
  box.innerHTML = findResultsCache
    .map(
      (result, index) => `
        <button class="find-result ${index === findActiveIndex ? "is-active" : ""}" type="button" role="option"
          data-task-id="${result.task.id}" ${index === findActiveIndex ? 'aria-selected="true"' : ""}>
          <span class="find-result-title">${result.titleHtml}</span>
          ${result.snippetHtml ? `<span class="find-result-snippet">${result.snippetHtml}</span>` : ""}
        </button>`
    )
    .join("");
}

function selectFindResult(taskId) {
  closeFind();
  if (state.currentStep === "line") {
    setFocusByTaskId(taskId);
    return;
  }
  if (state.currentStep === "capture") setStep("plan");
  const item = elements.planningList.querySelector(`.plan-item[data-task-id="${taskId}"]`);
  if (!item) return;
  item.scrollIntoView({ block: "center", behavior: prefersReducedMotion ? "auto" : "smooth" });
  item.classList.add("is-found");
  const clear = () => item.classList.remove("is-found");
  setTimeout(() => {
    document.addEventListener("pointerdown", clear, { once: true });
    document.addEventListener("keydown", clear, { once: true });
  }, 0);
}

// ---- Settings ----------------------------------------------------------------
//
// One settings file on disk (~/.filum/settings.json), mirrored to localStorage
// for offline starts. The surface is deliberately tiny: note-label aliases and
// their shade. New settings need a design.md check before they land here.

function defaultSettings() {
  return {
    schemaVersion: 1,
    noteAliases: ["note"],
    noteColor: NOTE_SHADES[0],
  };
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  if (Array.isArray(raw.noteAliases)) {
    const aliases = raw.noteAliases
      .filter((a) => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => /^[a-z0-9 _-]{1,24}$/i.test(a))
      .slice(0, 8);
    if (aliases.length) base.noteAliases = aliases;
  }
  if (typeof raw.noteColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.noteColor.trim())) {
    base.noteColor = raw.noteColor.trim().toLowerCase();
  }
  return base;
}

async function loadSettingsIntoApp() {
  try {
    appSettings = normalizeSettings(await storage.loadSettings());
    saveSettingsMirror();
  } catch (err) {
    console.warn("[filum] settings load failed, using local copy:", err);
    appSettings = normalizeSettings(loadSettingsMirror());
  }
  applySettings();
}

function applySettings() {
  document.documentElement.style.setProperty("--note-label", appSettings.noteColor);
  const aliases = appSettings.noteAliases.map(escapeRegex).filter(Boolean);
  noteLabelRegex = aliases.length ? new RegExp(`^\\s*(?:${aliases.join("|")})\\s*:`, "i") : null;
}

async function persistSettings() {
  applySettings();
  saveSettingsMirror();
  render();
  if (prefsOpen) renderPrefsPanel();
  try {
    appSettings = normalizeSettings(await storage.saveSettings(appSettings));
    setStatus("Preferences saved");
  } catch (err) {
    console.warn("[filum] settings save failed, keeping local copy:", err);
    setStatus("Preferences kept locally — server not reachable");
  }
}

function saveSettingsMirror() {
  try {
    localStorage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify(appSettings));
  } catch {
    // ignore quietly
  }
}

function loadSettingsMirror() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_MIRROR_KEY) || "null");
  } catch {
    return null;
  }
}

function togglePrefsPanel() {
  if (prefsOpen) closePrefsPanel();
  else openPrefsPanel();
}

function openPrefsPanel() {
  if (!elements.prefsPanel) return;
  prefsOpen = true;
  elements.prefsPanel.hidden = false;
  if (elements.prefsButton) elements.prefsButton.setAttribute("aria-expanded", "true");
  renderPrefsPanel();
  const first = elements.prefsPanel.querySelector("input");
  if (first) first.focus();
}

function closePrefsPanel() {
  if (!prefsOpen) return;
  prefsOpen = false;
  const hadFocusInside =
    elements.prefsPanel && elements.prefsPanel.contains(document.activeElement);
  if (elements.prefsPanel) elements.prefsPanel.hidden = true;
  if (elements.prefsButton) {
    elements.prefsButton.setAttribute("aria-expanded", "false");
    if (hadFocusInside) elements.prefsButton.focus();
  }
}

function renderPrefsPanel() {
  if (!elements.prefsPanel) return;
  elements.prefsPanel.innerHTML = `
    <div class="prefs-field">
      <label for="prefsAliases">Note keywords</label>
      <input id="prefsAliases" type="text" maxlength="120" autocomplete="off"
             value="${escapeHtml(appSettings.noteAliases.join(", "))}" />
      <small class="field-hint">A line starting with one of these words and a colon is tinted. Separate with commas.</small>
    </div>
    <div class="prefs-field">
      <span>Keyword shade</span>
      <div class="prefs-swatches">
        ${NOTE_SHADES.map(
          (hex) => `
            <button type="button" class="prefs-swatch ${hex === appSettings.noteColor ? "is-current" : ""}"
              data-shade="${hex}" style="--swatch:${hex}" aria-label="Use shade ${hex}"></button>`
        ).join("")}
        <input id="prefsColor" type="text" maxlength="7" autocomplete="off" aria-label="Keyword shade as hex"
               value="${escapeHtml(appSettings.noteColor)}" />
      </div>
    </div>`;
  bindPrefsPanel();
}

function bindPrefsPanel() {
  const aliasesInput = elements.prefsPanel.querySelector("#prefsAliases");
  const colorInput = elements.prefsPanel.querySelector("#prefsColor");

  if (aliasesInput) {
    aliasesInput.addEventListener("change", () => {
      const aliases = aliasesInput.value
        .split(",")
        .map((a) => a.trim())
        .filter((a) => /^[a-z0-9 _-]{1,24}$/i.test(a))
        .slice(0, 8);
      if (!aliases.length) {
        aliasesInput.value = appSettings.noteAliases.join(", ");
        return;
      }
      appSettings.noteAliases = aliases;
      persistSettings();
    });
  }

  elements.prefsPanel.querySelectorAll("[data-shade]").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      appSettings.noteColor = swatch.dataset.shade;
      persistSettings();
    });
  });

  if (colorInput) {
    colorInput.addEventListener("change", () => {
      const value = colorInput.value.trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value)) {
        colorInput.value = appSettings.noteColor;
        return;
      }
      appSettings.noteColor = value;
      persistSettings();
    });
  }
}

// ---- Untangle animation --------------------------------------------------

// Step 2 "Untangle it": reveal the Follow step, then play the knot straightening
// directly into that step's thread — the line you pull resolves into the final
// thread, in place. Honors reduced-motion and trivial task counts.
function playUntangle() {
  const svg = elements.lineSvg;
  const tasks = visibleTasks();
  if (!svg || prefersReducedMotion || tasks.length < 2) {
    setStep("line");
    return;
  }

  // Hold the ordered cards back, then reveal Follow so the knot resolves in
  // its final home rather than in a throwaway overlay.
  if (elements.linePanel) elements.linePanel.classList.add("is-untangling");
  setStep("line");

  const token = ++untangleToken;
  const layout = lineThreadLayout(tasks.length);
  const start = tangleScatter(tasks, layout.width, layout.height, 36);
  const target = tasks.map((_, i) => ({ x: layout.startX + layout.stepX * i, y: layout.midY }));

  const duration = 1150;
  const begin = performance.now();

  const frame = (now) => {
    if (token !== untangleToken) return; // a newer run superseded this one
    const tRaw = Math.min(1, (now - begin) / duration);
    const t = easeInOutCubic(tRaw);
    const knot = 1 - t;
    const points = start.map((p, i) => ({
      x: p.x + (target[i].x - p.x) * t,
      y: p.y + (target[i].y - p.y) * t,
    }));
    const d = knottedPath(points, knot, 0.7);
    const dots = points
      .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="#111111" />`)
      .join("");
    svg.innerHTML = `
      <path d="${d}" fill="none" stroke="rgba(18,18,18,0.86)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${dots}`;
    if (tRaw < 1) {
      requestAnimationFrame(frame);
    } else {
      renderLineThread(); // settle into the real thread (gentle curve + numbers)
      if (elements.linePanel) elements.linePanel.classList.remove("is-untangling");
    }
  };

  requestAnimationFrame(frame);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}
