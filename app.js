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
const INTERFACE_CONTRASTS = new Set(["soft", "balanced", "rich"]);
const INTERFACE_SPACING = new Set(["compact", "calm", "open"]);
const INTERFACE_MOTION = new Set(["full", "quiet", "none"]);

function shouldReduceInterfaceMotion() {
  return prefersReducedMotion || appSettings?.interfaceMotion !== "full";
}

const state = {
  threadId: null,
  threadName: "Untitled thread",
  tasks: [],
  currentStep: DEFAULT_STEP,
  focusIndex: 0,
  circumspectionContext: emptyCircumspectionContext(),
  navigationContext: emptyNavigationContext(),
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
let captureNotesEditor = null;
let inlineNotesEditor = null;
const undoByThread = new Map();
const navigationTrail = [];
let utilitySurface = null;
let retrospectPreviewId = null; // a completed knot being read in the retrospect view
let journeyOpenTaskId = null; // task whose Web Journey accordion is open (transient)
let journeyEditingTrailId = null; // trail label currently being renamed inline
let journeyCardHideTimer = null;
let loadedThreadStamp = null; // updatedAt of the open thread as last read or written

let appSettings = defaultSettings();
let noteLabelRegex = null;
let settingsPersistVersion = 0;

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
  lineStepLabel: document.getElementById("lineStepLabel"),
  linearList: document.getElementById("linearList"),
  focusTitle: document.getElementById("focusTitle"),
  focusNotes: document.getElementById("focusNotes"),
  focusAttachments: document.getElementById("focusAttachments"),
  focusEditButton: document.getElementById("focusEditButton"),
  focusDoneButton: document.getElementById("focusDoneButton"),
  focusJourneyButton: document.getElementById("focusJourneyButton"),
  focusLabel: document.getElementById("focusLabel"),
  focusCard: document.querySelector(".focus-card"),
  focusRestoreButton: document.getElementById("focusRestoreButton"),
  focusJourney: document.getElementById("focusJourney"),
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
  navigationBackButton: document.getElementById("navigationBackButton"),
  searchPage: document.getElementById("searchPage"),
  searchPageSummary: document.getElementById("searchPageSummary"),
  searchPageResults: document.getElementById("searchPageResults"),
  personalisePage: document.getElementById("personalisePage"),
  personaliseContent: document.getElementById("personaliseContent"),
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
  async searchThreads(query) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    return res.json();
  },
  async configureVersioning(enabled) {
    const res = await fetch("/api/version-control", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body.error || `version control failed: ${res.status}`);
      error.userMessage = body.error;
      throw error;
    }
    return body;
  },
};

installCircumspectionBridge();
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
  state.tasks = Array.isArray(incoming.tasks)
    ? incoming.tasks.map((task) => normalizeTask(task, thread.createdAt))
    : [];
  state.currentStep = steps.includes(incoming.currentStep) ? incoming.currentStep : DEFAULT_STEP;
  state.focusIndex = Number.isInteger(incoming.focusIndex) ? incoming.focusIndex : 0;
  state.circumspectionContext = normalizeCircumspectionContext(incoming.circumspectionContext);
  state.navigationContext = normalizeNavigationContext(incoming.navigationContext);
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
  loadedThreadStamp = typeof thread.updatedAt === "string" ? thread.updatedAt : null;
  if (!state.tasks.some((task) => task.id === journeyOpenTaskId)) journeyOpenTaskId = null;
  journeyEditingTrailId = null;
}

function emptyStateObject() {
  return {
    tasks: [],
    currentStep: DEFAULT_STEP,
    focusIndex: 0,
    circumspectionContext: emptyCircumspectionContext(),
    navigationContext: emptyNavigationContext(),
  };
}

function emptyCircumspectionContext() {
  return {
    lastEntryId: null,
    lastVisitedAt: null,
    lastMeaningfulCircumspectionAction: null,
    lastCircumspectionMode: null,
  };
}

function emptyNavigationContext() {
  return {
    lastMeaningfulSurface: null,
    lastMeaningfulAction: null,
    updatedAt: null,
  };
}

function contextString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCircumspectionContext(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...source,
    lastEntryId: contextString(source.lastEntryId),
    lastVisitedAt: contextString(source.lastVisitedAt),
    lastMeaningfulCircumspectionAction: contextString(source.lastMeaningfulCircumspectionAction),
    lastCircumspectionMode: contextString(source.lastCircumspectionMode),
  };
}

function normalizeNavigationContext(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const surface =
    source.lastMeaningfulSurface === "outer" || source.lastMeaningfulSurface === "circumspection"
      ? source.lastMeaningfulSurface
      : null;
  return {
    ...source,
    lastMeaningfulSurface: surface,
    lastMeaningfulAction: contextString(source.lastMeaningfulAction),
    updatedAt: contextString(source.updatedAt),
  };
}

// Circumspection owns its writing store and preferences. Filum only keeps the
// small amount of per-thread navigation memory needed to route the doorway and
// restore the outer surface. Keeping that seam here avoids either dimension
// reaching into the other's private state.
function installCircumspectionBridge() {
  if (typeof window === "undefined") return;
  window.FilumCircumspectionBridge = {
    getThreadSnapshot,
    getContextSnapshot,
    updateContext: updateCircumspectionContext,
    flushThread: flushPersistImmediate,
    captureOuterSnapshot,
  };
}

function getContextSnapshot() {
  return cloneSerializable({
    threadId: state.threadId,
    threadName: state.threadName,
    circumspectionContext: normalizeCircumspectionContext(state.circumspectionContext),
    navigationContext: normalizeNavigationContext(state.navigationContext),
  });
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function getThreadSnapshot() {
  return cloneSerializable({
    threadId: state.threadId,
    threadName: state.threadName,
    scope: openScope,
    threadMissing,
    ...serializeThreadState(),
  });
}

function updateCircumspectionContext(update = {}) {
  const source = update && typeof update === "object" ? update : {};
  const now = new Date().toISOString();
  const next = normalizeCircumspectionContext(state.circumspectionContext);

  if (Object.prototype.hasOwnProperty.call(source, "entryId")) {
    next.lastEntryId = contextString(source.entryId);
  }
  if (Object.prototype.hasOwnProperty.call(source, "mode")) {
    next.lastCircumspectionMode = contextString(source.mode);
  }
  next.lastVisitedAt = now;

  if (source.meaningful === true) {
    const action = contextString(source.action) || "circumspection";
    next.lastMeaningfulCircumspectionAction = action;
    state.navigationContext = {
      ...normalizeNavigationContext(state.navigationContext),
      lastMeaningfulSurface: "circumspection",
      lastMeaningfulAction: action,
      updatedAt: now,
    };
  }

  state.circumspectionContext = next;
  // Deliberately use the surface-neutral dirty path. Otherwise saving a diary
  // pointer would immediately rewrite its navigation surface back to outer.
  markDirty();
  return cloneSerializable({
    circumspectionContext: state.circumspectionContext,
    navigationContext: state.navigationContext,
  });
}

function captureOuterSnapshot() {
  const active = document.activeElement;
  const focusedTask = state.tasks[state.focusIndex] || null;
  return {
    threadId: state.threadId,
    currentStep: state.currentStep,
    focusIndex: state.focusIndex,
    focusedTaskId: focusedTask ? focusedTask.id : null,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElementId: active instanceof HTMLElement && active.id ? active.id : null,
    capturedAt: new Date().toISOString(),
  };
}

// Back-fill any fields that older thread files predate, so every task the rest
// of the app sees has a predictable shape. This is also the v1 -> v2 migration:
// `done` / `completedAt` appear here, and the legacy triage fields (urgency,
// energy, type, duration) are preserved so old files round-trip untouched even
// though the UI no longer renders them.
function normalizeTask(task, fallbackCreatedAt = null) {
  const t = task && typeof task === "object" ? task : {};
  const createdAt =
    typeof t.createdAt === "string" && Number.isFinite(Date.parse(t.createdAt))
      ? t.createdAt
      : fallbackCreatedAt || new Date().toISOString();
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
    createdAt,
    updatedAt:
      typeof t.updatedAt === "string" && Number.isFinite(Date.parse(t.updatedAt))
        ? t.updatedAt
        : createdAt,
    images: Array.isArray(t.images)
      ? t.images
          .filter((img) => img && typeof img.src === "string" && img.src)
          .map((img) => ({
            id: typeof img.id === "string" && img.id ? img.id : crypto.randomUUID(),
            src: img.src,
            alt: typeof img.alt === "string" ? img.alt : "",
          }))
      : [],
    deepLinks: normalizeDeepLinks(t.deepLinks),
  };
}

// Web Journey trails captured by the browser extension. Every field is
// optional on the way in and predictable on the way out, so a hand-edited or
// half-written trail still renders instead of breaking the focus card.
function normalizeDeepLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const str = (value) => (typeof value === "string" ? value : "");
  return raw
    .filter((dl) => dl && typeof dl === "object" && Array.isArray(dl.nodes))
    .map((dl) => {
      const nodes = dl.nodes
        .filter((n) => n && typeof n.url === "string")
        .map((n) => ({
          url: n.url,
          title: str(n.title),
          type: typeof n.type === "string" && n.type ? n.type : "link",
          referrer: str(n.referrer),
          snippet: str(n.snippet),
          metaDescription: str(n.metaDescription),
          ogTitle: str(n.ogTitle),
          ogDescription: str(n.ogDescription),
          ogImage: str(n.ogImage),
          // A small thumbnail the extension inlines at capture time, so the
          // hover card never has to fetch anything from the open web.
          ogImageData:
            typeof n.ogImageData === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(n.ogImageData)
              ? n.ogImageData
              : "",
          firstH1: str(n.firstH1),
          visitedAt: str(n.visitedAt),
        }));
      const anchor = Number.isInteger(dl.anchorIndex) ? dl.anchorIndex : 0;
      return {
        id: typeof dl.id === "string" && dl.id ? dl.id : crypto.randomUUID(),
        label: str(dl.label),
        userNote: str(dl.userNote),
        capturedAt: typeof dl.capturedAt === "string" ? dl.capturedAt : new Date().toISOString(),
        anchorIndex: nodes.length ? clamp(anchor, 0, nodes.length - 1) : 0,
        nodes,
      };
    });
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
  const wasPreviewing = Boolean(retrospectPreviewId);
  retrospectPreviewId = null; // choosing an open knot ends any reading of a done one
  if (index === state.focusIndex) {
    if (wasPreviewing) {
      renderLine();
      renderLineThread();
    }
    return;
  }
  state.focusIndex = index;
  markOuterMeaningful("focus-task");
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
  rememberUndo("complete-task");
  task.done = true;
  task.completedAt = new Date().toISOString();
  task.updatedAt = task.completedAt;
  normalizeFocus();
  markOuterMeaningful("complete-task");
  // No message, no celebration — the loosening thread is the acknowledgment.
  render();
}

