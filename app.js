const LOCAL_MIRROR_KEY = "filum-state-v1";
const DEFAULT_STEP = "capture";
const PERSIST_DEBOUNCE_MS = 400;
const steps = ["capture", "tangle", "plan", "line"];

const state = {
  threadId: null,
  threadName: "Untitled thread",
  tasks: [],
  currentStep: DEFAULT_STEP,
  focusIndex: 0,
};

let threadList = [];
let isDirty = false;
let isOffline = false;
let persistTimer = null;

const elements = {
  taskForm: document.getElementById("taskForm"),
  taskTitle: document.getElementById("taskTitle"),
  taskUrgency: document.getElementById("taskUrgency"),
  taskEnergy: document.getElementById("taskEnergy"),
  taskType: document.getElementById("taskType"),
  taskNotes: document.getElementById("taskNotes"),
  taskCount: document.getElementById("taskCount"),
  taskPreviewList: document.getElementById("taskPreviewList"),
  miniThreadSvg: document.getElementById("miniThreadSvg"),
  finishAggregationButton: document.getElementById("finishAggregationButton"),
  resetButton: document.getElementById("resetButton"),
  toPlanButton: document.getElementById("toPlanButton"),
  toLineButton: document.getElementById("toLineButton"),
  focusPrevButton: document.getElementById("focusPrevButton"),
  focusNextButton: document.getElementById("focusNextButton"),
  planningList: document.getElementById("planningList"),
  tangleSvg: document.getElementById("tangleSvg"),
  tangleNodes: document.getElementById("tangleNodes"),
  hoverCard: document.getElementById("hoverCard"),
  lineSvg: document.getElementById("lineSvg"),
  linePanel: document.querySelector('.panel[data-step="line"]'),
  linearList: document.getElementById("linearList"),
  focusTitle: document.getElementById("focusTitle"),
  focusMeta: document.getElementById("focusMeta"),
  focusNotes: document.getElementById("focusNotes"),
  stepButtons: Array.from(document.querySelectorAll(".step")),
  panels: Array.from(document.querySelectorAll(".panel")),
  threadSwitcher: document.getElementById("threadSwitcher"),
  saveThreadButton: document.getElementById("saveThreadButton"),
  newThreadButton: document.getElementById("newThreadButton"),
  threadStatus: document.getElementById("threadStatus"),
};

const storage = {
  async listThreads() {
    const res = await fetch("/api/threads", { headers: { accept: "application/json" } });
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
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    return res.json();
  },
};

bootstrap();
registerServiceWorker();

async function bootstrap() {
  bindEvents();
  try {
    threadList = await storage.listThreads();
    let thread;
    if (threadList.length === 0) {
      thread = await storage.createThread("Untitled thread", emptyStateObject());
      threadList = [thread];
    } else {
      thread = await storage.loadThread(threadList[0].id);
    }
    hydrate(thread);
    setStatus(`Saved · ${formatTime(thread.updatedAt)}`);
  } catch (err) {
    console.warn("[filum] starting offline:", err);
    isOffline = true;
    hydrate(loadOfflineMirror());
    setStatus("Working offline — server not reachable");
  }
  populateThreadSwitcher();
  render();
}

function hydrate(thread) {
  state.threadId = thread.id || null;
  state.threadName = thread.name || "Untitled thread";
  const incoming = thread.state || emptyStateObject();
  state.tasks = Array.isArray(incoming.tasks) ? incoming.tasks : [];
  state.currentStep = steps.includes(incoming.currentStep) ? incoming.currentStep : DEFAULT_STEP;
  state.focusIndex = Number.isInteger(incoming.focusIndex) ? incoming.focusIndex : 0;
  if (state.focusIndex >= state.tasks.length) {
    state.focusIndex = Math.max(0, state.tasks.length - 1);
  }
  isDirty = false;
}

function emptyStateObject() {
  return { tasks: [], currentStep: DEFAULT_STEP, focusIndex: 0 };
}

