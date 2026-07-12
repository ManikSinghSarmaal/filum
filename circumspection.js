(() => {
  "use strict";

  const MIRROR_KEY = "filum:circumspection:v1";
  const MAX_AUDIT = 500;
  const LARGE_PASTE_WORDS = 12;
  const LARGE_PASTE_CHARS = 120;
  const SAVE_DEBOUNCE_MS = 320;
  const OUTWARD_SETTLE_MS = 300;
  const DEFAULT_STORE = {
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
  };

  const ids = [
    "circRoot", "circOpenButton", "circCatalogueButton", "circOutward", "circInnerCatalogue",
    "circWritingView", "circField", "circModeLabel", "circListening", "circProjection", "circInput",
    "circRevisionInput", "circPrevLeaf", "circNextLeaf", "circLeafPosition", "circRevise",
    "circTurnLeaf", "circDeleteLeaf", "circDeleteLeafConfirm", "circCancelDeleteLeaf",
    "circConfirmDeleteLeaf", "circRevisionActions", "circDiscardRevision", "circSettleRevision",
    "circCatalogueView", "circCatalogueHeading", "circNewEntry", "circReturnLiving",
    "circCatalogueList", "circLive",
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  if (ids.some((id) => !el[id])) return;

  const bridge = window.FilumCircumspectionBridge;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  let store = clone(DEFAULT_STORE);
  let currentEntryId = null;
  let currentPageIndex = 0;
  let currentView = "outer";
  let mode = "writing";
  let revisionSnapshot = null;
  let outerSnapshot = null;
  let composing = false;
  let changedInVisit = false;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let serverWritable = false;
  let lastScheduledAt = 0;
  let historyDepth = 0;
  let renderingPreferences = false;
  const revealTimers = new Map();
  const scheduledEnds = new Set();
  const revealingEnds = new Set();
  const auditedPageBreaks = new Set();

  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  window.Circumspection = {
    beforeThreadChange: () => persistNow(),
    getStore: () => clone(store),
    exportAudit: () => clone(store.audit),
  };

  bindEvents();
  loadStore().finally(() => readyResolve());

  function bindEvents() {
    el.circOpenButton.addEventListener("focus", () => recordAudit("DIARY_THRESHOLD_FOCUSED"));
    el.circOpenButton.addEventListener("click", async () => { await ready; routePrimaryIntent(); });
    el.circCatalogueButton.addEventListener("click", async () => {
      await ready;
      recordAudit("CATALOGUE_STROKES_REVEALED");
      openCatalogue("catalogue-strokes", "R1");
    });
    el.circInnerCatalogue.addEventListener("click", () => openCatalogue("catalogue-strokes", "R1"));
    el.circOutward.addEventListener("click", outward);
    el.circField.addEventListener("pointerdown", handleFieldPointer);
    el.circInput.addEventListener("compositionstart", () => { composing = true; });
    el.circInput.addEventListener("compositionend", () => {
      composing = false;
      acceptCanonicalInput("insertFromComposition", true);
    });
    el.circInput.addEventListener("input", (event) => {
      if (!composing) acceptCanonicalInput(event.inputType || "insertText", false);
    });
    el.circInput.addEventListener("paste", handlePaste);
    el.circInput.addEventListener("keydown", handleInputKeydown);
    el.circInput.addEventListener("select", keepAppendBoundary);
    el.circInput.addEventListener("click", keepAppendBoundary);
    el.circPrevLeaf.addEventListener("click", () => moveLeaf(-1));
    el.circNextLeaf.addEventListener("click", () => moveLeaf(1));
    el.circTurnLeaf.addEventListener("click", turnLeaf);
    el.circDeleteLeaf.addEventListener("click", requestLeafDeletion);
    el.circCancelDeleteLeaf.addEventListener("click", hideDeleteConfirmation);
    el.circConfirmDeleteLeaf.addEventListener("click", deleteCurrentLeaf);
    el.circRevise.addEventListener("click", enterRevision);
    el.circDiscardRevision.addEventListener("click", discardRevision);
    el.circSettleRevision.addEventListener("click", settleRevision);
    el.circNewEntry.addEventListener("click", () => openFreshEntry("new-entry", "R3"));
    el.circReturnLiving.addEventListener("click", returnToLivingPage);
    el.circCatalogueList.addEventListener("click", handleCatalogueAction);
    window.addEventListener("filum:circumspection-preferences-render", renderPreferences);
    window.addEventListener("popstate", handleHistory);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
  }

  async function loadStore() {
    const mirror = normalizeStore(readMirror()) || clone(DEFAULT_STORE);
    store = mirror;
    try {
      const response = await fetch("/api/circumspection", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Circumspection load failed (${response.status})`);
      const loaded = normalizeStore(await response.json());
      if (!loaded) throw new Error("Circumspection store was not valid");
      store = loaded;
      serverWritable = true;
      writeMirror();
    } catch (error) {
      serverWritable = false;
      console.warn("[filum] Circumspection is using its local mirror:", error);
      recordAudit("SAVE_FELL_BACK_OFFLINE", { destinationState: "OFFLINE_MIRRORED" });
      writeMirror();
    }
    currentEntryId = store.activeEntryId;
    applyCircAppearance();
  }

  function applyCircAppearance() {
    el.circRoot.style.setProperty("--circ-live-opacity", String(store.settings.liveInkOpacity));
    el.circRoot.style.setProperty("--circ-writing-size", `${store.settings.writingSizePx}px`);
    el.circRoot.style.setProperty("--circ-measure", `${store.settings.writingMeasureCh}ch`);
    el.circRoot.dataset.motion = store.settings.pageMotion;
    el.circRoot.dataset.inkEffect = store.settings.inkEffect;
  }

  function normalizeStore(raw) {
    if (!isObject(raw) || raw.schemaVersion !== 1 || !isObject(raw.settings)) return null;
    if (!Array.isArray(raw.entries) || !Array.isArray(raw.audit)) return null;
    const settings = { ...DEFAULT_STORE.settings, ...raw.settings };
    const entries = [];
    const seen = new Set();
    for (const value of raw.entries) {
      const entry = normalizeEntry(value);
      if (!entry || seen.has(entry.id)) return null;
      seen.add(entry.id);
      entries.push(entry);
    }
    const activeEntryId = raw.activeEntryId === null || seen.has(raw.activeEntryId) ? raw.activeEntryId : null;
    return {
      schemaVersion: 1,
      settings: {
        baseLagMs: boundedNumber(settings.baseLagMs, 0, 1200, 0),
        wordStaggerMs: boundedNumber(settings.wordStaggerMs, 0, 260, 0),
        revealDurationMs: boundedNumber(settings.revealDurationMs, 40, 1800, 60),
        blurPx: boundedNumber(settings.blurPx, 0, 14, 1),
        spreadRadiusPx: boundedNumber(settings.spreadRadiusPx, 0, 72, 28),
        pasteMode: ["settle-immediately", "whisper-quickly", "whisper-normal"].includes(settings.pasteMode)
          ? settings.pasteMode : "settle-immediately",
        pageMotion: ["full", "reduced", "none"].includes(settings.pageMotion)
          ? settings.pageMotion : "full",
        inkEffect: "none",
        revisionMarker: "subtle",
        outwardPolicy: "fast-settle",
        liveInkOpacity: boundedNumber(settings.liveInkOpacity, 0.35, 1, 0.7),
        writingSizePx: boundedNumber(settings.writingSizePx, 16, 24, 19),
        writingMeasureCh: boundedNumber(settings.writingMeasureCh, 48, 78, 62),
      },
      activeEntryId,
      entries,
      audit: raw.audit.filter(isObject).slice(-MAX_AUDIT).map(normalizeAudit).filter(Boolean),
    };
  }

  function normalizeEntry(raw) {
    if (!isObject(raw) || !validId(raw.id) || typeof raw.content !== "string") return null;
    if (raw.content.length > 2_000_000 || !validDate(raw.createdAt) || !validDate(raw.updatedAt)) return null;
    if (!Array.isArray(raw.manualPageBreaks) || !isObject(raw.origin) || !isObject(raw.revision)) return null;
    const breaks = raw.manualPageBreaks.filter(Number.isInteger);
    if (breaks.some((value, index) => value < 0 || value > raw.content.length || (index && value <= breaks[index - 1]))) {
      return null;
    }
    return {
      id: raw.id,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      content: raw.content,
      settledUntil: boundedInteger(raw.settledUntil, 0, raw.content.length, raw.content.length),
      manualPageBreaks: [...breaks],
      lastMeaningfulAnchor: boundedInteger(raw.lastMeaningfulAnchor, 0, raw.content.length, raw.content.length),
      lastViewedAnchor: boundedInteger(raw.lastViewedAnchor, 0, raw.content.length, 0),
      status: raw.status === "archived" ? "archived" : "active",
      origin: {
        threadId: validId(raw.origin.threadId) ? raw.origin.threadId : null,
        threadNameSnapshot:
          typeof raw.origin.threadNameSnapshot === "string" ? raw.origin.threadNameSnapshot.slice(0, 80) : null,
        surface: "filum",
      },
      revision: { lastRevisedAt: validDate(raw.revision.lastRevisedAt) ? raw.revision.lastRevisedAt : null },
    };
  }

  function normalizeAudit(raw) {
    if (!isObject(raw) || !validId(raw.id) || typeof raw.event !== "string") return null;
    return {
      id: raw.id,
      event: raw.event,
      entryId: validId(raw.entryId) ? raw.entryId : null,
      threadId: validId(raw.threadId) ? raw.threadId : null,
      mode: typeof raw.mode === "string" ? raw.mode : null,
      sourceState: typeof raw.sourceState === "string" ? raw.sourceState : null,
      destinationState: typeof raw.destinationState === "string" ? raw.destinationState : null,
      ruleId: typeof raw.ruleId === "string" ? raw.ruleId : null,
      contentLength: Number.isInteger(raw.contentLength) ? raw.contentLength : null,
      settledUntil: Number.isInteger(raw.settledUntil) ? raw.settledUntil : null,
      pageIndex: Number.isInteger(raw.pageIndex) ? raw.pageIndex : null,
      metadata: isObject(raw.metadata) ? raw.metadata : {},
      occurredAt: validDate(raw.occurredAt) ? raw.occurredAt : now(),
    };
  }

  function readMirror() {
    try { return JSON.parse(localStorage.getItem(MIRROR_KEY) || "null"); }
    catch { return null; }
  }

  function writeMirror() {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(store)); }
    catch { /* local storage may be unavailable */ }
  }

  function markStoreDirty(immediate = false) {
    assertStore();
    writeMirror();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(), immediate ? 0 : SAVE_DEBOUNCE_MS);
  }

  function persistNow() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writeMirror();
    if (!serverWritable) return Promise.resolve(false);
    const payload = JSON.stringify(store);
    saveChain = saveChain.then(async () => {
      try {
        const response = await fetch("/api/circumspection", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: payload,
        });
        if (!response.ok) throw new Error(`Circumspection save failed (${response.status})`);
        recordAudit("SAVE_SUCCEEDED", { destinationState: "SAVED" });
        writeMirror();
        return true;
      } catch (error) {
        console.warn("[filum] Circumspection remained in its local mirror:", error);
        serverWritable = false;
        recordAudit("SAVE_FELL_BACK_OFFLINE", { destinationState: "OFFLINE_MIRRORED" });
        writeMirror();
        return false;
      }
    });
    return saveChain;
  }

  function assertStore() {
    for (const entry of store.entries) {
      entry.settledUntil = Math.min(entry.content.length, Math.max(0, entry.settledUntil));
      entry.manualPageBreaks = entry.manualPageBreaks
        .filter((offset, index, all) => Number.isInteger(offset) && offset >= 0 && offset <= entry.content.length && all.indexOf(offset) === index)
        .sort((a, b) => a - b);
    }
    if (store.activeEntryId && !store.entries.some((entry) => entry.id === store.activeEntryId)) {
      store.activeEntryId = null;
    }
    store.audit = store.audit.slice(-MAX_AUDIT);
  }

  function recordAudit(event, details = {}) {
    const entry = activeEntry();
    const thread = bridge?.getContextSnapshot?.() || bridge?.getThreadSnapshot?.() || {};
    store.audit.push({
      id: uuid(),
      event,
      entryId: entry?.id || null,
      threadId: validId(thread.threadId) ? thread.threadId : null,
      mode: ["writing", "reading", "revision", "catalogue"].includes(mode) ? mode : null,
      sourceState: details.sourceState || null,
      destinationState: details.destinationState || null,
      ruleId: details.ruleId || null,
      contentLength: entry?.content.length ?? null,
      settledUntil: entry?.settledUntil ?? null,
      pageIndex: Number.isInteger(currentPageIndex) ? currentPageIndex : null,
      metadata: sanitizeAuditMetadata(details.metadata),
      occurredAt: now(),
    });
    store.audit = store.audit.slice(-MAX_AUDIT);
  }

  function sanitizeAuditMetadata(raw) {
    if (!isObject(raw)) return {};
    const allowed = new Set([
      "trigger", "pasteMode", "pageMotion", "pointerStatus", "inputType", "fallbackUsed", "automatic",
      "largePaste", "recovered", "durationMs", "pendingCount", "wordCount", "pageCount", "breakOffset",
      "queueDepth", "inputLength",
    ]);
    return Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.has(key)));
  }

  function routePrimaryIntent() {
    const thread = bridge?.getContextSnapshot?.() || bridge?.getThreadSnapshot?.() || {};
    const pointer = thread.circumspectionContext?.lastEntryId;
    const lastSurface = thread.navigationContext?.lastMeaningfulSurface;
    const pointedEntry = pointer ? store.entries.find((entry) => entry.id === pointer) : null;
    if (lastSurface === "circumspection" && pointedEntry) {
      recordAudit("CIRCUMSPECTION_ROUTE_RESOLVED", {
        ruleId: "R5", destinationState: "RESUME_ENTRY",
        metadata: { trigger: "diary-body", fallbackUsed: false, pointerStatus: "valid" },
      });
      openEntry(pointedEntry.id, "writing", "diary-body");
      recordAudit("ENTRY_RESUMED", { destinationState: "LIVING_PAGE" });
      return;
    }
    if (pointer && !pointedEntry) {
      recordAudit("STALE_THREAD_POINTER_RECOVERED", {
        ruleId: "R8", destinationState: "NEW_ENTRY", metadata: { recovered: true, pointerStatus: "recovered" },
      });
      openFreshEntry("diary-body", "R8");
      return;
    }
    const ruleId = !thread.threadId ? "R9" : !thread.navigationContext?.lastMeaningfulAction ? "R6" : "R7";
    openFreshEntry("diary-body", ruleId);
  }

  function createEntry() {
    const thread = bridge?.getContextSnapshot?.() || bridge?.getThreadSnapshot?.() || {};
    const timestamp = now();
    const entry = {
      id: uuid(),
      createdAt: timestamp,
      updatedAt: timestamp,
      content: "",
      settledUntil: 0,
      manualPageBreaks: [],
      lastMeaningfulAnchor: 0,
      lastViewedAnchor: 0,
      status: "active",
      origin: {
        threadId: validId(thread.threadId) ? thread.threadId : null,
        threadNameSnapshot: typeof thread.threadName === "string" ? thread.threadName.slice(0, 80) : null,
        surface: "filum",
      },
      revision: { lastRevisedAt: null },
    };
    store.entries.push(entry);
    store.activeEntryId = entry.id;
    currentEntryId = entry.id;
    recordAudit("ENTRY_CREATED", { destinationState: "NEW_ENTRY" });
    markStoreDirty();
    return entry;
  }

  function openFreshEntry(trigger, ruleId) {
    cancelRevealQueue();
    const entry = createEntry();
    recordAudit("CIRCUMSPECTION_ROUTE_RESOLVED", {
      ruleId, destinationState: "NEW_ENTRY",
      metadata: { trigger, fallbackUsed: ruleId === "R8", pointerStatus: ruleId === "R8" ? "recovered" : "none" },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "entry-created", mode: "writing", meaningful: true });
    openEntry(entry.id, "writing", trigger);
  }

  function openEntry(entryId, nextMode = "writing", trigger = "catalogue-item", pushHistory = true) {
    const entry = store.entries.find((item) => item.id === entryId);
    if (!entry) return;
    cancelRevealQueue();
    enterInner();
    currentEntryId = entry.id;
    store.activeEntryId = entry.id;
    currentView = "writing";
    mode = nextMode;
    changedInVisit = false;
    hideDeleteConfirmation();
    const pages = pagesFor(entry);
    currentPageIndex = nextMode === "reading" ? 0 : Math.max(0, pages.length - 1);
    el.circInput.value = entry.content;
    el.circInput.readOnly = nextMode !== "writing";
    showWriting();
    renderEntry();
    if (nextMode === "writing") focusAppend();
    else if (store.settings.inkEffect === "none") focusDirectOffset(pages[0]?.start || 0);
    else requestAnimationFrame(() => el.circInput.focus({ preventScroll: true }));
    bridge?.updateContext?.({ entryId: entry.id, mode: nextMode, meaningful: false });
    if (trigger === "catalogue-item") {
      bridge?.updateContext?.({ entryId: entry.id, action: "entry-selected", mode: nextMode, meaningful: true });
    }
    if (pushHistory) pushInnerHistory({ view: "writing", entryId: entry.id, mode: nextMode });
    recordAudit(nextMode === "reading" ? "ENTRY_OPENED_FOR_READING" : "ENTRY_RESUMED", {
      destinationState: nextMode === "reading" ? "EARLIER_LEAF_READING" : "LIVING_PAGE",
      metadata: { trigger },
    });
    markStoreDirty();
  }

  function enterInner() {
    if (!el.circRoot.hidden) return;
    outerSnapshot = bridge?.captureOuterSnapshot?.() || {
      scrollX: window.scrollX, scrollY: window.scrollY, activeElementId: document.activeElement?.id || null,
    };
    history.replaceState({ ...history.state, filumCircumspection: null }, "");
    historyDepth = 0;
    document.querySelector(".app-shell")?.setAttribute("aria-hidden", "true");
    if ("inert" in HTMLElement.prototype) document.querySelector(".app-shell").inert = true;
    document.body.classList.add("is-circumspecting");
    el.circRoot.hidden = false;
    applyCircAppearance();
  }

  function showWriting() {
    el.circWritingView.hidden = false;
    el.circCatalogueView.hidden = true;
  }

  function openCatalogue(trigger = "catalogue-strokes", ruleId = "R1", pushHistory = true) {
    enterInner();
    currentView = "catalogue";
    mode = "catalogue";
    hideDeleteConfirmation();
    el.circWritingView.hidden = true;
    el.circCatalogueView.hidden = false;
    renderCatalogue();
    if (pushHistory) pushInnerHistory({ view: "catalogue" });
    recordAudit("CATALOGUE_OPENED", {
      ruleId, destinationState: "CATALOGUE", metadata: { trigger, fallbackUsed: false },
    });
    recordAudit("CIRCUMSPECTION_ROUTE_RESOLVED", {
      ruleId, destinationState: "CATALOGUE", metadata: { trigger, fallbackUsed: false },
    });
    requestAnimationFrame(() => el.circCatalogueHeading.focus());
  }

  function pushInnerHistory(target) {
    historyDepth += 1;
    history.pushState({ ...history.state, filumCircumspection: { ...target, depth: historyDepth } }, "");
  }

  function handleHistory(event) {
    const target = event.state?.filumCircumspection;
    if (!target) {
      if (!el.circRoot.hidden) closeInner(false);
      historyDepth = 0;
      return;
    }
    historyDepth = Number.isInteger(target.depth) ? target.depth : 1;
    if (target.view === "catalogue") openCatalogue("history", "R4", false);
    else if (target.entryId && store.entries.some((entry) => entry.id === target.entryId)) {
      openEntry(target.entryId, target.mode || "reading", "history", false);
      recordAudit("CIRCUMSPECTION_ROUTE_RESOLVED", {
        ruleId: "R4", destinationState: target.mode === "writing" ? "LIVING_PAGE" : "EARLIER_LEAF_READING",
        metadata: { trigger: "history", fallbackUsed: false },
      });
    }
  }

  function activeEntry() { return store.entries.find((entry) => entry.id === currentEntryId) || null; }

  function handleFieldPointer(event) {
    if (event.target.closest("button")) return;
    if (mode === "revision") el.circRevisionInput.focus({ preventScroll: true });
    else if (store.settings.inkEffect === "none") el.circInput.focus({ preventScroll: true });
    else if (mode === "writing") focusAppend();
    else el.circInput.focus({ preventScroll: true });
  }

  function acceptCanonicalInput(inputType, forceFinalToken) {
    const entry = activeEntry();
    const directInk = store.settings.inkEffect === "none";
    if (!entry || (mode !== "writing" && !(directInk && mode === "reading"))) return;
    const incoming = el.circInput.value;
    if (incoming === entry.content) return;
    hideDeleteConfirmation();
    const previousContent = entry.content;
    const previousPages = pagesFor(entry);
    const priorLength = previousContent.length;
    const wasEarlierLeaf = currentPageIndex < previousPages.length - 1;
    const edit = changedRange(previousContent, incoming);
    entry.content = incoming;
    entry.manualPageBreaks = offsetsAfterEdit(entry.manualPageBreaks, edit, incoming.length);
    entry.settledUntil = directInk ? incoming.length : Math.min(entry.settledUntil, incoming.length);
    entry.lastMeaningfulAnchor = Math.min(el.circInput.selectionStart ?? incoming.length, incoming.length);
    entry.lastViewedAnchor = entry.lastMeaningfulAnchor;
    entry.updatedAt = now();
    changedInVisit = true;
    cancelInvalidReveals(incoming.length);
    recordAudit("INPUT_ACCEPTED", {
      sourceState: "LISTENING", destinationState: "COMPOSING",
      metadata: { inputType: allowedInputType(inputType), inputLength: incoming.length },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "input-accepted", mode, meaningful: true });
    markStoreDirty();
    el.circListening.classList.add("is-quiet");
    const previousPageCount = previousPages.length;
    const pages = pagesFor(entry);
    currentPageIndex = directInk && wasEarlierLeaf
      ? Math.min(currentPageIndex, pages.length - 1)
      : Math.max(0, pages.length - 1);
    renderEntry();
    if (!directInk) scheduleCommitted(entry, priorLength, forceFinalToken, false);
    if (pages.length > previousPageCount) animateLeafChange(true);
    keepAppendBoundary();
  }

  function allowedInputType(value) {
    const allowed = new Set([
      "insertText", "insertCompositionText", "insertFromComposition", "insertFromPaste", "insertLineBreak",
      "insertParagraph", "deleteContentBackward", "deleteContentForward", "historyUndo", "historyRedo",
    ]);
    return allowed.has(value) ? value : "insertText";
  }

  function changedRange(before, after) {
    let start = 0;
    const sharedLength = Math.min(before.length, after.length);
    while (start < sharedLength && before[start] === after[start]) start += 1;

    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1;
      afterEnd -= 1;
    }
    return {
      start,
      beforeEnd,
      afterEnd,
      delta: (afterEnd - start) - (beforeEnd - start),
    };
  }

  function offsetsAfterEdit(offsets, edit, contentLength) {
    return offsets
      .map((offset) => {
        if (offset <= edit.start) return offset;
        if (offset >= edit.beforeEnd) return offset + edit.delta;
        return edit.afterEnd;
      })
      .filter((offset, index, all) => (
        Number.isInteger(offset)
        && offset >= 0
        && offset <= contentLength
        && all.indexOf(offset) === index
      ))
      .sort((a, b) => a - b);
  }

  function handlePaste(event) {
    if (store.settings.inkEffect === "none") return;
    if (mode !== "writing") return;
    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string") return;
    event.preventDefault();
    const entry = activeEntry();
    const start = entry.content.length;
    entry.content += text;
    entry.updatedAt = now();
    entry.lastMeaningfulAnchor = entry.content.length;
    entry.lastViewedAnchor = entry.content.length;
    el.circInput.value = entry.content;
    changedInVisit = true;
    const largePaste = isLargePaste(text);
    recordAudit("PASTE_ACCEPTED", {
      destinationState: "COMPOSING",
      metadata: { pasteMode: store.settings.pasteMode, largePaste, inputLength: entry.content.length },
    });
    const settleImmediately = store.settings.pasteMode === "settle-immediately" && largePaste;
    if (settleImmediately) {
      entry.settledUntil = entry.content.length;
      recordAudit("PASTE_SETTLED_IMMEDIATELY", { destinationState: "SETTLED", metadata: { largePaste: true } });
    } else {
      scheduleCommitted(entry, start, true, store.settings.pasteMode === "whisper-quickly");
    }
    bridge?.updateContext?.({ entryId: entry.id, action: "paste-accepted", mode: "writing", meaningful: true });
    currentPageIndex = pagesFor(entry).length - 1;
    el.circListening.classList.add("is-quiet");
    renderEntry();
    markStoreDirty();
    focusAppend();
  }

  function isLargePaste(text) {
    return text.length > LARGE_PASTE_CHARS || (text.trim().match(/\S+/gu) || []).length > LARGE_PASTE_WORDS;
  }

  function tokenize(content, forceFinal = false) {
    const tokens = [];
    const pattern = /\S+(?:[ \t]+|\r?\n+|$)/gu;
    let match;
    while ((match = pattern.exec(content))) {
      const text = match[0];
      const lexical = text.trimEnd();
      const end = match.index + text.length;
      const atEnd = end === content.length;
      const committed = /\s$/u.test(text) || /[.!?;:,—–)\]}]$/u.test(lexical) || !atEnd || forceFinal;
      tokens.push({ start: match.index, end, text, committed });
    }
    return tokens;
  }

  function scheduleCommitted(entry, fromOffset, forceFinal, quick) {
    const eligible = tokenize(entry.content, forceFinal)
      .filter((token) => token.committed && token.end > Math.max(fromOffset, entry.settledUntil));
    for (const token of eligible) scheduleToken(entry.id, token.end, quick);
  }

  function scheduleToken(entryId, end, quick) {
    if (scheduledEnds.has(end)) return;
    scheduledEnds.add(end);
    const lag = quick ? 0 : store.settings.baseLagMs;
    const stagger = quick ? 0 : store.settings.wordStaggerMs;
    const startsAt = Math.max(Date.now() + lag, lastScheduledAt + stagger);
    lastScheduledAt = startsAt;
    recordAudit("WORD_COMMITTED", { destinationState: "WORD_COMMITTED", metadata: { queueDepth: scheduledEnds.size } });
    recordAudit("WORD_REVEAL_SCHEDULED", { destinationState: "QUEUED", metadata: { queueDepth: scheduledEnds.size } });
    const startTimer = setTimeout(() => {
      if (activeEntry()?.id !== entryId) return;
      revealingEnds.add(end);
      recordAudit("WORD_REVEAL_STARTED", { sourceState: "QUEUED", destinationState: "REVEALING" });
      renderEntry();
      const duration = quick ? Math.min(40, store.settings.revealDurationMs) : store.settings.revealDurationMs;
      const settleTimer = setTimeout(() => settleToken(entryId, end), duration);
      revealTimers.set(`settle:${end}`, settleTimer);
    }, Math.max(0, startsAt - Date.now()));
    revealTimers.set(`start:${end}`, startTimer);
  }

  function settleToken(entryId, end) {
    const entry = activeEntry();
    if (!entry || entry.id !== entryId) return;
    entry.settledUntil = Math.max(entry.settledUntil, Math.min(end, entry.content.length));
    scheduledEnds.delete(end);
    revealingEnds.delete(end);
    recordAudit("WORD_SETTLED", { sourceState: "REVEALING", destinationState: "SETTLED" });
    renderEntry();
    markStoreDirty();
  }

  function cancelInvalidReveals(contentLength) {
    for (const end of [...scheduledEnds]) {
      if (end <= contentLength) continue;
      clearTimeout(revealTimers.get(`start:${end}`));
      clearTimeout(revealTimers.get(`settle:${end}`));
      revealTimers.delete(`start:${end}`);
      revealTimers.delete(`settle:${end}`);
      scheduledEnds.delete(end);
      revealingEnds.delete(end);
    }
  }

  function cancelRevealQueue() {
    for (const timer of revealTimers.values()) clearTimeout(timer);
    revealTimers.clear();
    scheduledEnds.clear();
    revealingEnds.clear();
    lastScheduledAt = 0;
  }

  function pageCapacity() {
    const width = el.circField.clientWidth || Math.min(window.innerWidth - 48, 760);
    const height = Math.max(380, Math.min(window.innerHeight * 0.58, 720));
    const fontSize = store.settings.writingSizePx;
    const charsPerLine = Math.max(34, Math.floor(width / (fontSize * 0.54)));
    const lines = Math.max(12, Math.floor(height / (fontSize * 1.72)));
    return Math.max(500, charsPerLine * lines);
  }

  function pagesFor(entry) { return paginate(entry.content, entry.manualPageBreaks, pageCapacity(), entry.id); }

  function pagesForLength(length, entry) {
    const content = entry.content.slice(0, length);
    return paginate(content, entry.manualPageBreaks.filter((offset) => offset <= length), pageCapacity(), entry.id);
  }

  function paginate(content, manualBreaks, capacity, entryId) {
    const pages = [];
    const boundaries = [...manualBreaks, content.length];
    let segmentStart = 0;
    const addSegment = (segmentEnd, manual) => {
      const segment = content.slice(segmentStart, segmentEnd);
      const tokens = tokenize(segment, true);
      let pageStart = segmentStart;
      let cursor = segmentStart;
      let count = 0;
      for (const token of tokens) {
        const absoluteStart = segmentStart + token.start;
        const absoluteEnd = segmentStart + token.end;
        if (count && count + token.text.length > capacity) {
          pages.push({ start: pageStart, end: cursor, text: content.slice(pageStart, cursor) });
          const key = `${entryId}:${cursor}`;
          if (activeEntry()?.id === entryId && !auditedPageBreaks.has(key)) {
            auditedPageBreaks.add(key);
            recordAudit("AUTO_PAGE_BREAK_CREATED", {
              destinationState: "NEXT_PAGE_PREPARED", metadata: { automatic: true, breakOffset: cursor },
            });
          }
          pageStart = absoluteStart;
          count = 0;
        }
        cursor = absoluteEnd;
        count += token.text.length;
      }
      cursor = Math.max(cursor, segmentEnd);
      if (cursor > pageStart || !pages.length || manual) {
        pages.push({ start: pageStart, end: cursor, text: content.slice(pageStart, cursor) });
      }
      segmentStart = segmentEnd;
    };
    manualBreaks.forEach((offset) => addSegment(offset, true));
    addSegment(content.length, false);
    if (manualBreaks.at(-1) === content.length) pages.push({ start: content.length, end: content.length, text: "" });
    return pages.length ? pages : [{ start: 0, end: 0, text: "" }];
  }

  function renderEntry() {
    const entry = activeEntry();
    if (!entry) return;
    const pages = pagesFor(entry);
    currentPageIndex = boundedInteger(currentPageIndex, 0, pages.length - 1, pages.length - 1);
    const page = pages[currentPageIndex];
    const directInk = store.settings.inkEffect === "none";
    el.circProjection.innerHTML = directInk ? "" : projectionMarkup(entry, page);
    if (el.circInput.value !== entry.content) el.circInput.value = entry.content;
    el.circProjection.style.setProperty("--circ-blur", `${store.settings.blurPx}px`);
    el.circProjection.style.setProperty("--circ-settle", `${store.settings.revealDurationMs}ms`);
    const living = currentPageIndex === pages.length - 1;
    const reading = mode === "reading";
    el.circModeLabel.textContent = mode === "revision" ? "Revision" : living ? "Living Page" : "Earlier Leaf";
    el.circField.classList.toggle("is-revision", mode === "revision");
    el.circListening.classList.toggle("is-quiet", Boolean(page.text) || mode === "revision");
    el.circLeafPosition.textContent = living ? `Living Page · ${pages.length}` : `Leaf ${currentPageIndex + 1} of ${pages.length}`;
    el.circPrevLeaf.disabled = currentPageIndex === 0;
    el.circNextLeaf.disabled = living;
    el.circRevise.hidden = mode === "revision" || !entry.content;
    el.circDeleteLeaf.hidden = mode === "revision";
    el.circDeleteLeaf.disabled = page.start === page.end;
    el.circTurnLeaf.hidden = mode !== "writing" || !living;
    el.circInput.readOnly = mode === "revision" || (!directInk && (mode !== "writing" || !living));
    el.circInput.setAttribute("aria-readonly", el.circInput.readOnly ? "true" : "false");
    if (reading) el.circLive.textContent = `Reading leaf ${currentPageIndex + 1} of ${pages.length}`;
  }

  function projectionMarkup(entry, page) {
    const pieces = [];
    const tokens = tokenize(page.text, false);
    let cursor = 0;
    for (const token of tokens) {
      if (token.start > cursor) pieces.push(escapeHtml(page.text.slice(cursor, token.start)));
      const absoluteEnd = page.start + token.end;
      const settled = absoluteEnd <= entry.settledUntil;
      const revealing = revealingEnds.has(absoluteEnd);
      const klass = settled ? "is-settled" : revealing ? "is-revealing" : "is-pressure";
      pieces.push(`<span class="circ-token ${klass}">${escapeHtml(token.text)}</span>`);
      cursor = token.end;
    }
    if (cursor < page.text.length) pieces.push(escapeHtml(page.text.slice(cursor)));
    return pieces.join("");
  }

  function keepAppendBoundary() {
    if (store.settings.inkEffect === "none" || mode !== "writing" || el.circInput.readOnly) return;
    requestAnimationFrame(() => {
      const end = el.circInput.value.length;
      el.circInput.setSelectionRange(end, end);
    });
  }

  function focusAppend() {
    requestAnimationFrame(() => {
      el.circInput.focus({ preventScroll: true });
      const end = el.circInput.value.length;
      el.circInput.setSelectionRange(end, end);
    });
  }

  function focusDirectOffset(offset) {
    requestAnimationFrame(() => {
      const target = Math.max(0, Math.min(offset, el.circInput.value.length));
      el.circInput.focus({ preventScroll: true });
      el.circInput.setSelectionRange(target, target);
    });
  }

  function handleInputKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      turnLeaf();
    }
  }

  function handleGlobalKeydown(event) {
    if (el.circRoot.hidden) return;
    if (event.key === "Escape") {
      if (!el.circDeleteLeafConfirm.hidden) {
        event.preventDefault();
        hideDeleteConfirmation();
        return;
      }
      if (mode === "revision") {
        el.circLive.textContent = "Use Discard or Settle changes to leave Revision.";
        return;
      }
      event.preventDefault();
      outward();
      return;
    }
    if (currentView !== "writing" || mode === "revision") return;
    if (event.key === "PageUp") { event.preventDefault(); moveLeaf(-1); return; }
    if (event.key === "PageDown") { event.preventDefault(); moveLeaf(1); return; }
    if (mode === "reading" && store.settings.inkEffect !== "none" && isTextKey(event)) {
      event.preventDefault();
      const entry = activeEntry();
      recordAudit("OLDER_LEAF_INPUT_DETECTED", { sourceState: "EARLIER_LEAF_READING", destinationState: "RAW_INPUT" });
      mode = "writing";
      currentPageIndex = pagesFor(entry).length - 1;
      el.circInput.readOnly = false;
      el.circInput.value = entry.content + event.key;
      recordAudit("AUTO_FORWARDED_TO_LIVING_PAGE", { sourceState: "AUTO_FORWARD", destinationState: "LIVING_PAGE" });
      acceptCanonicalInput("insertText", false);
      focusAppend();
    }
  }

  function isTextKey(event) {
    return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
  }

  function moveLeaf(delta) {
    const entry = activeEntry();
    if (!entry || mode === "revision") return;
    const pages = pagesFor(entry);
    const next = Math.max(0, Math.min(pages.length - 1, currentPageIndex + delta));
    if (next === currentPageIndex) return;
    hideDeleteConfirmation();
    currentPageIndex = next;
    mode = next === pages.length - 1 ? "writing" : "reading";
    entry.lastViewedAnchor = pages[next].start;
    animateLeafChange(false);
    renderEntry();
    bridge?.updateContext?.({ entryId: entry.id, mode, meaningful: false });
    if (store.settings.inkEffect === "none") {
      const targetPage = pagesFor(entry)[currentPageIndex];
      focusDirectOffset(targetPage?.start || 0);
    } else if (mode === "writing") focusAppend();
    else el.circInput.focus({ preventScroll: true });
  }

  function animateLeafChange(automatic) {
    const interfaceMotion = document.documentElement.dataset.interfaceMotion || "full";
    const animate = !reducedMotion && interfaceMotion === "full" && store.settings.pageMotion === "full";
    recordAudit("PAGE_TURN_STARTED", {
      sourceState: "PAGE_ACTIVE", destinationState: "PAGE_TURNING", metadata: { automatic },
    });
    if (animate) {
      el.circField.classList.add("is-leaf-changing");
      setTimeout(() => el.circField.classList.remove("is-leaf-changing"), 190);
    }
    setTimeout(() => recordAudit("PAGE_TURN_COMPLETED", {
      sourceState: "PAGE_TURNING", destinationState: "PAGE_ACTIVE", metadata: { automatic },
    }), animate ? 200 : 0);
  }

  function turnLeaf() {
    const entry = activeEntry();
    if (!entry || mode !== "writing") return;
    hideDeleteConfirmation();
    if (!entry.manualPageBreaks.includes(entry.content.length)) {
      entry.manualPageBreaks.push(entry.content.length);
      entry.manualPageBreaks.sort((a, b) => a - b);
    }
    entry.updatedAt = now();
    entry.lastMeaningfulAnchor = entry.content.length;
    changedInVisit = true;
    recordAudit("MANUAL_PAGE_BREAK_CREATED", {
      destinationState: "NEXT_PAGE_PREPARED", metadata: { automatic: false, breakOffset: entry.content.length },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "manual-page-break", mode: "writing", meaningful: true });
    currentPageIndex = pagesFor(entry).length - 1;
    animateLeafChange(false);
    renderEntry();
    markStoreDirty();
    focusAppend();
  }

  function requestLeafDeletion() {
    const entry = activeEntry();
    if (!entry || mode === "revision") return;
    const page = pagesFor(entry)[currentPageIndex];
    if (!page || page.start === page.end) return;
    el.circDeleteLeafConfirm.hidden = false;
    recordAudit("LEAF_DELETE_REQUESTED", {
      sourceState: currentPageIndex === pagesFor(entry).length - 1 ? "LIVING_PAGE" : "EARLIER_LEAF_READING",
      destinationState: "LEAF_DELETE_PENDING",
      metadata: { breakOffset: page.start, pageCount: pagesFor(entry).length },
    });
    el.circLive.textContent = "Deletion needs confirmation.";
    requestAnimationFrame(() => el.circCancelDeleteLeaf.focus());
  }

  function hideDeleteConfirmation() {
    el.circDeleteLeafConfirm.hidden = true;
  }

  function deleteCurrentLeaf() {
    const entry = activeEntry();
    if (!entry || mode === "revision") return;
    const oldPages = pagesFor(entry);
    const page = oldPages[currentPageIndex];
    if (!page || page.start === page.end) {
      hideDeleteConfirmation();
      return;
    }
    const start = page.start;
    const end = page.end;
    const removedLength = end - start;
    cancelRevealQueue();
    entry.content = entry.content.slice(0, start) + entry.content.slice(end);
    entry.manualPageBreaks = entry.manualPageBreaks
      .filter((offset) => offset < start || offset > end)
      .map((offset) => offset > end ? offset - removedLength : offset)
      .filter((offset, index, all) => all.indexOf(offset) === index)
      .sort((a, b) => a - b);
    entry.settledUntil = offsetAfterDeletion(entry.settledUntil, start, end);
    entry.lastMeaningfulAnchor = offsetAfterDeletion(entry.lastMeaningfulAnchor, start, end);
    entry.lastViewedAnchor = offsetAfterDeletion(entry.lastViewedAnchor, start, end);
    entry.updatedAt = now();
    changedInVisit = true;
    el.circInput.value = entry.content;
    const newPages = pagesFor(entry);
    currentPageIndex = Math.min(currentPageIndex, newPages.length - 1);
    mode = currentPageIndex === newPages.length - 1 ? "writing" : "reading";
    hideDeleteConfirmation();
    recordAudit("LEAF_DELETED", {
      sourceState: "LEAF_DELETE_PENDING",
      destinationState: "REPAGINATE",
      metadata: { breakOffset: start, inputLength: entry.content.length, pageCount: newPages.length },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "leaf-deleted", mode, meaningful: true });
    renderEntry();
    markStoreDirty(true);
    el.circLive.textContent = "Leaf deleted.";
    if (store.settings.inkEffect === "none") {
      const targetPage = pagesFor(entry)[currentPageIndex];
      focusDirectOffset(targetPage?.start || 0);
    } else if (mode === "writing") focusAppend();
    else el.circInput.focus({ preventScroll: true });
  }

  function offsetAfterDeletion(offset, start, end) {
    if (offset <= start) return offset;
    if (offset >= end) return offset - (end - start);
    return start;
  }

  function enterRevision() {
    const entry = activeEntry();
    if (!entry?.content) return;
    hideDeleteConfirmation();
    cancelRevealQueue();
    entry.settledUntil = entry.content.length;
    revisionSnapshot = { content: entry.content, manualPageBreaks: [...entry.manualPageBreaks] };
    mode = "revision";
    el.circProjection.hidden = true;
    el.circInput.hidden = true;
    el.circRevisionInput.hidden = false;
    el.circRevisionInput.value = entry.content;
    el.circRevisionActions.hidden = false;
    renderEntry();
    requestAnimationFrame(() => el.circRevisionInput.focus({ preventScroll: true }));
    recordAudit("REVISION_ENTERED", { destinationState: "REVISION_ACTIVE" });
    bridge?.updateContext?.({ entryId: entry.id, mode: "revision", meaningful: false });
  }

  function settleRevision() {
    const entry = activeEntry();
    if (!entry || mode !== "revision") return;
    entry.content = el.circRevisionInput.value;
    entry.settledUntil = entry.content.length;
    entry.manualPageBreaks = entry.manualPageBreaks.filter((offset) => offset <= entry.content.length);
    entry.updatedAt = now();
    entry.lastMeaningfulAnchor = entry.content.length;
    entry.lastViewedAnchor = Math.min(entry.lastViewedAnchor, entry.content.length);
    entry.revision.lastRevisedAt = entry.updatedAt;
    changedInVisit = true;
    mode = "reading";
    revisionSnapshot = null;
    exitRevisionUi();
    currentPageIndex = Math.min(currentPageIndex, pagesFor(entry).length - 1);
    renderEntry();
    recordAudit("REVISION_COMMITTED", { sourceState: "REVISION_ACTIVE", destinationState: "REPAGINATE" });
    bridge?.updateContext?.({ entryId: entry.id, action: "revision-committed", mode: "reading", meaningful: true });
    markStoreDirty();
  }

  function discardRevision() {
    const entry = activeEntry();
    if (!entry || mode !== "revision") return;
    if (revisionSnapshot) {
      entry.content = revisionSnapshot.content;
      entry.manualPageBreaks = revisionSnapshot.manualPageBreaks;
    }
    revisionSnapshot = null;
    mode = "reading";
    exitRevisionUi();
    renderEntry();
    recordAudit("REVISION_DISCARDED", { sourceState: "REVISION_ACTIVE", destinationState: "EARLIER_LEAF_READING" });
  }

  function exitRevisionUi() {
    el.circRevisionInput.hidden = true;
    el.circProjection.hidden = false;
    el.circInput.hidden = false;
    el.circRevisionActions.hidden = true;
    el.circInput.value = activeEntry()?.content || "";
  }

  function renderCatalogue() {
    const entries = [...store.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    el.circReturnLiving.hidden = !activeEntry();
    if (!entries.length) {
      el.circCatalogueList.innerHTML = '<p class="circ-catalogue-empty">No leaves have settled here yet.</p>';
      return;
    }
    el.circCatalogueList.innerHTML = entries.map((entry) => {
      const words = wordCount(entry.content);
      const leaves = pagesFor(entry).length;
      const excerpt = excerptFor(entry.content);
      return `<article class="circ-entry">
        <p class="circ-entry-date">${escapeHtml(formatDate(entry.createdAt))}</p>
        <p class="circ-entry-excerpt">${escapeHtml(excerpt || "An unwritten leaf")}</p>
        <p class="circ-entry-meta">Updated ${escapeHtml(relativeTime(entry.updatedAt))} · ${words} ${words === 1 ? "word" : "words"} · about ${leaves} ${leaves === 1 ? "leaf" : "leaves"}</p>
        <div class="circ-entry-actions">
          <button class="circ-text-control" type="button" data-circ-read="${entry.id}">Read</button>
          <button class="circ-text-control" type="button" data-circ-revise="${entry.id}">Revise</button>
        </div>
      </article>`;
    }).join("");
  }

  function handleCatalogueAction(event) {
    const read = event.target.closest("[data-circ-read]");
    const revise = event.target.closest("[data-circ-revise]");
    if (read) openEntry(read.dataset.circRead, "reading", "catalogue-item");
    if (revise) {
      openEntry(revise.dataset.circRevise, "reading", "catalogue-item");
      enterRevision();
    }
  }

  function returnToLivingPage() {
    const entry = activeEntry();
    if (entry) openEntry(entry.id, "writing", "catalogue-item");
    else openFreshEntry("new-entry", "R3");
  }

  async function outward() {
    if (el.circRoot.hidden) return;
    recordAudit("OUTWARD_REQUESTED", { sourceState: currentView === "catalogue" ? "CATALOGUE" : "LIVING_PAGE", destinationState: "OUTWARD_PENDING" });
    if (mode === "revision") settleRevision();
    const entry = activeEntry();
    if (entry && entry.settledUntil < entry.content.length) {
      cancelRevealQueue();
      for (const token of tokenize(entry.content, true)) {
        if (token.end > entry.settledUntil) revealingEnds.add(token.end);
      }
      renderEntry();
      await delay(reducedMotion ? 0 : Math.min(OUTWARD_SETTLE_MS, store.settings.revealDurationMs));
      entry.settledUntil = entry.content.length;
      revealingEnds.clear();
      renderEntry();
      markStoreDirty(true);
    }
    if (changedInVisit && entry) {
      bridge?.updateContext?.({ entryId: entry.id, action: "outward-after-edit", mode, meaningful: true });
    }
    recordAudit("OUTWARD_COMPLETED", { sourceState: "OUTWARD_PENDING", destinationState: "FILUM_OUTER" });
    await Promise.allSettled([persistNow(), bridge?.flushThread?.() || Promise.resolve()]);
    closeInner(true);
  }

  function closeInner(rewindHistory) {
    cancelRevealQueue();
    el.circRoot.hidden = true;
    document.body.classList.remove("is-circumspecting");
    const shell = document.querySelector(".app-shell");
    shell?.removeAttribute("aria-hidden");
    if (shell && "inert" in HTMLElement.prototype) shell.inert = false;
    el.circInput.blur();
    el.circRevisionInput.blur();
    currentView = "outer";
    mode = "writing";
    const snapshot = outerSnapshot;
    outerSnapshot = null;
    requestAnimationFrame(() => {
      window.scrollTo(snapshot?.scrollX || 0, snapshot?.scrollY || 0);
      const prior = snapshot?.activeElementId ? document.getElementById(snapshot.activeElementId) : null;
      (prior || el.circOpenButton).focus?.({ preventScroll: true });
    });
    if (rewindHistory && historyDepth > 0) {
      const depth = historyDepth;
      historyDepth = 0;
      history.go(-depth);
    }
  }

  function handleVisibility() {
    if (!document.hidden) {
      if (currentView === "writing") renderEntry();
      return;
    }
    const entry = activeEntry();
    if (entry) entry.settledUntil = entry.content.length;
    cancelRevealQueue();
    writeMirror();
    persistNow();
  }

  function handlePageHide() {
    const entry = activeEntry();
    if (entry) entry.lastMeaningfulAnchor = entry.content.length;
    writeMirror();
  }

  let resizeTimer = null;
  function handleResize() {
    if (el.circRoot.hidden || currentView !== "writing") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const entry = activeEntry();
      if (!entry) return;
      currentPageIndex = Math.min(currentPageIndex, pagesFor(entry).length - 1);
      renderEntry();
    }, 120);
  }

  function renderPreferences(event) {
    const root = event.detail?.root;
    if (!(root instanceof HTMLElement) || renderingPreferences) return;
    renderingPreferences = true;
    const settings = store.settings;
    root.innerHTML = `<section class="circ-prefs-group" aria-labelledby="circPrefsTitle">
      <h3 id="circPrefsTitle" class="circ-prefs-title">Circumspection</h3>
      <div class="circ-pref-field">
        <label for="circPrefInkEffect">Writing effect</label>
        <select id="circPrefInkEffect" data-circ-setting="inkEffect">
          <option value="none" selected>None — direct ink</option>
        </select>
        <small>Characters, caret, selections, and corrections appear directly, with no blur or after-text reveal.</small>
      </div>
      <div class="circ-pref-field">
        <label for="circPrefWritingSize"><span>Writing size</span><output data-circ-output="writingSizePx">${settingValueLabel("writingSizePx", settings.writingSizePx)}</output></label>
        <input id="circPrefWritingSize" type="range" min="16" max="24" step="1" value="${settings.writingSizePx}" data-circ-setting="writingSizePx">
      </div>
      <div class="circ-pref-field">
        <label for="circPrefMeasure"><span>Writing measure</span><output data-circ-output="writingMeasureCh">${settingValueLabel("writingMeasureCh", settings.writingMeasureCh)}</output></label>
        <input id="circPrefMeasure" type="range" min="48" max="78" step="2" value="${settings.writingMeasureCh}" data-circ-setting="writingMeasureCh">
      </div>
      <div class="circ-pref-field">
        <label for="circPrefPaste">Paste behavior</label>
        <select id="circPrefPaste" data-circ-setting="pasteMode">
          <option value="settle-immediately" selected>Insert directly</option>
        </select>
      </div>
      <div class="circ-pref-field">
        <label for="circPrefMotion">Leaf motion</label>
        <select id="circPrefMotion" data-circ-setting="pageMotion">
          <option value="full" ${settings.pageMotion === "full" ? "selected" : ""}>Full</option>
          <option value="reduced" ${settings.pageMotion === "reduced" ? "selected" : ""}>Reduced</option>
          <option value="none" ${settings.pageMotion === "none" ? "selected" : ""}>None</option>
        </select>
      </div>
    </section>`;
    root.querySelectorAll("[data-circ-setting]").forEach((control) => {
      const applyControl = (persist) => {
        const key = control.dataset.circSetting;
        let value = control.type === "range" ? Number(control.value) : control.value;
        if (control.dataset.circTransform === "percent") value /= 100;
        store.settings[key] = value;
        const output = root.querySelector(`[data-circ-output="${key}"]`);
        if (output) output.textContent = settingValueLabel(key, value);
        applyCircAppearance();
        if (currentView === "writing") renderEntry();
        if (persist) markStoreDirty();
      };
      if (control.type === "range") control.addEventListener("input", () => applyControl(false));
      control.addEventListener("change", () => applyControl(true));
    });
    renderingPreferences = false;
  }

  function settingValueLabel(key, value) {
    if (key === "baseLagMs") return value === 0 ? "Live" : `${value} ms`;
    if (key === "revealDurationMs") return `${value} ms`;
    if (key === "blurPx") return value === 0 ? "Crisp" : `${value} px`;
    if (key === "liveInkOpacity") return `${Math.round(value * 100)}%`;
    if (key === "writingSizePx") return `${value} px`;
    if (key === "writingMeasureCh") return `${value} chars`;
    return String(value);
  }

  function excerptFor(content) { return content.replace(/\s+/gu, " ").trim().slice(0, 120); }
  function wordCount(content) { return (content.trim().match(/\S+/gu) || []).length; }
  function formatDate(value) { return new Date(value).toLocaleString([], { dateStyle: "long", timeStyle: "short" }); }
  function relativeTime(value) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
    if (seconds < 60) return "moments ago";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return new Date(value).toLocaleDateString();
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function validId(value) { return typeof value === "string" && /^[a-z0-9-]{8,64}$/i.test(value); }
  function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
  function boundedNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) && number >= min && number <= max ? number : fallback; }
  function boundedInteger(value, min, max, fallback) { return Number.isInteger(value) && value >= min && value <= max ? value : fallback; }
  function now() { return new Date().toISOString(); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = Math.random() * 16 | 0;
      return (character === "x" ? random : (random & 3) | 8).toString(16);
    });
  }
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