function restoreTask(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task || !task.done) return;
  rememberUndo("restore-task");
  task.done = false;
  task.completedAt = null;
  task.updatedAt = new Date().toISOString();
  // Returning the knot being read makes it the one to do now.
  if (retrospectPreviewId === taskId) {
    state.focusIndex = state.tasks.indexOf(task);
    retrospectPreviewId = null;
  }
  normalizeFocus();
  markOuterMeaningful("restore-task");
  render();
}

function currentUndoStack() {
  const key = state.threadId || "offline";
  if (!undoByThread.has(key)) undoByThread.set(key, []);
  return undoByThread.get(key);
}

function rememberUndo(action) {
  const stack = currentUndoStack();
  stack.push({
    action,
    tasks: cloneSerializable(state.tasks),
    currentStep: state.currentStep,
    focusIndex: state.focusIndex,
  });
  if (stack.length > 50) stack.splice(0, stack.length - 50);
}

function undoLastTrackedAction() {
  const snapshot = currentUndoStack().pop();
  if (!snapshot) {
    setStatus("Nothing to undo");
    return;
  }
  state.tasks = snapshot.tasks.map((task) => normalizeTask(task));
  state.currentStep = steps.includes(snapshot.currentStep) ? snapshot.currentStep : DEFAULT_STEP;
  state.focusIndex = snapshot.focusIndex;
  editingTaskId = null;
  editingImages = [];
  normalizeFocus();
  markOuterMeaningful(`undo-${snapshot.action}`);
  render();
}

function handleAssistedShortcut(event) {
  if (appSettings.keyboardAssistedNavigation === false) return false;
  const target = event.target instanceof Element ? event.target : null;
  const editing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const key = event.key.toLowerCase();
  const newKnot = isMac
    ? event.ctrlKey && !event.metaKey && !event.altKey && key === "n"
    : event.altKey && !event.ctrlKey && !event.metaKey && key === "n";
  const markDone = isMac
    ? event.ctrlKey && !event.metaKey && !event.altKey && key === "w"
    : event.altKey && !event.ctrlKey && !event.metaKey && key === "w";
  const undo = !editing && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && key === "z";

  if (newKnot) {
    event.preventDefault();
    setStep("capture");
    requestAnimationFrame(() => elements.taskTitle?.focus());
    return true;
  }
  if (markDone && !editing) {
    event.preventDefault();
    completeFocusedTask();
    return true;
  }
  if (undo) {
    event.preventDefault();
    undoLastTrackedAction();
    return true;
  }
  return false;
}

function toggleRetrospect() {
  retrospectOn = !retrospectOn;
  retrospectPreviewId = null;
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
  if (elements.taskNotes) {
    captureNotesEditor = bindMarkShortcuts(elements.taskNotes, {
      onPaste: (event) => handleImagePaste(event, captureImages, renderCaptureAttachments),
      images: () => captureImages,
    });
  }
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
  if (elements.focusRestoreButton) {
    elements.focusRestoreButton.addEventListener("click", () => {
      if (retrospectPreviewId) restoreTask(retrospectPreviewId);
    });
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
      if (!item) return;
      if (item.classList.contains("is-done")) previewDoneTask(item.dataset.taskId);
      else setFocusByTaskId(item.dataset.taskId);
    });
    elements.linearList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = event.target.closest(".linear-item[data-task-id]");
      if (!item || event.target.closest("[data-restore-task]")) return;
      event.preventDefault();
      if (item.classList.contains("is-done")) previewDoneTask(item.dataset.taskId);
      else setFocusByTaskId(item.dataset.taskId);
    });
  }

  if (elements.lineSvg) {
    // The dots on the thread are jump points, same as the rail cards.
    elements.lineSvg.addEventListener("click", (event) => {
      const dot = event.target.closest("[data-task-id]");
      if (!dot) return;
      const task = state.tasks.find((entry) => entry.id === dot.dataset.taskId);
      if (task?.done) previewDoneTask(task.id);
      else setFocusByTaskId(dot.dataset.taskId);
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
    const play = target.closest("[data-yt-play]");
    if (play && !target.closest("[contenteditable='true']")) {
      event.preventDefault();
      playYoutube(play);
      return;
    }
    const imageButton = target.closest("[data-view-image], [data-image-ref]");
    if (imageButton && !target.closest("[contenteditable='true']")) {
      event.preventDefault();
      const id = imageButton.dataset.viewImage || imageButton.dataset.imageRef;
      const images = imagesForReference(id);
      if (images) openImageViewer(images, id);
      else setStatus("That image is no longer attached");
      return;
    }
    const threadReference = target.closest("[data-thread-ref]");
    if (threadReference && !target.closest("[contenteditable='true']")) {
      event.preventDefault();
      navigateToReferencedThread(threadReference.dataset.threadRef);
      return;
    }
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
    if (handleAssistedShortcut(event)) return;
    if (event.key === "Escape") {
      if (threadMenuOpen) closeThreadMenu();
      if (prefsOpen) closePrefsPanel();
    }
    const typing =
      (event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable='true']")) ||
      editingTaskId !== null;
    const wantsFind =
      (event.key === "/" && !typing) ||
      ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k");
    if (wantsFind) {
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
  elements.navigationBackButton?.addEventListener("click", goBackInFilum);
  elements.searchPageResults?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-search-thread]");
    if (row) openSearchResult(row.dataset.searchThread, row.dataset.searchTask || null);
  });

  bindPlanDrag();

  bindWebJourney();

  window.addEventListener("resize", renderVisuals);
  window.addEventListener("beforeunload", flushPersistOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistOnUnload();
    else refreshFromDiskIfChanged();
  });
  window.addEventListener("focus", refreshFromDiskIfChanged);
}

function handleAddTask(event) {
  event.preventDefault();

  const title = elements.taskTitle.value.trim();
  if (!title) {
    elements.taskTitle.focus();
    return;
  }

  rememberUndo("add-task");
  const timestamp = new Date().toISOString();
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
    createdAt: timestamp,
    updatedAt: timestamp,
    images: captureImages.slice(),
  });

  elements.taskForm.reset();
  captureNotesEditor?.setMarkdown("");
  captureImages = [];
  renderCaptureAttachments();
  elements.taskTitle.focus();
  markOuterMeaningful("add-task");
  render();
}