function bindEvents() {
  elements.taskForm.addEventListener("submit", handleAddTask);
  elements.finishAggregationButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      elements.taskTitle.focus();
      return;
    }
    setStep("tangle");
  });
  elements.toPlanButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      setStep("capture");
      return;
    }
    setStep("plan");
  });
  elements.toLineButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      setStep("capture");
      return;
    }
    setStep("line");
  });
  if (elements.focusNextButton) {
    elements.focusNextButton.addEventListener("click", nextFocusTask);
  }
  if (elements.focusPrevButton) {
    elements.focusPrevButton.addEventListener("click", prevFocusTask);
  }
  elements.resetButton.addEventListener("click", resetState);

  if (elements.linePanel) {
    elements.linePanel.addEventListener("keydown", (event) => {
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
      const item = event.target.closest(".linear-item");
      if (!item) return;
      const index = Number(item.dataset.focusIndex);
      if (Number.isInteger(index)) setFocusIndex(index);
    });
    elements.linearList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = event.target.closest(".linear-item");
      if (!item) return;
      event.preventDefault();
      const index = Number(item.dataset.focusIndex);
      if (Number.isInteger(index)) setFocusIndex(index);
    });
  }

  elements.stepButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.stepTarget;
      if ((target === "tangle" || target === "plan" || target === "line") && !state.tasks.length) {
        return;
      }
      setStep(target);
    });
  });

  if (elements.threadSwitcher) {
    elements.threadSwitcher.addEventListener("change", async (event) => {
      const nextId = event.target.value;
      if (!nextId || nextId === state.threadId) return;
      await flushPersistImmediate();
      try {
        const thread = await storage.loadThread(nextId);
        hydrate(thread);
        setStatus(`Opened · ${formatTime(thread.updatedAt)}`);
        render();
      } catch (err) {
        console.warn("[filum] switch failed:", err);
        setStatus("Could not open thread");
      }
    });
  }

  if (elements.saveThreadButton) {
    elements.saveThreadButton.addEventListener("click", handleSaveThread);
  }
  if (elements.newThreadButton) {
    elements.newThreadButton.addEventListener("click", handleNewThread);
  }

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
    urgency: elements.taskUrgency.value,
    energy: elements.taskEnergy.value,
    type: elements.taskType.value,
    notes: elements.taskNotes.value.trim(),
    duration: "",
  });

  if (state.focusIndex >= state.tasks.length - 1) {
    state.focusIndex = state.tasks.length - 1;
  }

  elements.taskForm.reset();
  elements.taskTitle.focus();
  markDirty();
  render();
}

function resetState() {
  state.tasks = [];
  state.currentStep = DEFAULT_STEP;
  state.focusIndex = 0;
  markDirty();
  render();
}

function setFocusIndex(index) {
  if (!state.tasks.length) return;
  const clamped = Math.max(0, Math.min(index, state.tasks.length - 1));
  if (clamped === state.focusIndex) return;
  state.focusIndex = clamped;
  markDirty();
  renderLine();
  renderLineThread();
}

function nextFocusTask() {
  if (!state.tasks.length) return;
  setFocusIndex(state.focusIndex + 1);
}

function prevFocusTask() {
  if (!state.tasks.length) return;
  setFocusIndex(state.focusIndex - 1);
}

function setStep(step) {
  state.currentStep = steps.includes(step) ? step : DEFAULT_STEP;
  markDirty();
  renderStepState();
}

async function handleSaveThread() {
  const proposed = window.prompt("Name this thread", state.threadName);
  if (proposed === null) return;
  const trimmed = proposed.trim() || "Untitled thread";
  state.threadName = trimmed;
  await flushPersistImmediate();
  await refreshThreadList();
  setStatus(`Saved as “${trimmed}”`);
}

async function handleNewThread() {
  if (isDirty) {
    const wantSave = window.confirm("Save current thread before starting a new one?");
    if (wantSave) await flushPersistImmediate();
  }
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
    threadList = await storage.listThreads();
    populateThreadSwitcher();
  } catch (err) {
    console.warn("[filum] list failed:", err);
  }
}

function populateThreadSwitcher() {
  if (!elements.threadSwitcher) return;
  const select = elements.threadSwitcher;
  const current = state.threadId;
  select.innerHTML = "";
  if (!threadList.some((t) => t.id === current) && current) {
    threadList.unshift({ id: current, name: state.threadName, updatedAt: new Date().toISOString() });
  }
  threadList.forEach((thread) => {
    const option = document.createElement("option");
    option.value = thread.id;
    option.textContent = thread.name || "Untitled thread";
    if (thread.id === current) option.selected = true;
    select.appendChild(option);
  });
}

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
    console.warn("[filum] save failed, mirroring locally:", err);
    isOffline = true;
    saveOfflineMirror();
    setStatus(`Working offline — local copy at ${formatTime(new Date().toISOString())}`);
  }
}