function resetState() {
  if (state.tasks.length) rememberUndo("reset-thread");
  state.tasks = [];
  state.currentStep = DEFAULT_STEP;
  state.focusIndex = 0;
  captureImages = [];
  editingTaskId = null;
  editingImages = [];
  retrospectOn = false;
  renderCaptureAttachments();
  markOuterMeaningful("reset-thread");
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
  const previousStep = state.currentStep;
  state.currentStep = steps.includes(step) ? step : DEFAULT_STEP;
  if (state.currentStep !== previousStep) markOuterMeaningful("change-step");
  else markDirty();
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

function captureNavigationPointer() {
  const task = state.tasks[state.focusIndex] || null;
  return {
    threadId: state.threadId,
    step: state.currentStep,
    taskId: task?.id || null,
    scrollY: window.scrollY,
  };
}

async function navigateToReferencedThread(id) {
  if (!id || id === state.threadId) return;
  navigationTrail.push(captureNavigationPointer());
  await openThreadById(id);
  updateBackVisibility();
}

// ---- Thread lifecycle: archive / bin ---------------------------------------

async function archiveCurrentThread() {
  if (!state.threadId) return;
  closeThreadMenu();
  markOuterMeaningful("archive-thread");
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
  markOuterMeaningful("bin-thread");
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
  const changed = trimmed !== state.threadName;
  hideRenameInput(); // hide first so the resulting blur is a no-op
  state.threadName = trimmed;
  if (elements.threadMenuLabel) elements.threadMenuLabel.textContent = trimmed;
  if (changed) markOuterMeaningful("rename-thread");
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

function markOuterMeaningful(action) {
  const now = new Date().toISOString();
  state.navigationContext = {
    ...normalizeNavigationContext(state.navigationContext),
    lastMeaningfulSurface: "outer",
    lastMeaningfulAction: contextString(action) || "outer-change",
    updatedAt: now,
  };
  markDirty();
}

function serializeThreadState() {
  return {
    tasks: state.tasks,
    currentStep: state.currentStep,
    focusIndex: state.focusIndex,
    circumspectionContext: normalizeCircumspectionContext(state.circumspectionContext),
    navigationContext: normalizeNavigationContext(state.navigationContext),
  };
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
    state: serializeThreadState(),
  };
  try {
    const saved = await storage.saveThread(thread);
    isDirty = false;
    if (saved && typeof saved.updatedAt === "string") loadedThreadStamp = saved.updatedAt;
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
    state: serializeThreadState(),
  });
  // keepalive PUT is the reliable cross-browser path for unload writes.
  try {
    fetch(`/api/threads/${encodeURIComponent(state.threadId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .then(async (res) => {
        // A tab that was only hidden (not closed) is still alive to hear back.
        // If nothing changed since this body was sent, the file now matches
        // the screen — mark it clean so a later return can pick up captures
        // the browser extension writes meanwhile.
        if (!res.ok) return;
        const saved = await res.json();
        const now = JSON.stringify({ name: state.threadName, state: serializeThreadState() });
        if (now === body && !persistTimer) {
          isDirty = false;
          if (saved && typeof saved.updatedAt === "string") loadedThreadStamp = saved.updatedAt;
        }
      })
      .catch(() => {});
  } catch {
    // ignore — the localStorage mirror above is the safety net.
  }
}

function saveOfflineMirror() {
  try {
    const threadState = serializeThreadState();
    localStorage.setItem(
      LOCAL_MIRROR_KEY,
      JSON.stringify({
        threadId: state.threadId,
        threadName: state.threadName,
        ...threadState,
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
        circumspectionContext: normalizeCircumspectionContext(parsed.circumspectionContext),
        navigationContext: normalizeNavigationContext(parsed.navigationContext),
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

  // Knots behind the current step are filled, the current one is ringed:
  // progress is carried by the shape of the thread, not by a counter.
  const activeIndex = steps.indexOf(activeStep);
  elements.stepButtons.forEach((button) => {
    const index = steps.indexOf(button.dataset.stepTarget);
    button.classList.toggle("is-active", index === activeIndex);
    button.classList.toggle("is-done", index < activeIndex);
    if (index === activeIndex) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  document.querySelector(".stepper")?.style.setProperty("--step-progress", String(Math.max(0, activeIndex) / (steps.length - 1)));

  elements.panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.step === activeStep);
  });
}

function renderHeaderControls() {
  const hasTasks = state.tasks.length > 0;
  if (elements.findPlanButton) elements.findPlanButton.hidden = false;
  if (elements.findLineButton) elements.findLineButton.hidden = false;
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
            <strong>${expandHtml(task.title)}</strong>
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
              <strong>${index + 1}. ${expandHtml(task.title)}</strong>
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
  rememberUndo("reorder-task");
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
  markOuterMeaningful("reorder-task");
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
    if (shouldReduceInterfaceMotion()) {
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
  const preview = retrospectPreviewTask();
  if (!preview) retrospectPreviewId = null;
  const currentTask = preview || (focused && !focused.done ? focused : null);
  const editingHere = !!(!preview && currentTask && editingTaskId === currentTask.id && state.currentStep === "line");
  if (elements.focusLabel) {
    elements.focusLabel.textContent = preview
      ? `Done${preview.completedAt ? ` · ${formatTime(preview.completedAt)}` : ""}`
      : "Do this now";
  }
  elements.focusCard?.classList.toggle("is-preview", Boolean(preview));
  if (elements.focusRestoreButton) elements.focusRestoreButton.hidden = !preview;
  if (elements.lineStepLabel) {
    // Count the way the rail and the thread count: completed knots only
    // take a number while retrospect shows them.
    const index = currentTask ? (retrospectOn ? all : visible).indexOf(currentTask) : -1;
    elements.lineStepLabel.textContent = index >= 0 ? `Step ${index + 1}` : "Sequence";
  }

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
  if (elements.focusEditButton) elements.focusEditButton.hidden = !showTaskActions || Boolean(preview);
  if (elements.focusDoneButton) elements.focusDoneButton.hidden = !showTaskActions || Boolean(preview);
  renderWebJourneyEntry(currentTask, showTaskActions);

  if (editingHere) {
    // read view hidden; the editor carries the card
  } else if (!all.length) {
    elements.focusTitle.textContent = "This thread is empty";
    elements.focusNotes.innerHTML =
      '<span class="focus-notes-empty">Gather a few thoughts in Step 1 first.</span>';
  } else if (allDone && !preview) {
    elements.focusTitle.textContent = "The thread is clear.";
    elements.focusNotes.innerHTML =
      '<span class="focus-notes-empty">Every knot on this thread is loose.</span>';
  } else if (currentTask) {
    elements.focusTitle.innerHTML = expandHtml(currentTask.title);
    elements.focusNotes.innerHTML = currentTask.notes
      ? renderRichNotes(currentTask.notes)
      : '<span class="focus-notes-empty">No extra notes. Just begin.</span>';
  }
  renderReadonlyTray(elements.focusAttachments, currentTask && !editingHere ? currentTask.images : []);

  const navTask = focused && !focused.done ? focused : null;
  const visiblePos = navTask ? visible.findIndex((task) => task.id === navTask.id) : -1;
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
        const isPreview = preview && preview.id === task.id;
        return `
          <article class="linear-item is-done ${isPreview ? "is-previewing" : ""}" data-task-id="${task.id}"
            role="button" tabindex="0" aria-pressed="${isPreview ? "true" : "false"}"
            aria-label="Read ${escapeHtml(task.title)}, done">
            <div class="linear-item-index">Step ${index + 1}</div>
            <strong>${expandHtml(task.title)}</strong>
            <p>done${escapeHtml(when)}</p>
            <button class="ghost-button mini-edit linear-restore" type="button" data-restore-task="${task.id}">Return to thread</button>
          </article>
        `;
      }
      const isCurrent = !preview && currentTask && task.id === currentTask.id;
      return `
        <article class="linear-item ${isCurrent ? "is-current" : "is-muted"}"
          data-task-id="${task.id}"
          role="button"
          tabindex="0"
          ${isCurrent ? 'aria-current="step"' : ""}>
          <div class="linear-item-index">Step ${index + 1}</div>
          <strong>${expandHtml(task.title)}</strong>
          <p>${escapeHtml(lineCardSubtitle(task))}</p>
        </article>
      `;
    })
    .join("");
}

// ---- Web Journey ------------------------------------------------------------
//
// Trails captured by the browser extension (see extension/ and engineering.md).
// Invisible unless the focused task holds at least one trail; then a quiet
// "✦ Web journey" text button opens an accordion of flowing threads, one per
// trail, newest first. Nothing here moves for attention: the panel arrives,
// the hover card fades, and that is all.

const JOURNEY_NODE_GAP = 56; // vertical rhythm between visits
const JOURNEY_TOP = 18; // room above the first dot (and below the last)
const JOURNEY_BASE_X = 14; // left edge of the thread inside each svg
const JOURNEY_LABEL_GAP = 20; // dot-to-title offset
const JOURNEY_CARD_LINGER_MS = 160; // grace period to travel from dot to card
const SEARCH_ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/i, path: /^\/search/, name: "Google" },
  { host: /(^|\.)bing\.com$/i, path: /^\/search/, name: "Bing" },
  { host: /(^|\.)duckduckgo\.com$/i, path: /^\/($|\?)/, name: "DuckDuckGo" },
  { host: /(^|\.)search\.brave\.com$/i, path: /^\/search/, name: "Brave" },
  { host: /(^|\.)ecosia\.org$/i, path: /^\/search/, name: "Ecosia" },
  { host: /(^|\.)kagi\.com$/i, path: /^\/search/, name: "Kagi" },
];

// "11:34 pm on 26th Jan 2024" — read at a glance, never parsed.
function prettyTimestamp(isoString) {
  const d = new Date(isoString);
  if (!isoString || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day = d.getDate();
  const teen = day % 100 >= 11 && day % 100 <= 13;
  const suffix = teen ? "th" : { 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${h % 12 || 12}:${mm} ${h >= 12 ? "pm" : "am"} on ${day}${suffix} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function journeyParseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function journeySearchInfo(node) {
  const url = journeyParseUrl(node.url);
  if (!url) return null;
  const engine = SEARCH_ENGINES.find((e) => e.host.test(url.hostname) && e.path.test(url.pathname + url.search));
  const query = url.searchParams.get("q") || url.searchParams.get("query") || "";
  if (engine && query) return { name: engine.name, query };
  if (engine || node.type === "search") return { name: engine ? engine.name : "Search", query };
  return null;
}

function journeyHost(value) {
  const url = journeyParseUrl(value);
  return url ? url.hostname.replace(/^www\./, "") : "";
}

// The words a person will recognise months later: the search they typed, or
// the page's own title, falling back through its headline to its address.
function journeyNodeTitle(node) {
  const search = journeySearchInfo(node);
  if (search && search.query) return `${search.name}: ${search.query}`;
  return node.title || node.ogTitle || node.firstH1 || journeyHost(node.url) || node.url;
}

function journeyAutoLabel(trail) {
  const anchor = trail.nodes[trail.anchorIndex] || trail.nodes[trail.nodes.length - 1];
  return anchor ? truncate(journeyNodeTitle(anchor), 40) : "Web journey";
}

// Each trail gets its own small, stable sway so stacked trails read as
// separate rivers rather than one repeated stamp.
function journeySway(trail) {
  let hash = 0;
  for (const ch of trail.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { amount: 12 + (hash % 9), startRight: hash % 2 === 1 };
}

function journeyPoints(trail) {
  const { amount, startRight } = journeySway(trail);
  return trail.nodes.map((_, index) => {
    const right = (index % 2 === 1) !== startRight;
    return { x: JOURNEY_BASE_X + (right ? amount : 0), y: JOURNEY_TOP + index * JOURNEY_NODE_GAP };
  });
}

// One unbroken cubic Bézier through every visit. Tangents stay vertical at
// each dot, so consecutive segments meet smoothly — no corners anywhere.
function journeyPath(points) {
  if (!points.length) return "";
  const first = points[0];
  if (points.length === 1) {
    return `M ${first.x} ${first.y - 12} C ${first.x + 6} ${first.y - 4}, ${first.x - 6} ${first.y + 4}, ${first.x} ${first.y + 12}`;
  }
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const pull = (b.y - a.y) * 0.55;
    d += ` C ${a.x} ${a.y + pull}, ${b.x} ${b.y - pull}, ${b.x} ${b.y}`;
  }
  return d;
}

// The task the focus card is about: a completed knot being read in the
// retrospect view, or else the focused open task.
function focusedOpenTask() {
  const preview = retrospectPreviewTask();
  if (preview) return preview;
  const task = state.tasks[state.focusIndex];
  return task && !task.done ? task : null;
}

function retrospectPreviewTask() {
  if (!retrospectOn || !retrospectPreviewId) return null;
  return state.tasks.find((task) => task.id === retrospectPreviewId && task.done) || null;
}

// Reading a completed knot never un-completes it: the focus card shows its
// contents, marked as done, with "Return to thread" as the only action.
function previewDoneTask(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task || !task.done || !retrospectOn) return;
  retrospectPreviewId = retrospectPreviewId === taskId ? null : taskId;
  editingTaskId = null;
  renderLine();
  renderLineThread();
}

function findFocusedTrail(trailId) {
  const task = focusedOpenTask();
  if (!task || !Array.isArray(task.deepLinks)) return { task, trail: null };
  return { task, trail: task.deepLinks.find((entry) => entry.id === trailId) || null };
}

function renderWebJourneyEntry(currentTask, showTaskActions) {
  const button = elements.focusJourneyButton;
  const panel = elements.focusJourney;
  const hasTrails = !!(showTaskActions && currentTask && currentTask.deepLinks && currentTask.deepLinks.length);
  const open = hasTrails && journeyOpenTaskId === currentTask.id;
  if (button) {
    button.hidden = !hasTrails;
    button.classList.toggle("is-active", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (!panel) return;
  if (!open) {
    if (!panel.hidden) {
      panel.hidden = true;
      panel.innerHTML = "";
      hideJourneyCard(true);
    }
    return;
  }
  const wasHidden = panel.hidden;
  panel.hidden = false; // unhide first so the renderer can measure its width
  if (!wasHidden && journeyEditingTrailId) return; // never yank an in-progress rename
  renderWebJourney(currentTask);
}

function renderWebJourney(task) {
  const panel = elements.focusJourney;
  if (!panel || !task) return;
  hideJourneyCard(true);
  const trails = task.deepLinks
    .slice()
    .sort((a, b) => (Date.parse(b.capturedAt) || 0) - (Date.parse(a.capturedAt) || 0));
  // Titles truncate to ~50 characters, fewer on narrow screens so a label
  // never runs off the card.
  const width = panel.clientWidth || 560;
  const maxChars = clamp(Math.floor((width - JOURNEY_BASE_X - 20 - JOURNEY_LABEL_GAP - 16) / 7.4), 18, 50);
  panel.innerHTML = trails.map((trail) => renderJourneyTrail(trail, maxChars)).join("");
}

function renderJourneyTrail(trail, maxChars) {
  const label = trail.label || journeyAutoLabel(trail);
  const editing = journeyEditingTrailId === trail.id;
  const when = prettyTimestamp(trail.capturedAt);
  const note = trail.userNote.trim();
  const labelHtml = editing
    ? `<input class="journey-trail-input" type="text" value="${escapeHtml(label)}" maxlength="120"
         data-journey-label-input="${escapeHtml(trail.id)}" aria-label="Trail label" />`
    : `<h4 class="journey-trail-label">${escapeHtml(label)}</h4>
       <button class="journey-trail-edit" type="button" data-journey-rename="${escapeHtml(trail.id)}"
         aria-label="Rename trail ${escapeHtml(label)}" title="Rename">✎</button>`;
  return `
    <section class="journey-trail" data-trail-id="${escapeHtml(trail.id)}" aria-label="Web journey: ${escapeHtml(label)}">
      <header class="journey-trail-header">
        ${labelHtml}
        <button class="journey-trail-remove" type="button" data-journey-remove="${escapeHtml(trail.id)}"
          aria-label="Remove this trail">
          <span class="journey-remove-wide">Remove this trail</span><span class="journey-remove-narrow" aria-hidden="true">×</span>
        </button>
      </header>
      ${when ? `<p class="journey-trail-time">captured ${escapeHtml(when)}</p>` : ""}
      ${renderJourneySvg(trail, maxChars)}
      ${note ? `<p class="journey-trail-note">“${escapeHtml(note)}”</p>` : ""}
    </section>`;
}

function renderJourneySvg(trail, maxChars) {
  const points = journeyPoints(trail);
  if (!points.length) return "";
  const height = JOURNEY_TOP * 2 + (points.length - 1) * JOURNEY_NODE_GAP;
  // Titles share one left edge (just past the widest sway) — the thread
  // carries the movement, the words stay still and easy to scan.
  const labelX = Math.max(...points.map((p) => p.x)) + JOURNEY_LABEL_GAP;
  const nodes = trail.nodes
    .map((node, index) => {
      const p = points[index];
      const isAnchor = index === trail.anchorIndex;
      const search = journeySearchInfo(node);
      const title = journeyNodeTitle(node);
      const shown = `${search ? "◎ " : ""}${truncate(title, maxChars)}`;
      const when = prettyTimestamp(node.visitedAt);
      const spoken = `${title}${when ? `, visited ${when}` : ""}${isAnchor ? ", where this trail was captured" : ""}. Press Enter to open the page.`;
      return `
        <g class="journey-node${isAnchor ? " is-anchor" : ""}${index === 0 ? " is-origin" : ""}"
           data-trail-id="${escapeHtml(trail.id)}" data-node-index="${index}"
           tabindex="0" role="link" aria-label="${escapeHtml(spoken)}">
          <circle class="journey-hit" cx="${p.x}" cy="${p.y}" r="16"></circle>
          <circle class="journey-dot" cx="${p.x}" cy="${p.y}" r="${isAnchor ? 8 : 6}"></circle>
          <text class="journey-title" x="${labelX}" y="${p.y}" dominant-baseline="central">${escapeHtml(shown)}</text>
        </g>`;
    })
    .join("");
  return `
    <svg class="journey-svg" height="${height}" role="group"
         aria-label="Trail of ${trail.nodes.length} page${trail.nodes.length === 1 ? "" : "s"}">
      <path class="journey-path" d="${journeyPath(points)}"></path>
      ${nodes}
    </svg>`;
}

// ---- The déjà vu card ---------------------------------------------------------

function journeyCardElement() {
  let card = document.getElementById("journeyCard");
  if (!card) {
    card = document.createElement("div");
    card.id = "journeyCard";
    card.className = "journey-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Page details");
    card.hidden = true;
    card.addEventListener("pointerenter", () => clearTimeout(journeyCardHideTimer));
    card.addEventListener("pointerleave", () => scheduleJourneyCardHide());
    document.body.appendChild(card);
  }
  return card;
}

function journeyArrivedFrom(trail, index) {
  const node = trail.nodes[index];
  if (index > 0) return journeyNodeTitle(trail.nodes[index - 1]);
  if (node.referrer) {
    const search = journeySearchInfo({ url: node.referrer, type: "" });
    return search && search.query ? `${search.name}: ${search.query}` : journeyHost(node.referrer);
  }
  return node.type === "typed" ? "an address typed by hand" : "";
}

function journeyCardContent(trail, index) {
  const node = trail.nodes[index];
  const parts = [];
  parts.push(`<p class="journey-card-title">${escapeHtml(node.ogTitle || node.title || journeyNodeTitle(node))}</p>`);
  const description = node.ogDescription || node.metaDescription;
  if (description) parts.push(`<p class="journey-card-desc">${escapeHtml(description)}</p>`);
  if (node.ogImageData) {
    parts.push(`<img class="journey-card-image" src="${escapeHtml(node.ogImageData)}" alt="" />`);
  }
  const from = journeyArrivedFrom(trail, index);
  if (from) {
    parts.push(`<p class="journey-card-meta"><span class="journey-card-kicker">Arrived from</span>${escapeHtml(truncate(from, 80))}</p>`);
  }
  if (node.snippet.trim()) {
    parts.push(`<p class="journey-card-snippet">“${escapeHtml(truncate(node.snippet, 280))}”</p>`);
  }
  const when = prettyTimestamp(node.visitedAt);
  if (when) parts.push(`<p class="journey-card-time">${escapeHtml(when)}</p>`);
  if (journeyParseUrl(node.url)) {
    parts.push(
      `<a class="journey-card-link" href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer">Open page ↗</a>`
    );
  }
  return parts.join("");
}