function flushPersistOnUnload() {
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

function render() {
  renderStepState();
  renderTaskPreview();
  renderMiniThread();
  renderPlanningList();
  renderVisuals();
  renderLine();
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

function renderTaskPreview() {
  const count = state.tasks.length;
  elements.taskCount.textContent = `${count} task${count === 1 ? "" : "s"}`;

  if (!count) {
    elements.taskPreviewList.innerHTML =
      '<div class="empty-state empty-state--soft">Start with a simple task name. Add details only when they help.</div>';
    return;
  }

  const recent = state.tasks.slice(-3).reverse();
  const overflow = count - recent.length;
  const chips = recent
    .map(
      (task) => `
        <article class="task-chip">
          <strong>${escapeHtml(task.title)}</strong>
          <p>${escapeHtml(summarizeTask(task))}</p>
        </article>
      `
    )
    .join("");
  const more = overflow > 0 ? `<div class="task-chip-more">+${overflow} earlier</div>` : "";

  elements.taskPreviewList.innerHTML = chips + more;
}

function renderMiniThread() {
  const svg = elements.miniThreadSvg;
  if (!svg) return;
  const count = state.tasks.length;
  if (!count) {
    svg.innerHTML =
      '<text x="110" y="92" text-anchor="middle" font-family="Iowan Old Style, Palatino, Georgia, serif" font-size="13" fill="rgba(110,103,92,0.6)">a quiet thread</text>';
    return;
  }
  const width = 220;
  const height = 180;
  const padX = 24;
  const startX = padX;
  const endX = width - padX;
  const stepX = count === 1 ? 0 : (endX - startX) / (count - 1);
  const midY = height / 2;

  const lastIndex = count - 1;
  const segments = [];
  for (let i = 1; i < count; i += 1) {
    const x1 = startX + stepX * (i - 1);
    const x2 = startX + stepX * i;
    const wobble = Math.sin(i * 0.9) * 10;
    const c1x = (x1 + x2) / 2;
    const c1y = midY - wobble;
    segments.push(`M ${x1} ${midY} Q ${c1x} ${c1y} ${x2} ${midY}`);
  }

  const dots = state.tasks
    .map((task, index) => {
      const x = startX + stepX * index;
      const isNew = index === lastIndex;
      const r = isNew ? 5 : 4;
      const cls = isNew ? "mini-node mini-node--enter" : "mini-node";
      return `<circle class="${cls}" cx="${x}" cy="${midY}" r="${r}" />`;
    })
    .join("");

  svg.innerHTML = `
    <g class="mini-thread-line">
      ${segments
        .map(
          (d) =>
            `<path d="${d}" fill="none" stroke="var(--line-strong)" stroke-width="2" stroke-linecap="round" />`
        )
        .join("")}
    </g>
    ${dots}
  `;
}

function renderPlanningList() {
  if (!state.tasks.length) {
    elements.planningList.innerHTML =
      '<div class="empty-state">Your ordered thread will appear here once tasks are added.</div>';
    return;
  }

  elements.planningList.innerHTML = state.tasks
    .map(
      (task, index) => `
        <article class="plan-item" data-task-id="${task.id}">
          <div>
            <div class="plan-item-head">
              <div>
                <strong>${index + 1}. ${escapeHtml(task.title)}</strong>
                <p>${escapeHtml(summarizeTask(task))}</p>
              </div>
              <div class="plan-controls">
                <button class="mini-button" type="button" data-move="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
                <button class="mini-button" type="button" data-move="down" ${index === state.tasks.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
              </div>
            </div>
          </div>
          <div class="plan-side">
            <label class="plan-time-label">
              <span>Time</span>
              <input type="text" value="${escapeHtml(task.duration || "")}" maxlength="40" placeholder="25 min" aria-describedby="duration-hint-${index}" />
              <small id="duration-hint-${index}" class="field-hint">e.g. 25 min, 1h, 1:30</small>
            </label>
          </div>
        </article>
      `
    )
    .join("");

  elements.planningList.querySelectorAll(".plan-item").forEach((item) => {
    const taskId = item.dataset.taskId;
    const input = item.querySelector("input");
    const up = item.querySelector('[data-move="up"]');
    const down = item.querySelector('[data-move="down"]');

    input.addEventListener("input", (event) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const raw = event.target.value;
      const result = validateDuration(raw);
      input.classList.toggle("is-invalid", !result.ok);
      if (result.ok) {
        task.duration = result.normalized;
        markDirty();
        renderLine();
        renderLineThread();
      }
    });
    input.addEventListener("blur", (event) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const result = validateDuration(event.target.value);
      if (!result.ok) {
        event.target.value = task.duration || "";
        input.classList.remove("is-invalid");
      }
    });

    up.addEventListener("click", () => moveTask(taskId, -1));
    down.addEventListener("click", () => moveTask(taskId, 1));
  });
}