function showJourneyCard(nodeEl) {
  const { trail } = findFocusedTrail(nodeEl.dataset.trailId);
  const index = Number(nodeEl.dataset.nodeIndex);
  if (!trail || !trail.nodes[index]) return;
  clearTimeout(journeyCardHideTimer);
  const card = journeyCardElement();
  const key = `${trail.id}:${index}`;
  if (card.dataset.key !== key || card.hidden) {
    card.dataset.key = key;
    card.innerHTML = journeyCardContent(trail, index);
    card.hidden = false;
    card.classList.remove("is-visible");
    positionJourneyCard(card, nodeEl);
    // Next frame, so the fade starts from transparent rather than snapping in.
    requestAnimationFrame(() => card.classList.add("is-visible"));
    const img = card.querySelector("img");
    if (img && !img.complete) img.addEventListener("load", () => positionJourneyCard(card, nodeEl), { once: true });
  }
}

function positionJourneyCard(card, nodeEl) {
  const gutter = 16;
  const dot = (nodeEl.querySelector(".journey-dot") || nodeEl).getBoundingClientRect();
  // Sit past the trail's widest title, so the card never hides a neighbour.
  const svg = nodeEl.closest("svg");
  const titles = svg ? [...svg.querySelectorAll(".journey-title")] : [];
  const textRight = titles.length
    ? Math.max(...titles.map((title) => title.getBoundingClientRect().right))
    : nodeEl.getBoundingClientRect().right;
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  // Prefer beside the titles; when there is no room, settle just under the dot.
  let left = textRight + 24;
  let top = dot.top + dot.height / 2 - 24;
  if (left + width > vw - gutter) {
    left = clamp(dot.left - 8, gutter, Math.max(gutter, vw - gutter - width));
    top = dot.bottom + 12;
    if (top + height > vh - gutter) top = dot.top - 12 - height;
  }
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(clamp(top, gutter, Math.max(gutter, vh - gutter - height)))}px`;
}

function scheduleJourneyCardHide() {
  clearTimeout(journeyCardHideTimer);
  journeyCardHideTimer = setTimeout(() => hideJourneyCard(false), JOURNEY_CARD_LINGER_MS);
}

function hideJourneyCard(immediate) {
  clearTimeout(journeyCardHideTimer);
  const card = document.getElementById("journeyCard");
  if (!card || card.hidden) return;
  card.classList.remove("is-visible");
  const finish = () => {
    if (card.classList.contains("is-visible")) return; // re-shown meanwhile
    card.hidden = true;
    card.dataset.key = "";
  };
  if (immediate || shouldReduceInterfaceMotion()) finish();
  else journeyCardHideTimer = setTimeout(finish, 180);
}

// ---- Accordion, rename, remove ----------------------------------------------

function toggleWebJourney() {
  const task = focusedOpenTask();
  if (!task || !task.deepLinks || !task.deepLinks.length) return;
  journeyOpenTaskId = journeyOpenTaskId === task.id ? null : task.id;
  journeyEditingTrailId = null;
  renderLine();
}

function startJourneyRename(trailId) {
  const { task, trail } = findFocusedTrail(trailId);
  if (!trail) return;
  journeyEditingTrailId = trailId;
  renderWebJourney(task);
  const input = elements.focusJourney.querySelector("[data-journey-label-input]");
  if (input) {
    input.focus();
    input.select();
  }
}

function finishJourneyRename(input, save) {
  const trailId = input.dataset.journeyLabelInput;
  if (journeyEditingTrailId !== trailId) return; // already settled (blur after Enter)
  journeyEditingTrailId = null;
  const { task, trail } = findFocusedTrail(trailId);
  if (!task) return;
  if (save && trail) {
    const next = input.value.replace(/\s+/g, " ").trim() || journeyAutoLabel(trail);
    if (next !== trail.label) {
      rememberUndo("rename-trail");
      trail.label = next;
      task.updatedAt = new Date().toISOString();
      markOuterMeaningful("rename-trail");
    }
  }
  renderWebJourney(task);
  const editButton = elements.focusJourney.querySelector(`[data-journey-rename="${CSS.escape(trailId)}"]`);
  if (editButton) editButton.focus();
}

function removeJourneyTrail(trailId) {
  const { task, trail } = findFocusedTrail(trailId);
  if (!task || !trail) return;
  rememberUndo("remove-trail");
  task.deepLinks = task.deepLinks.filter((entry) => entry.id !== trailId);
  task.updatedAt = new Date().toISOString();
  if (!task.deepLinks.length) journeyOpenTaskId = null;
  journeyEditingTrailId = null;
  hideJourneyCard(true);
  markOuterMeaningful("remove-trail");
  renderLine();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  setStatus(
    appSettings.keyboardAssistedNavigation === false
      ? "Trail removed"
      : `Trail removed · ${isMac ? "⌘Z" : "Ctrl+Z"} brings it back`
  );
  const next = task.deepLinks.length
    ? elements.focusJourney.querySelector(".journey-node")
    : elements.focusEditButton;
  if (next && typeof next.focus === "function") next.focus();
}

function openJourneyNode(nodeEl) {
  const { trail } = findFocusedTrail(nodeEl.dataset.trailId);
  const node = trail && trail.nodes[Number(nodeEl.dataset.nodeIndex)];
  if (node && journeyParseUrl(node.url)) window.open(node.url, "_blank", "noopener,noreferrer");
}

function bindWebJourney() {
  const panel = elements.focusJourney;
  if (elements.focusJourneyButton) {
    elements.focusJourneyButton.addEventListener("click", toggleWebJourney);
  }
  if (!panel) return;

  panel.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return; // touch uses tap, below
    const node = event.target.closest(".journey-node");
    if (node) showJourneyCard(node);
  });
  panel.addEventListener("pointerout", (event) => {
    const node = event.target.closest(".journey-node");
    if (!node || node.contains(event.relatedTarget)) return;
    scheduleJourneyCardHide();
  });
  panel.addEventListener("focusin", (event) => {
    const node = event.target.closest(".journey-node");
    if (node) showJourneyCard(node);
  });
  panel.addEventListener("focusout", (event) => {
    if (event.target.matches("[data-journey-label-input]")) {
      finishJourneyRename(event.target, true);
      return;
    }
    if (event.target.closest(".journey-node")) scheduleJourneyCardHide();
  });

  panel.addEventListener("click", (event) => {
    const rename = event.target.closest("[data-journey-rename]");
    if (rename) {
      startJourneyRename(rename.dataset.journeyRename);
      return;
    }
    const remove = event.target.closest("[data-journey-remove]");
    if (remove) {
      removeJourneyTrail(remove.dataset.journeyRemove);
      return;
    }
    // A tap shows the card (touch has no hover); the card's link opens the page.
    const node = event.target.closest(".journey-node");
    if (node) showJourneyCard(node);
  });

  panel.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-journey-label-input]");
    if (input) {
      if (event.key === "Enter") {
        event.preventDefault();
        finishJourneyRename(input, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishJourneyRename(input, false);
      }
      return;
    }
    const node = event.target.closest(".journey-node");
    if (!node) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openJourneyNode(node);
    } else if (event.key === "Escape") {
      hideJourneyCard(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideJourneyCard(false);
  });
  window.addEventListener("scroll", () => hideJourneyCard(true), { passive: true, capture: true });
  window.addEventListener("resize", () => {
    hideJourneyCard(true);
    const task = focusedOpenTask();
    if (task && journeyOpenTaskId === task.id && !journeyEditingTrailId && !panel.hidden) {
      renderWebJourney(task);
    }
  });
}

// ---- Picking up captures made in the browser --------------------------------
//
// The extension writes trails straight into the thread file while the Filum
// tab sits in the background. When the tab comes back into view with nothing
// unsaved, re-read the file once if it changed on disk, keeping the user's
// place (step, focused task, open accordion). With unsaved edits, the local
// copy wins — the next save is the user's own.
let journeyRefreshInFlight = false;

async function refreshFromDiskIfChanged() {
  if (journeyRefreshInFlight || !state.threadId || threadMissing || isOffline) return;
  if (isDirty || persistTimer || editingTaskId !== null || journeyEditingTrailId) return;
  journeyRefreshInFlight = true;
  try {
    const thread = await storage.loadThread(state.threadId);
    if (!thread || thread.id !== state.threadId || thread.updatedAt === loadedThreadStamp) return;
    if (isDirty || persistTimer || editingTaskId !== null || journeyEditingTrailId) return;
    const focusedId = state.tasks[state.focusIndex] ? state.tasks[state.focusIndex].id : null;
    const step = state.currentStep;
    const keepRetrospect = retrospectOn;
    const keepJourney = journeyOpenTaskId;
    hydrate(thread);
    state.currentStep = step;
    const index = focusedId ? state.tasks.findIndex((task) => task.id === focusedId) : -1;
    if (index >= 0) state.focusIndex = index;
    normalizeFocus();
    retrospectOn = keepRetrospect;
    if (state.tasks.some((task) => task.id === keepJourney)) journeyOpenTaskId = keepJourney;
    render();
  } catch {
    // Offline or mid-move: stay quiet; the on-screen copy is still good.
  } finally {
    journeyRefreshInFlight = false;
  }
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
    const reading = retrospectPreviewId === task.id;
    return `<circle data-task-id="${task.id}" class="line-dot" cx="${x}" cy="${midY}" r="${reading ? 9 : 6}" fill="rgba(255,252,246,0.9)" stroke="rgba(22,22,22,${reading ? 0.85 : 0.55})" stroke-width="${reading ? 2.5 : 2}" />`;
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
  if (!svg || shouldReduceInterfaceMotion() || !done.length) {
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

// Notes as one plain line for summaries: markup and link syntax read as
// noise at a glance, so a chip shows what the words say, not how they are
// written. Abbreviations expand here too.
function plainNotes(notes) {
  return expandPlain(
    String(notes || "")
      .replace(/@\[([^\]]+)\]\(filum:[a-z]+\/[a-z0-9-]+\)/gi, "@$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)\s]+\)/gi, "$1")
      .replace(/^```.*$/gm, "")
      .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/(^|[^*])\*(?!\s)([^*\n]+)\*/g, "$1$2")
  );
}

function summarizeTask(task) {
  return task.notes ? truncate(plainNotes(task.notes), 140) : "No notes yet";
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
  work = work.replace(
    /@\[([^\]]+)\]\(filum:image\/([a-z0-9-]{8,64})\)/gi,
    (m, label, id) =>
      stash(
        `<button class="thread-reference image-reference" type="button" data-image-ref="${escapeHtml(id)}">@${escapeHtml(label)}</button>`
      )
  );
  work = work.replace(
    /@\[([^\]]+)\]\(filum:thread\/([a-z0-9-]{8,64})\)/gi,
    (m, label, id) =>
      stash(
        `<button class="thread-reference" type="button" data-thread-ref="${escapeHtml(id)}">@${escapeHtml(label)}</button>`
      )
  );
  work = work.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi,
    (m, label, href) =>
      stash(
        `<a class="rich-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      )
  );
  work = work.replace(/`([^`\n]+)`/g, (m, body) =>
    stash(`<code class="note-code-inline">${escapeHtml(body)}</code>`)
  );
  work = work.replace(URL_PATTERN, (urlText) => {
    const href = urlText.startsWith("www.") ? `https://${urlText}` : urlText;
    return stash(
      `<a class="rich-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(urlText)}</a>`
    );
  });
  // Abbreviations expand after links and code are set aside, so an address
  // or a code span is never rewritten.
  if (abbreviationRegex) work = work.replace(abbreviationRegex, (match) => stash(abbreviationHtml(match)));

  let out = escapeHtml(work);
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<u>$1</u>");
  out = out.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
  return out.replace(/\x00(\d+)\x00/g, (m, i) => tokens[Number(i)]);
}

// ---- YouTube previews ---------------------------------------------------------
//
// A YouTube link alone on its line becomes a small card in place; links
// inside a sentence stay links, with compact cards gathered after the notes.
// Thumbnails load lazily without a referrer; nothing plays until clicked, and
// then from youtube-nocookie.com. (design.md drift log, 2026-11-22.)
const YOUTUBE_LINK = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^\s)]*?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})[^\s)]*/i;
const MAX_VIDEO_PREVIEWS = 3;