function validateDuration(raw) {
  const value = (raw || "").trim();
  if (!value) return { ok: true, normalized: "" };
  const patterns = [
    /^\d{1,3}\s?(m|min|mins|minute|minutes)$/i,
    /^\d{1,3}\s?(h|hr|hrs|hour|hours)$/i,
    /^\d{1,2}:\d{2}$/,
    /^\d{1,3}\s?(s|sec|secs)$/i,
  ];
  if (patterns.some((p) => p.test(value))) return { ok: true, normalized: value };
  return { ok: false, normalized: value };
}

function moveTask(taskId, direction) {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= state.tasks.length) {
    return;
  }

  const [task] = state.tasks.splice(index, 1);
  state.tasks.splice(targetIndex, 0, task);

  if (state.focusIndex === index) {
    state.focusIndex = targetIndex;
  } else if (direction < 0 && state.focusIndex === targetIndex) {
    state.focusIndex += 1;
  } else if (direction > 0 && state.focusIndex === targetIndex) {
    state.focusIndex -= 1;
  }

  markDirty();
  renderPlanningList();
  renderVisuals();
  renderLine();
}

function renderVisuals() {
  renderTangle();
  renderLineThread();
}

function renderTangle() {
  const svg = elements.tangleSvg;
  const layer = elements.tangleNodes;
  const hoverCard = elements.hoverCard;

  layer.innerHTML = "";
  hoverCard.hidden = true;

  if (!state.tasks.length) {
    svg.innerHTML =
      '<title id="tangleTitle">An empty tangle</title><desc id="tangleDesc">No tasks gathered yet.</desc>';
    return;
  }

  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const positions = createTanglePositions(state.tasks, width, height);
  const paths = createTanglePaths(positions);

  const a11y = `
    <title id="tangleTitle">A tangle of ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}</title>
    <desc id="tangleDesc">Each black node is one task. Move across the knot to inspect each piece.</desc>
  `;

  svg.innerHTML =
    a11y +
    paths
      .map(
        (path) =>
          `<path d="${path}" fill="none" stroke="rgba(18,18,18,0.9)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />`
      )
      .join("");

  state.tasks.forEach((task, index) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "task-node";
    node.style.left = `calc(${(positions[index].x / width) * 100}% - 7px)`;
    node.style.top = `calc(${(positions[index].y / height) * 100}% - 7px)`;
    node.setAttribute("aria-label", task.title);

    const showCard = () => {
      hoverCard.hidden = false;
      hoverCard.innerHTML = `<strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(
        summarizeTask(task)
      )}</p>`;
      node.classList.add("is-active");

      const cardX = Math.min(Math.max(positions[index].x + 18, 16), width - 230);
      const cardY = Math.min(Math.max(positions[index].y - 24, 16), height - 120);

      hoverCard.style.left = `${(cardX / width) * 100}%`;
      hoverCard.style.top = `${(cardY / height) * 100}%`;
    };

    const hideCard = () => {
      hoverCard.hidden = true;
      node.classList.remove("is-active");
    };

    node.addEventListener("mouseenter", showCard);
    node.addEventListener("focus", showCard);
    node.addEventListener("mouseleave", hideCard);
    node.addEventListener("blur", hideCard);

    layer.appendChild(node);
  });
}

function renderLine() {
  const currentTask = state.tasks[state.focusIndex] || null;
  if (!currentTask) {
    elements.focusTitle.textContent = "This thread is empty";
    elements.focusMeta.textContent = "Gather a few thoughts in Step 1 first.";
    elements.focusNotes.textContent = "";
  } else {
    elements.focusTitle.textContent = currentTask.title;
    elements.focusMeta.textContent = summarizeTaskMeta(currentTask);
    elements.focusNotes.textContent = currentTask.notes || "No extra notes. Just begin.";
  }

  if (elements.focusPrevButton) {
    elements.focusPrevButton.disabled = !state.tasks.length || state.focusIndex <= 0;
  }
  if (elements.focusNextButton) {
    elements.focusNextButton.disabled =
      !state.tasks.length || state.focusIndex >= state.tasks.length - 1;
  }

  if (!state.tasks.length) {
    elements.linearList.innerHTML =
      '<div class="empty-state">Once you have a sequence, the thread will appear here.</div>';
    return;
  }

  elements.linearList.innerHTML = state.tasks
    .map(
      (task, index) => `
        <article class="linear-item ${index === state.focusIndex ? "is-current" : "is-muted"}"
          data-focus-index="${index}"
          role="button"
          tabindex="0"
          ${index === state.focusIndex ? 'aria-current="step"' : ""}>
          <div class="linear-item-index">Step ${index + 1}</div>
          <strong>${escapeHtml(task.title)}</strong>
          <p>${escapeHtml(task.duration || "No time set")}</p>
        </article>
      `
    )
    .join("");
}

function renderLineThread() {
  const svg = elements.lineSvg;
  if (!state.tasks.length) {
    svg.innerHTML =
      '<title id="lineTitle">An empty thread</title><desc id="lineDesc">No tasks ordered yet.</desc>';
    return;
  }

  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const count = state.tasks.length;
  const startX = 70;
  const endX = width - 70;
  const stepX = count === 1 ? 0 : (endX - startX) / (count - 1);
  const midY = 120;

  const a11y = `
    <title id="lineTitle">A clear thread of ${count} step${count === 1 ? "" : "s"}</title>
    <desc id="lineDesc">Each dot is one task in the chosen order. The current focus is the larger dot.</desc>
  `;

  const dots = state.tasks
    .map((task, index) => {
      const x = startX + stepX * index;
      const isCurrent = index === state.focusIndex;
      return `
        <circle cx="${x}" cy="${midY}" r="${isCurrent ? 10 : 7}" fill="#111111" />
        <text x="${x}" y="${midY - 22}" text-anchor="middle" font-family="Avenir Next, Segoe UI, sans-serif" font-size="11" fill="rgba(22,22,22,0.5)">
          ${index + 1}
        </text>
      `;
    })
    .join("");

  svg.innerHTML = `
    ${a11y}
    <path
      d="M ${startX} ${midY} C ${width * 0.3} ${midY - 16}, ${width * 0.65} ${midY + 16}, ${endX} ${midY}"
      fill="none"
      stroke="rgba(18,18,18,0.86)"
      stroke-width="3"
      stroke-linecap="round"
    />
    ${dots}
  `;
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

function createTanglePositions(tasks, width, height) {
  const positions = [];
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.23;

  tasks.forEach((task, i) => {
    const rand = seededRand(task.id || `task-${i}`);
    const angle = i * 1.82 + rand() * Math.PI * 2;
    const radius = baseRadius + ((i % 5) - 2) * 18 + rand() * 24;
    const x = centerX + Math.cos(angle) * radius + Math.sin(i * 0.7 + rand()) * 36;
    const y = centerY + Math.sin(angle * 1.12) * (radius * 0.68) + Math.cos(i * 0.52 + rand()) * 28;

    positions.push({
      x: clamp(x, 70, width - 70),
      y: clamp(y, 56, height - 56),
    });
  });

  return positions;
}

function createTanglePaths(positions) {
  if (positions.length < 2) {
    return [];
  }

  const order = createInterleavedOrder(positions.length);
  const mainPath = order
    .map((index, pointIndex) => {
      const point = positions[index];
      if (pointIndex === 0) {
        return `M ${point.x} ${point.y}`;
      }

      const prev = positions[order[pointIndex - 1]];
      const control1X = (prev.x + point.x) / 2 + Math.sin(pointIndex * 1.4) * 82;
      const control1Y = prev.y + Math.cos(pointIndex * 0.8) * 58;
      const control2X = (prev.x + point.x) / 2 + Math.cos(pointIndex * 1.1) * -76;
      const control2Y = point.y + Math.sin(pointIndex * 1.2) * 52;

      return `C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${point.x} ${point.y}`;
    })
    .join(" ");

  const loops = positions.slice(0, Math.min(5, positions.length)).map((point, index) => {
    const loopWidth = 90 + index * 26;
    const loopHeight = 48 + index * 18;
    return `M ${point.x - loopWidth / 2} ${point.y}
      C ${point.x - loopWidth / 2} ${point.y - loopHeight},
        ${point.x + loopWidth / 2} ${point.y - loopHeight},
        ${point.x + loopWidth / 2} ${point.y}
      C ${point.x + loopWidth / 2} ${point.y + loopHeight},
        ${point.x - loopWidth / 2} ${point.y + loopHeight},
        ${point.x - loopWidth / 2} ${point.y}`;
  });

  return [mainPath, ...loops];
}

function createInterleavedOrder(count) {
  const left = [];
  const right = [];

  for (let i = 0; i < count; i += 1) {
    if (i % 2 === 0) {
      left.push(i);
    } else {
      right.unshift(i);
    }
  }

  return left.concat(right);
}

function summarizeTask(task) {
  const parts = [task.urgency, task.energy, task.type, task.duration].filter(Boolean);
  const summary = parts.join(" · ");
  if (summary && task.notes) {
    return `${summary} · ${task.notes}`;
  }
  return summary || task.notes || "No extra triage";
}

function summarizeTaskMeta(task) {
  const parts = [task.urgency, task.energy, task.type, task.duration].filter(Boolean);
  return parts.join(" · ") || "Ready to begin.";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}