function youtubeInfo(url) {
  const match = String(url || "").match(YOUTUBE_LINK);
  if (!match) return null;
  const time = String(url).match(/[?&#](?:t|start)=(\d+h)?(\d+m)?(\d+)s?/i);
  const start = time
    ? (Number.parseInt(time[1], 10) || 0) * 3600 + (Number.parseInt(time[2], 10) || 0) * 60 + (Number.parseInt(time[3], 10) || 0)
    : 0;
  return { id: match[1], start };
}

// The line is only a YouTube link (bare, or [label](url)).
function standaloneYoutube(line) {
  const trimmed = String(line || "").trim();
  const labelled = trimmed.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
  const url = labelled ? labelled[2] : /^\S+$/.test(trimmed) ? trimmed : "";
  const info = url ? youtubeInfo(url) : null;
  if (!info || (!labelled && !YOUTUBE_LINK.test(trimmed))) return null;
  return { ...info, label: labelled ? labelled[1] : "" };
}

function youtubeCardHtml(video, compact = false) {
  const label = video.label || "YouTube video";
  const watch = `https://www.youtube.com/watch?v=${video.id}${video.start ? `&t=${video.start}s` : ""}`;
  return `<span class="yt-card${compact ? " yt-card--compact" : ""}" data-yt="${escapeHtml(video.id)}">`
    + `<button class="yt-thumb" type="button" data-yt-play="${escapeHtml(video.id)}" data-yt-start="${video.start || 0}"`
    + ` aria-label="Play video: ${escapeHtml(label)}">`
    + `<img src="https://i.ytimg.com/vi/${escapeHtml(video.id)}/mqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    + `<span class="yt-play" aria-hidden="true"></span></button>`
    + `<span class="yt-meta"><span class="yt-title">${expandHtml(label)}</span>`
    + `<a class="rich-link yt-open" href="${escapeHtml(watch)}" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></span>`
    + `</span>`;
}

// Inline YouTube links that did not get a card of their own.
function inlineYoutubeVideos(notes, alreadyShown) {
  const videos = [];
  const seen = new Set(alreadyShown);
  for (const line of String(notes || "").split("\n")) {
    if (standaloneYoutube(line)) continue;
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?:https?:\/\/|www\.)[^\s<)]+/gi;
    let match;
    while ((match = pattern.exec(line))) {
      const info = youtubeInfo(match[2] || match[0]);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      videos.push({ ...info, label: match[1] || "" });
    }
  }
  return videos;
}

function playYoutube(button) {
  const id = button.dataset.ytPlay;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) return;
  const start = Number.parseInt(button.dataset.ytStart, 10) || 0;
  const frame = document.createElement("iframe");
  frame.className = "yt-frame";
  frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ""}`;
  frame.title = button.getAttribute("aria-label") || "YouTube video";
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.allowFullscreen = true;
  button.closest(".yt-card")?.classList.add("is-playing");
  button.replaceWith(frame);
}

function renderNoteLine(line) {
  const video = standaloneYoutube(line);
  if (video) {
    renderNoteLine.shown?.add(video.id);
    return youtubeCardHtml(video);
  }
  const html = inlineMarkup(line);
  return noteLabelRegex && noteLabelRegex.test(line)
    ? `<span class="note-line">${html}</span>`
    : html;
}

// The block structure (paragraphs, nested lists, numbering, code) comes from
// the same parser the editor uses, so what reads here is exactly what was
// written there; only the inline pass is the read view's own.
function renderRichNotes(notes) {
  const raw = String(notes == null ? "" : notes).replace(/\r\n/g, "\n");
  renderNoteLine.shown = new Set();
  const body = window.FilumRichText?.markdownToHtml
    ? window.FilumRichText.markdownToHtml(raw, {
        inline: renderNoteLine,
        listClass: "note-list",
        preClass: "note-code",
        paragraphClass: "note-paragraph",
      })
    : raw.split("\n").map(renderNoteLine).join("<br />");
  const room = Math.max(0, MAX_VIDEO_PREVIEWS - renderNoteLine.shown.size);
  const extra = room ? inlineYoutubeVideos(raw, renderNoteLine.shown).slice(0, room) : [];
  renderNoteLine.shown = null;
  return extra.length
    ? `${body}<div class="yt-strip">${extra.map((video) => youtubeCardHtml(video, true)).join("")}</div>`
    : body;
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

// Read-only tray (focus card): thumbnails that open full size in place.
// Images live inside the thread JSON as data: URLs, and Chrome refuses to
// open a data: URL in a new tab — so the viewer is part of the page.
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
        <button class="attachment-link" type="button" data-view-image="${escapeHtml(img.id)}"
                aria-label="View ${escapeHtml(img.alt || "reference image")}">
          <img class="thumb thumb--lg" src="${escapeHtml(img.src)}" alt="${escapeHtml(
            img.alt || "reference image"
          )}" loading="lazy" />
        </button>`
    )
    .join("");
}

// Step 3 card subtitle: the start of the notes, or a quiet placeholder.
function lineCardSubtitle(task) {
  if (task.notes && task.notes.trim()) return truncate(plainNotes(task.notes), 70);
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
  if (!files.length) return false;
  // Keep the pasted image binary out of the plain-text field.
  event.preventDefault();
  addFilesToImages(files, target, rerender);
  return true;
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
    state.currentStep === "line"
      ? form.querySelector(".ie-notes")?._filumRichEditor?.root || form.querySelector(".rich-surface")
      : form.querySelector(".ie-title");
  if (target) {
    if (state.currentStep === "line" && inlineNotesEditor) {
      inlineNotesEditor.focusOffset(inlineNotesEditor.getMarkdown().length);
    } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();
      const caret = target.value.length;
      target.setSelectionRange(caret, caret);
    } else {
      target.focus();
    }
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

  rememberUndo("edit-task");
  task.title = title;
  task.notes = formEl.querySelector(".ie-notes").value.trim();
  task.images = editingImages.map((img) => ({ ...img }));
  task.updatedAt = new Date().toISOString();

  editingTaskId = null;
  editingImages = [];
  markOuterMeaningful("edit-task");
  render();
}

function removeEditingTask() {
  const index = state.tasks.findIndex((entry) => entry.id === editingTaskId);
  if (index < 0) {
    cancelEdit();
    return;
  }
  rememberUndo("remove-task");
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
  markOuterMeaningful("remove-task");
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
    inlineNotesEditor = bindMarkShortcuts(notes, {
      onPaste: (event) => handleImagePaste(event, editingImages, renderTray),
      images: () => editingImages,
    });
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

// options.images: a getter for the images attached to the task being
// written, so "@" can reference them alongside threads. Only this task's own
// images are offered.
function bindMarkShortcuts(textarea, options = {}) {
  if (!window.FilumRichText) return null;
  const { images, ...rest } = options;
  const imageList = () => (typeof images === "function" ? images() || [] : []);
  return window.FilumRichText.enhance(textarea, {
    toolbarPosition: "bottom",
    mentionProvider: (query) => {
      const pictures = imageList()
        .map((img, index) => ({
          id: img.id,
          name: imageLabel(img, index),
          kind: "image",
          thumb: img.src,
          group: "Images in this task",
        }))
        .filter((item) => !query || item.name.toLowerCase().includes(query));
      const threads = threadList
        .filter((thread) => !query || (thread.name || "Untitled thread").toLowerCase().includes(query))
        .map((thread) => ({
          id: thread.id,
          name: thread.name || "Untitled thread",
          kind: "thread",
          group: pictures.length ? "Threads" : undefined,
        }));
      return [...pictures, ...threads];
    },
    onThreadReference: (id) => navigateToReferencedThread(id),
    onImageReference: (id) => {
      const list = imageList();
      if (list.some((img) => img.id === id)) openImageViewer(list, id);
    },
    ...rest,
  });
}

function imageLabel(img, index) {
  return img.alt ? truncate(img.alt, 24) : `Image ${index + 1}`;
}

// ---- Image viewer ------------------------------------------------------------
//
// A quiet in-page view of one attached image: cream veil, the image, nothing
// else. Escape, a click outside, or the close control returns. With several
// images, ← and → step between them.
let imageViewer = null;

function openImageViewer(images, startId) {
  const list = (images || []).filter((img) => img && typeof img.src === "string" && img.src);
  if (!list.length) return;
  let index = Math.max(0, list.findIndex((img) => img.id === startId));
  const restore = document.activeElement;
  closeImageViewer(false);
  const overlay = document.createElement("div");
  overlay.className = "image-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <figure class="image-viewer-figure">
      <img class="image-viewer-img" alt="" />
      <figcaption class="image-viewer-caption"></figcaption>
    </figure>
    <div class="image-viewer-controls">
      <button class="ghost-button mini-edit" type="button" data-viewer-prev ${list.length > 1 ? "" : "hidden"} aria-label="Previous image">←</button>
      <button class="ghost-button mini-edit" type="button" data-viewer-close>Close</button>
      <button class="ghost-button mini-edit" type="button" data-viewer-next ${list.length > 1 ? "" : "hidden"} aria-label="Next image">→</button>
    </div>`;
  const show = () => {
    const img = list[index];
    overlay.querySelector(".image-viewer-img").src = img.src;
    overlay.querySelector(".image-viewer-img").alt = img.alt || imageLabel(img, index);
    overlay.querySelector(".image-viewer-caption").textContent =
      list.length > 1 ? `${imageLabel(img, index)} · ${index + 1} of ${list.length}` : imageLabel(img, index);
    overlay.setAttribute("aria-label", imageLabel(img, index));
  };
  const step = (delta) => {
    index = (index + delta + list.length) % list.length;
    show();
  };
  overlay.addEventListener("click", (event) => {
    if (event.target.closest("[data-viewer-prev]")) return step(-1);
    if (event.target.closest("[data-viewer-next]")) return step(1);
    if (event.target.closest("[data-viewer-close]") || !event.target.closest(".image-viewer-img")) closeImageViewer(true);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeImageViewer(true);
    } else if (event.key === "ArrowRight" && list.length > 1) step(1);
    else if (event.key === "ArrowLeft" && list.length > 1) step(-1);
    else if (event.key === "Tab") {
      // Keep focus inside the viewer while it is open.
      const controls = [...overlay.querySelectorAll("button:not([hidden])")];
      const at = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  });
  imageViewer = { overlay, restore };
  show();
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  overlay.querySelector("[data-viewer-close]").focus({ preventScroll: true });
}

function closeImageViewer(restoreFocus) {
  if (!imageViewer) return;
  const { overlay, restore } = imageViewer;
  imageViewer = null;
  overlay.remove();
  if (restoreFocus && restore && typeof restore.focus === "function" && restore.isConnected) {
    restore.focus({ preventScroll: true });
  }
}

function imagesForReference(imageId) {
  const focused = state.tasks[state.focusIndex];
  if (focused && focused.images.some((img) => img.id === imageId)) return focused.images;
  const owner = state.tasks.find((task) => task.images.some((img) => img.id === imageId));
  return owner ? owner.images : null;
}

// ---- Find within the thread -------------------------------------------------
//
// Hidden until invoked ("/" or Cmd/Ctrl+K, or the quiet Find buttons), so the
// empty state pays nothing. Fuzzy subsequence match by default; wrap the query
// in /slashes/ for a regular expression. Thread-scoped only — no actions, no
// command palette.

function openFind() {
  if (!elements.findBar) return;
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
    const query = elements.findInput.value.trim();
    if (query) openGlobalSearch(query);
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
  item.scrollIntoView({ block: "center", behavior: shouldReduceInterfaceMotion() ? "auto" : "smooth" });
  item.classList.add("is-found");
  const clear = () => item.classList.remove("is-found");
  setTimeout(() => {
    document.addEventListener("pointerdown", clear, { once: true });
    document.addEventListener("keydown", clear, { once: true });
  }, 0);
}

function setUtilitySurface(surface) {
  utilitySurface = surface;
  document.body.classList.toggle("is-utility-page", Boolean(surface));
  if (elements.searchPage) elements.searchPage.hidden = surface !== "search";
  if (elements.personalisePage) elements.personalisePage.hidden = surface !== "personalise";
  updateBackVisibility();
}

function updateBackVisibility() {
  if (elements.navigationBackButton) {
    elements.navigationBackButton.hidden = navigationTrail.length === 0;
  }
}

async function openGlobalSearch(query) {
  const clean = String(query || "").trim();
  if (!clean) return;
  if (!utilitySurface) navigationTrail.push(captureNavigationPointer());
  closeFind();
  setUtilitySurface("search");
  elements.searchPageSummary.textContent = `Looking across every active and archived thread for “${clean}”.`;
  elements.searchPageResults.innerHTML = '<p class="utility-empty">Looking through the threads…</p>';
  try {
    const results = await storage.searchThreads(clean);
    elements.searchPageSummary.textContent = results.length
      ? `${results.length} thread${results.length === 1 ? "" : "s"} contain a useful match for “${clean}”.`
      : `No active or archived thread contains “${clean}”.`;
    elements.searchPageResults.innerHTML = results.length
      ? results
          .map((result) => {
            const primary = result.matches[0] || null;
            return `<article class="search-catalogue-row">
              <button type="button" data-search-thread="${escapeHtml(result.threadId)}"
                ${primary ? `data-search-task="${escapeHtml(primary.taskId)}"` : ""}>
                <span class="search-catalogue-scope">${result.scope === "archive" ? "Archived" : "Active"}</span>
                <strong>${escapeHtml(result.threadName)}</strong>
                <span>${escapeHtml(primary?.title || "Thread name match")}</span>
                ${primary?.excerpt ? `<small>${escapeHtml(primary.excerpt)}</small>` : ""}
              </button>
            </article>`;
          })
          .join("")
      : '<p class="utility-empty">Nothing in the current catalogue matches those words.</p>';
  } catch (error) {
    console.warn("[filum] global search failed:", error);
    elements.searchPageSummary.textContent = "Search remained unavailable while the local server was out of reach.";
    elements.searchPageResults.innerHTML = '<p class="utility-empty">Return to the thread and try again when the server is running.</p>';
  }
}

async function openSearchResult(threadId, taskId) {
  setUtilitySurface(null);
  await openThreadById(threadId);
  state.currentStep = "line";
  if (taskId) {
    const index = state.tasks.findIndex((task) => task.id === taskId && !task.done);
    if (index >= 0) state.focusIndex = index;
  }
  normalizeFocus();
  markOuterMeaningful("open-search-result");
  render();
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-task-id="${CSS.escape(taskId || "")}"]`);
    card?.classList.add("is-found");
  });
  updateBackVisibility();
}

async function goBackInFilum() {
  const pointer = navigationTrail.pop();
  if (!pointer) return;
  setUtilitySurface(null);
  if (pointer.threadId && pointer.threadId !== state.threadId) {
    await openThreadById(pointer.threadId);
  }
  state.currentStep = steps.includes(pointer.step) ? pointer.step : DEFAULT_STEP;
  if (pointer.taskId) {
    const index = state.tasks.findIndex((task) => task.id === pointer.taskId);
    if (index >= 0) state.focusIndex = index;
  }
  normalizeFocus();
  render();
  requestAnimationFrame(() => window.scrollTo({ top: pointer.scrollY || 0, behavior: "auto" }));
  updateBackVisibility();
}

// ---- Settings ----------------------------------------------------------------
//
// One settings file on disk (~/.filum/settings.json), mirrored to localStorage
// for offline starts. Filum owns the outer interface controls and note-label
// treatment; Circumspection mounts and persists its own controls separately.

function defaultSettings() {
  return {
    schemaVersion: 1,
    interfaceContrast: "rich",
    textScale: 1,
    spacing: "calm",
    interfaceMotion: "full",
    noteAliases: ["note"],
    noteColor: NOTE_SHADES[0],
    keyboardAssistedNavigation: true,
    gitVersioningEnabled: false,
    abbreviations: [],
  };
}

// Personal abbreviations: written short, read in full. Shared shape with
// server.js sanitizeSettings — keep the two rules in step.
const ABBREVIATION_SHORT = /^[\p{L}\p{N}][\p{L}\p{N}'._-]{0,15}$/u;
const MAX_ABBREVIATIONS = 50;

function normalizeAbbreviations(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const short = typeof item.short === "string" ? item.short.trim() : "";
    const full = typeof item.full === "string" ? item.full.replace(/\s+/g, " ").trim() : "";
    if (!ABBREVIATION_SHORT.test(short) || !full || full.length > 120) continue;
    const key = short.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ short, full });
    if (out.length >= MAX_ABBREVIATIONS) break;
  }
  return out;
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  if (INTERFACE_CONTRASTS.has(raw.interfaceContrast)) {
    base.interfaceContrast = raw.interfaceContrast;
  }
  if (typeof raw.textScale === "number" && Number.isFinite(raw.textScale)) {
    base.textScale = Math.round(Math.min(1.2, Math.max(0.9, raw.textScale)) * 100) / 100;
  }
  if (INTERFACE_SPACING.has(raw.spacing)) {
    base.spacing = raw.spacing;
  }
  if (INTERFACE_MOTION.has(raw.interfaceMotion)) {
    base.interfaceMotion = raw.interfaceMotion;
  }
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
  if (typeof raw.keyboardAssistedNavigation === "boolean") {
    base.keyboardAssistedNavigation = raw.keyboardAssistedNavigation;
  }
  if (typeof raw.gitVersioningEnabled === "boolean") {
    base.gitVersioningEnabled = raw.gitVersioningEnabled;
  }
  base.abbreviations = normalizeAbbreviations(raw.abbreviations);
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
  const root = document.documentElement;
  root.dataset.interfaceContrast = appSettings.interfaceContrast;
  root.dataset.spacing = appSettings.spacing;
  root.dataset.interfaceMotion = appSettings.interfaceMotion;
  root.style.fontSize = `${Math.round(appSettings.textScale * 100)}%`;
  root.style.setProperty("--note-label", appSettings.noteColor);
  const aliases = appSettings.noteAliases.map(escapeRegex).filter(Boolean);
  noteLabelRegex = aliases.length ? new RegExp(`^\\s*(?:${aliases.join("|")})\\s*:`, "i") : null;
  buildAbbreviationIndex();
}

// ---- Abbreviations (read views only) ----------------------------------------
//
// "aca" written anywhere reads as "also called as" wherever Filum shows text
// for reading. Editors always keep exactly what was typed. Matches are whole
// words, case-insensitive; the original stays available as the <abbr> title.
let abbreviationRegex = null;
let abbreviationMap = new Map();

function buildAbbreviationIndex() {
  const list = Array.isArray(appSettings.abbreviations) ? appSettings.abbreviations : [];
  abbreviationMap = new Map(list.map((item) => [item.short.toLowerCase(), item]));
  const alternatives = list
    .map((item) => item.short)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  abbreviationRegex = alternatives.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu")
    : null;
}

function expandPlain(text) {
  const raw = String(text == null ? "" : text);
  if (!abbreviationRegex) return raw;
  return raw.replace(abbreviationRegex, (match) => abbreviationMap.get(match.toLowerCase())?.full || match);
}

function abbreviationHtml(match) {
  const item = abbreviationMap.get(match.toLowerCase());
  if (!item) return escapeHtml(match);
  return `<abbr class="abbr-expanded" title="${escapeHtml(match)}">${escapeHtml(item.full)}</abbr>`;
}

// Escape for HTML, expanding abbreviations into quiet <abbr> elements.
function expandHtml(text) {
  const raw = String(text == null ? "" : text);
  if (!abbreviationRegex) return escapeHtml(raw);
  let out = "";
  let last = 0;
  abbreviationRegex.lastIndex = 0;
  let match;
  while ((match = abbreviationRegex.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, match.index)) + abbreviationHtml(match[0]);
    last = match.index + match[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}

async function persistSettings({ renderApp = true } = {}) {
  appSettings = normalizeSettings(appSettings);
  applySettings();
  saveSettingsMirror();
  if (renderApp) render();
  const requested = cloneSerializable(appSettings);
  const version = ++settingsPersistVersion;
  try {
    const saved = normalizeSettings(await storage.saveSettings(requested));
    if (version !== settingsPersistVersion) return;
    const changedByServer = JSON.stringify(saved) !== JSON.stringify(requested);
    appSettings = saved;
    applySettings();
    saveSettingsMirror();
    if (changedByServer) {
      if (renderApp) render();
      syncPrefsPanelValues();
    }
    setStatus("Preferences saved");
  } catch (err) {
    console.warn("[filum] settings save failed, keeping local copy:", err);
    if (version === settingsPersistVersion) {
      setStatus("Preferences kept locally — server not reachable");
    }
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
  const first = elements.prefsPanel.querySelector("input, select, button");
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
    <section class="prefs-section" aria-labelledby="prefsFilumTitle">
      <h3 id="prefsFilumTitle" class="prefs-section-title">Filum</h3>
      <div class="prefs-field">
        <label for="prefsExposure">Exposure</label>
        <select id="prefsExposure">
          <option value="soft" ${appSettings.interfaceContrast === "soft" ? "selected" : ""}>Soft</option>
          <option value="balanced" ${appSettings.interfaceContrast === "balanced" ? "selected" : ""}>Balanced</option>
          <option value="rich" ${appSettings.interfaceContrast === "rich" ? "selected" : ""}>Rich</option>
        </select>
      </div>
      <div class="prefs-field">
        <label for="prefsTextScale">Text size · <output id="prefsTextScaleOutput" for="prefsTextScale">${Math.round(appSettings.textScale * 100)}%</output></label>
        <input id="prefsTextScale" type="range" min="90" max="120" step="5"
               value="${Math.round(appSettings.textScale * 100)}" />
      </div>
      <div class="prefs-field">
        <label class="prefs-toggle" for="prefsKeyboard">
          <span>Keyboard assisted navigation</span>
          <input id="prefsKeyboard" type="checkbox" ${appSettings.keyboardAssistedNavigation ? "checked" : ""}>
        </label>
        <small class="field-hint">${shortcutHelpText()}</small>
      </div>
    </section>
    <section class="prefs-section prefs-abbreviations" aria-labelledby="prefsAbbrTitle">
      <h3 id="prefsAbbrTitle" class="prefs-section-title">Abbreviations</h3>
      <ul id="prefsAbbrList" class="abbr-list"></ul>
      <div class="abbr-add">
        <input id="prefsAbbrShort" type="text" maxlength="16" autocomplete="off" spellcheck="false"
               placeholder="aca" aria-label="Abbreviation">
        <input id="prefsAbbrFull" type="text" maxlength="120" autocomplete="off"
               placeholder="also called as" aria-label="Reads as">
        <button id="prefsAbbrAdd" class="ghost-button mini-edit" type="button">Add</button>
      </div>
      <small class="field-hint">Written short anywhere, read in full. Editors keep what you typed.</small>
    </section>
    <button id="openPersonaliseButton" class="personalise-button" type="button">Personalise for me</button>`;
  bindPrefsPanel(elements.prefsPanel);
  bindAbbreviationPrefs(elements.prefsPanel);
  elements.prefsPanel.querySelector("#openPersonaliseButton")?.addEventListener("click", openPersonalisePage);
}

function renderAbbreviationList(root) {
  const list = root.querySelector("#prefsAbbrList");
  if (!list) return;
  const items = appSettings.abbreviations || [];
  list.hidden = !items.length;
  list.innerHTML = items
    .map(
      (item) => `
        <li class="abbr-row">
          <span class="abbr-short">${escapeHtml(item.short)}</span>
          <span class="abbr-full">${escapeHtml(item.full)}</span>
          <button class="abbr-remove" type="button" data-abbr-remove="${escapeHtml(item.short)}"
                  aria-label="Remove ${escapeHtml(item.short)}">×</button>
        </li>`
    )
    .join("");
}

function bindAbbreviationPrefs(root) {
  const shortInput = root.querySelector("#prefsAbbrShort");
  const fullInput = root.querySelector("#prefsAbbrFull");
  const addButton = root.querySelector("#prefsAbbrAdd");
  if (!shortInput || !fullInput || !addButton) return;
  renderAbbreviationList(root);
  const add = () => {
    const short = shortInput.value.trim();
    const full = fullInput.value.replace(/\s+/g, " ").trim();
    if (!ABBREVIATION_SHORT.test(short)) {
      shortInput.focus();
      return;
    }
    if (!full) {
      fullInput.focus();
      return;
    }
    const others = (appSettings.abbreviations || []).filter((item) => item.short.toLowerCase() !== short.toLowerCase());
    if (others.length >= MAX_ABBREVIATIONS) {
      setStatus(`Up to ${MAX_ABBREVIATIONS} abbreviations`);
      return;
    }
    appSettings.abbreviations = [...others, { short, full }];
    shortInput.value = "";
    fullInput.value = "";
    renderAbbreviationList(root);
    persistSettings();
    shortInput.focus();
  };
  addButton.addEventListener("click", add);
  [shortInput, fullInput].forEach((input) =>
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (input === shortInput && !fullInput.value.trim()) fullInput.focus();
      else add();
    })
  );
  root.querySelector("#prefsAbbrList")?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-abbr-remove]");
    if (!remove) return;
    const key = remove.dataset.abbrRemove.toLowerCase();
    appSettings.abbreviations = (appSettings.abbreviations || []).filter((item) => item.short.toLowerCase() !== key);
    renderAbbreviationList(root);
    persistSettings();
    shortInput.focus();
  });
}

function shortcutHelpText() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return isMac
    ? "Control–N opens a new knot; Control–W marks the focused knot done."
    : "Alt–N opens a new knot; Alt–W marks the focused knot done.";
}

function openPersonalisePage() {
  navigationTrail.push(captureNavigationPointer());
  closePrefsPanel();
  setUtilitySurface("personalise");
  renderPersonalisePage();
}

function renderPersonalisePage() {
  if (!elements.personaliseContent) return;
  elements.personaliseContent.innerHTML = `
    <section class="personalise-group" aria-labelledby="personaliseFilumTitle">
      <h3 id="personaliseFilumTitle">Filum</h3>
      <div class="prefs-field">
        <label for="prefsSpacing">Spacing</label>
        <select id="prefsSpacing">
          <option value="compact" ${appSettings.spacing === "compact" ? "selected" : ""}>Compact</option>
          <option value="calm" ${appSettings.spacing === "calm" ? "selected" : ""}>Calm</option>
          <option value="open" ${appSettings.spacing === "open" ? "selected" : ""}>Open</option>
        </select>
      </div>
      <div class="prefs-field">
        <label for="prefsInterfaceMotion">Interface motion</label>
        <select id="prefsInterfaceMotion">
          <option value="full" ${appSettings.interfaceMotion === "full" ? "selected" : ""}>Full</option>
          <option value="quiet" ${appSettings.interfaceMotion === "quiet" ? "selected" : ""}>Quiet</option>
          <option value="none" ${appSettings.interfaceMotion === "none" ? "selected" : ""}>None</option>
        </select>
      </div>
      <div class="prefs-field">
        <label for="prefsAliases">Note keywords</label>
        <input id="prefsAliases" type="text" maxlength="120" autocomplete="off"
               value="${escapeHtml(appSettings.noteAliases.join(", "))}">
        <small class="field-hint">Separate keywords with commas.</small>
      </div>
      <div class="prefs-field">
        <span>Keyword shade</span>
        <div class="prefs-swatches">
          ${NOTE_SHADES.map(
            (hex) => `<button type="button" class="prefs-swatch ${hex === appSettings.noteColor ? "is-current" : ""}"
              data-shade="${hex}" style="--swatch:${hex}" aria-label="Use shade ${hex}"></button>`
          ).join("")}
          <input id="prefsColor" type="text" maxlength="7" autocomplete="off"
                 aria-label="Keyword shade as hex" value="${escapeHtml(appSettings.noteColor)}">
        </div>
      </div>
      <div class="prefs-field">
        <label class="prefs-toggle" for="prefsKeyboardAdvanced">
          <span>Keyboard assisted navigation</span>
          <input id="prefsKeyboardAdvanced" type="checkbox" ${appSettings.keyboardAssistedNavigation ? "checked" : ""}>
        </label>
        <small class="field-hint">${shortcutHelpText()}</small>
      </div>
      <div class="prefs-field">
        <label class="prefs-toggle" for="prefsGitVersioning">
          <span>Version thread JSON with Git</span>
          <input id="prefsGitVersioning" type="checkbox" ${appSettings.gitVersioningEnabled ? "checked" : ""}>
        </label>
        <small class="field-hint">Keeps local history in Filum's data directory when Git is available.</small>
      </div>
    </section>
    <div id="circumspectionPrefsMount"></div>`;
  bindPrefsPanel(elements.personaliseContent);
  renderCircumspectionPreferences(elements.personaliseContent);
}

function renderCircumspectionPreferences(container = elements.prefsPanel) {
  const root = container?.querySelector("#circumspectionPrefsMount");
  if (!root || typeof window === "undefined" || typeof CustomEvent !== "function") return;
  // The listener owns its markup, bindings, values, and persistence. In
  // particular, Circumspection settings never enter appSettings or the Filum
  // settings API by accident.
  window.dispatchEvent(
    new CustomEvent("filum:circumspection-preferences-render", {
      detail: { root },
    })
  );
}

function bindPrefsPanel(root) {
  if (!root) return;
  const exposureSelect = root.querySelector("#prefsExposure");
  const textScaleInput = root.querySelector("#prefsTextScale");
  const textScaleOutput = root.querySelector("#prefsTextScaleOutput");
  const spacingSelect = root.querySelector("#prefsSpacing");
  const motionSelect = root.querySelector("#prefsInterfaceMotion");
  const aliasesInput = root.querySelector("#prefsAliases");
  const colorInput = root.querySelector("#prefsColor");
  const keyboardInputs = root.querySelectorAll("#prefsKeyboard, #prefsKeyboardAdvanced");
  const gitInput = root.querySelector("#prefsGitVersioning");

  if (exposureSelect) {
    exposureSelect.addEventListener("change", () => {
      if (!INTERFACE_CONTRASTS.has(exposureSelect.value)) return;
      appSettings.interfaceContrast = exposureSelect.value;
      persistSettings({ renderApp: false });
    });
  }

  if (textScaleInput) {
    const previewTextScale = () => {
      const percent = Math.min(120, Math.max(90, Number(textScaleInput.value) || 100));
      appSettings.textScale = Math.round(percent) / 100;
      if (textScaleOutput) {
        textScaleOutput.value = `${Math.round(percent)}%`;
        textScaleOutput.textContent = `${Math.round(percent)}%`;
      }
      // Invalidate an older settings response while the range is still being
      // dragged, then preview without rebuilding the open preferences DOM.
      settingsPersistVersion += 1;
      applySettings();
      saveSettingsMirror();
    };
    textScaleInput.addEventListener("input", previewTextScale);
    textScaleInput.addEventListener("change", () => {
      previewTextScale();
      persistSettings({ renderApp: false });
    });
  }

  if (spacingSelect) {
    spacingSelect.addEventListener("change", () => {
      if (!INTERFACE_SPACING.has(spacingSelect.value)) return;
      appSettings.spacing = spacingSelect.value;
      persistSettings({ renderApp: false });
    });
  }

  if (motionSelect) {
    motionSelect.addEventListener("change", () => {
      if (!INTERFACE_MOTION.has(motionSelect.value)) return;
      appSettings.interfaceMotion = motionSelect.value;
      persistSettings({ renderApp: false });
    });
  }

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

  root.querySelectorAll("[data-shade]").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      appSettings.noteColor = swatch.dataset.shade;
      syncPrefsPanelValues();
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
      syncPrefsPanelValues();
      persistSettings();
    });
  }
  keyboardInputs.forEach((input) => {
    input.addEventListener("change", () => {
      appSettings.keyboardAssistedNavigation = input.checked;
      persistSettings({ renderApp: false });
      syncPrefsPanelValues();
    });
  });
  gitInput?.addEventListener("change", async () => {
    const requested = gitInput.checked;
    gitInput.disabled = true;
    try {
      const result = await storage.configureVersioning(requested);
      appSettings.gitVersioningEnabled = requested;
      saveSettingsMirror();
      setStatus(
        requested
          ? "Git thread history is on"
          : result.stopRecorded === false
            ? "Git thread history is off; its final marker could not be committed"
            : "Git thread history is off"
      );
    } catch (error) {
      appSettings.gitVersioningEnabled = !requested;
      gitInput.checked = !requested;
      setStatus(error.userMessage || "Git thread history remains unavailable");
    } finally {
      gitInput.disabled = false;
      syncPrefsPanelValues();
    }
  });
}

function syncPrefsPanelValues() {
  [elements.prefsPanel, elements.personaliseContent].forEach((root) => {
    if (!root) return;
    const setValue = (selector, value) => {
      const control = root.querySelector(selector);
      if (control) control.value = value;
    };
    setValue("#prefsExposure", appSettings.interfaceContrast);
    setValue("#prefsTextScale", String(Math.round(appSettings.textScale * 100)));
    setValue("#prefsSpacing", appSettings.spacing);
    setValue("#prefsInterfaceMotion", appSettings.interfaceMotion);
    setValue("#prefsAliases", appSettings.noteAliases.join(", "));
    setValue("#prefsColor", appSettings.noteColor);
    root.querySelectorAll("#prefsKeyboard, #prefsKeyboardAdvanced").forEach((input) => {
      input.checked = appSettings.keyboardAssistedNavigation;
    });
    const gitInput = root.querySelector("#prefsGitVersioning");
    if (gitInput) gitInput.checked = appSettings.gitVersioningEnabled;
    const output = root.querySelector("#prefsTextScaleOutput");
    if (output) {
      const label = `${Math.round(appSettings.textScale * 100)}%`;
      output.value = label;
      output.textContent = label;
    }
    root.querySelectorAll("[data-shade]").forEach((swatch) => {
      swatch.classList.toggle("is-current", swatch.dataset.shade === appSettings.noteColor);
    });
  });
}

// ---- Untangle animation --------------------------------------------------

// Step 2 "Untangle it": reveal the Follow step, then play the knot straightening
// directly into that step's thread — the line you pull resolves into the final
// thread, in place. Honors reduced-motion and trivial task counts.
function playUntangle() {
  const svg = elements.lineSvg;
  const tasks = visibleTasks();
  if (!svg || shouldReduceInterfaceMotion() || tasks.length < 2) {
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
