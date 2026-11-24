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
      writingMeasureCh: 74,
      writingMeasureVersion: 2,
      diaryLayout: "simple-musky",
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
    "circCatalogueView", "circCatalogueHeading", "circNewEntry", "circReturnLiving", "circBinButton",
    "circCatalogueList", "circLive", "circExport",
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  if (ids.some((id) => !el[id])) return;

  const bridge = window.FilumCircumspectionBridge;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  let store = clone(DEFAULT_STORE);
  let currentEntryId = null;
  let currentPageIndex = 0;
  let displayedPageStart = 0;
  let displayedPageEnd = 0;
  let currentView = "outer";
  let mode = "writing";
  let revisionSnapshot = null;
  let outerSnapshot = null;
  let composing = false;
  let changedInVisit = false;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let serverWritable = false;
  let serverReconciled = false; // the mirror has been merged with the server copy
  let saveRetryTimer = null;
  let saveRetryDelay = 0;
  let lastScheduledAt = 0;
  let historyDepth = 0;
  let renderingPreferences = false;
  let catalogueScope = "active";
  const revealTimers = new Map();
  const scheduledEnds = new Set();
  const revealingEnds = new Set();
  const auditedPageBreaks = new Set();
  const transientDraftIds = new Set();
  const circEditor = window.FilumRichText?.enhance(el.circInput, { toolbarPosition: "top" });
  if (!circEditor) return;

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
    document.addEventListener("selectionchange", rememberCaret);
    window.addEventListener("online", () => { if (pendingSave()) persistNow(); });
    el.circField.tabIndex = -1;
    el.circInput.addEventListener("keydown", handleInputKeydown);
    el.circInput.addEventListener("select", keepAppendBoundary);
    el.circInput.addEventListener("click", keepAppendBoundary);
    el.circPrevLeaf.addEventListener("click", () => moveLeaf(-1));
    el.circNextLeaf.addEventListener("click", () => moveLeaf(1));
    el.circTurnLeaf.addEventListener("click", turnLeaf);
    el.circExport.addEventListener("click", () => openExport(activeEntry()?.id, el.circExport));
    el.circDeleteLeaf.addEventListener("click", requestLeafDeletion);
    el.circCancelDeleteLeaf.addEventListener("click", hideDeleteConfirmation);
    el.circConfirmDeleteLeaf.addEventListener("click", deleteCurrentLeaf);
    el.circRevise.addEventListener("click", enterRevision);
    el.circDiscardRevision.addEventListener("click", discardRevision);
    el.circSettleRevision.addEventListener("click", settleRevision);
    el.circNewEntry.addEventListener("click", () => openFreshEntry("new-entry", "R3"));
    el.circReturnLiving.addEventListener("click", returnToLivingPage);
    el.circBinButton.addEventListener("click", () => {
      catalogueScope = catalogueScope === "active" ? "binned" : "active";
      renderCatalogue();
    });
    el.circCatalogueList.addEventListener("click", handleCatalogueAction);
    window.addEventListener("filum:circumspection-preferences-render", renderPreferences);
    window.addEventListener("popstate", handleHistory);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleGlobalKeydown);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
  }

  async function loadStore() {
    const mirror = normalizeStore(readMirror());
    store = mirror || clone(DEFAULT_STORE);
    let serverNeedsSync = false;
    try {
      const response = await fetch("/api/circumspection", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Circumspection load failed (${response.status})`);
      const loaded = normalizeStore(await response.json());
      if (!loaded) throw new Error("Circumspection store was not valid");
      store = mirror ? reconcileStores(loaded, mirror) : loaded;
      serverNeedsSync = mirror ? JSON.stringify(store) !== JSON.stringify(loaded) : false;
      serverWritable = true;
      serverReconciled = true;
      writeMirror();
    } catch (error) {
      serverWritable = false;
      console.warn("[filum] Circumspection is using its local mirror:", error);
      recordAudit("SAVE_FELL_BACK_OFFLINE", { destinationState: "OFFLINE_MIRRORED" });
      writeMirror();
    }
    const migratedBlankEntries = migrateLegacyBlankEntries();
    const migratedWritingMeasure = migrateWritingMeasure();
    currentEntryId = store.activeEntryId;
    applyCircAppearance();
    if (serverNeedsSync || migratedBlankEntries || migratedWritingMeasure) markStoreDirty(true);
  }

  function reconcileStores(serverStore, mirrorStore) {
    const entriesById = new Map(serverStore.entries.map((entry) => [entry.id, entry]));
    for (const mirrorEntry of mirrorStore.entries) {
      const serverEntry = entriesById.get(mirrorEntry.id);
      if (!serverEntry || mirrorEntry.updatedAt >= serverEntry.updatedAt) {
        entriesById.set(mirrorEntry.id, mirrorEntry);
      }
    }
    const entries = [...entriesById.values()];
    const activeCandidates = [mirrorStore.activeEntryId, serverStore.activeEntryId];
    const activeEntryId =
      activeCandidates.find((id) =>
        id && entries.some((entry) => entry.id === id && entry.status !== "binned")
      ) || null;
    const auditById = new Map(serverStore.audit.map((event) => [event.id, event]));
    mirrorStore.audit.forEach((event) => auditById.set(event.id, event));
    const audit = [...auditById.values()]
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .slice(-MAX_AUDIT);
    return {
      schemaVersion: 1,
      settings: mirrorStore.settings,
      activeEntryId,
      entries,
      audit,
    };
  }

  function migrateLegacyBlankEntries() {
    const blanks = store.entries
      .filter((entry) => entry.status === "active" && !entry.content.trim())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (blanks.length < 2) return false;
    blanks.slice(1).forEach((entry) => {
      entry.status = "binned";
    });
    if (store.activeEntryId && blanks.slice(1).some((entry) => entry.id === store.activeEntryId)) {
      store.activeEntryId = blanks[0].id;
    }
    return true;
  }

  function migrateWritingMeasure() {
    if (store.settings.writingMeasureVersion >= 2) return false;
    if (store.settings.writingMeasureCh === 62) store.settings.writingMeasureCh = 74;
    store.settings.writingMeasureVersion = 2;
    return true;
  }

  function applyCircAppearance() {
    const writingMeasure = store.settings.diaryLayout === "wider-musky" ? 88 : 74;
    el.circRoot.style.setProperty("--circ-live-opacity", String(store.settings.liveInkOpacity));
    el.circRoot.style.setProperty("--circ-writing-size", `${store.settings.writingSizePx}px`);
    el.circRoot.style.setProperty("--circ-measure", `${writingMeasure}ch`);
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
    const activeEntryId =
      raw.activeEntryId !== null &&
      seen.has(raw.activeEntryId) &&
      entries.some((entry) => entry.id === raw.activeEntryId && entry.status !== "binned")
        ? raw.activeEntryId
        : null;
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
        writingMeasureCh: boundedNumber(settings.writingMeasureCh, 48, 96, 74),
        writingMeasureVersion: boundedInteger(settings.writingMeasureVersion, 1, 2, 1),
        diaryLayout: ["simple-musky", "wider-musky"].includes(raw.settings.diaryLayout)
          ? raw.settings.diaryLayout
          : boundedNumber(raw.settings.writingMeasureCh, 48, 96, 74) >= 84
            ? "wider-musky"
            : "simple-musky",
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
      status: ["archived", "binned"].includes(raw.status) ? raw.status : "active",
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
      sourceState: normalizeAuditState(raw.sourceState),
      destinationState: normalizeAuditState(raw.destinationState),
      ruleId: typeof raw.ruleId === "string" ? raw.ruleId : null,
      contentLength: Number.isInteger(raw.contentLength) ? raw.contentLength : null,
      settledUntil: Number.isInteger(raw.settledUntil) ? raw.settledUntil : null,
      pageIndex: Number.isInteger(raw.pageIndex) ? raw.pageIndex : null,
      metadata: isObject(raw.metadata) ? raw.metadata : {},
      occurredAt: validDate(raw.occurredAt) ? raw.occurredAt : now(),
    };
  }

  function normalizeAuditState(value) {
    if (typeof value !== "string") return null;
    return {
      writing: "LIVING_PAGE",
      reading: "EARLIER_LEAF_READING",
      revision: "REVISION_ACTIVE",
      catalogue: "CATALOGUE",
      outer: "FILUM_OUTER",
    }[value] || value;
  }

  function readMirror() {
    try { return JSON.parse(localStorage.getItem(MIRROR_KEY) || "null"); }
    catch { return null; }
  }

  function writeMirror() {
    try {
      localStorage.setItem(MIRROR_KEY, JSON.stringify(store));
    } catch {
      // Over quota: the audit trail is a debugging window, the writing is not.
      try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...store, audit: [] })); }
      catch (error) { console.warn("[filum] Circumspection could not write its local mirror:", error); }
    }
  }

  function markStoreDirty(immediate = false) {
    assertStore();
    writeMirror();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistNow(), immediate ? 0 : SAVE_DEBOUNCE_MS);
  }

  function pendingSave() {
    return Boolean(saveTimer || saveRetryTimer || !serverWritable);
  }

  // Every save is attempted. A failure keeps the writing in the local mirror
  // and retries with a gentle backoff (2 s → 15 s) until the server answers;
  // it never silently stops trying for the rest of the session.
  function persistNow() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    discardTransientBlankDraft();
    writeMirror();
    saveChain = saveChain.then(async () => {
      try {
        if (!serverReconciled) await reconcileWithServer();
        const response = await fetch("/api/circumspection", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(store),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Circumspection save failed (${response.status}) ${detail}`);
        }
        serverWritable = true;
        saveRetryDelay = 0;
        if (saveRetryTimer) clearTimeout(saveRetryTimer);
        saveRetryTimer = null;
        recordAudit("SAVE_SUCCEEDED", { destinationState: "SAVED" });
        writeMirror();
        return true;
      } catch (error) {
        console.warn("[filum] Circumspection kept in its local mirror; will retry:", error);
        if (serverWritable) recordAudit("SAVE_FELL_BACK_OFFLINE", { destinationState: "OFFLINE_MIRRORED" });
        serverWritable = false;
        writeMirror();
        scheduleSaveRetry();
        return false;
      }
    });
    return saveChain;
  }

  function scheduleSaveRetry() {
    if (saveRetryTimer) return;
    saveRetryDelay = Math.min(15_000, Math.max(2_000, saveRetryDelay * 2));
    saveRetryTimer = setTimeout(() => {
      saveRetryTimer = null;
      persistNow();
    }, saveRetryDelay);
  }

  // When Filum started without its server, merge whatever the server holds
  // before the first write, so a device-only copy never overwrites it.
  async function reconcileWithServer() {
    const response = await fetch("/api/circumspection", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Circumspection load failed (${response.status})`);
    const loaded = normalizeStore(await response.json());
    if (!loaded) throw new Error("Circumspection store was not valid");
    store = reconcileStores(loaded, store);
    if (currentEntryId && !store.entries.some((entry) => entry.id === currentEntryId)) currentEntryId = store.activeEntryId;
    serverReconciled = true;
  }

  function discardTransientBlankDraft() {
    for (const id of [...transientDraftIds]) {
      const entry = store.entries.find((item) => item.id === id);
      if (entry?.content.trim()) {
        transientDraftIds.delete(id);
        continue;
      }
      store.entries = store.entries.filter((item) => item.id !== id);
      if (store.activeEntryId === id) store.activeEntryId = null;
      if (currentEntryId === id) currentEntryId = null;
      transientDraftIds.delete(id);
      bridge?.updateContext?.({ entryId: null, mode: null, meaningful: false });
    }
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
    const pointedEntry = pointer
      ? store.entries.find((entry) => entry.id === pointer && entry.status !== "binned")
      : null;
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
    transientDraftIds.add(entry.id);
    recordAudit("ENTRY_CREATED", { destinationState: "NEW_ENTRY" });
    return entry;
  }

  function openFreshEntry(trigger, ruleId) {
    cancelRevealQueue();
    const entry = createEntry();
    recordAudit("CIRCUMSPECTION_ROUTE_RESOLVED", {
      ruleId, destinationState: "NEW_ENTRY",
      metadata: { trigger, fallbackUsed: ruleId === "R8", pointerStatus: ruleId === "R8" ? "recovered" : "none" },
    });
    bridge?.updateContext?.({ entryId: entry.id, mode: "writing", meaningful: false });
    openEntry(entry.id, "writing", trigger);
  }

  function openEntry(entryId, nextMode = "writing", trigger = "catalogue-item", pushHistory = true) {
    const entry = store.entries.find((item) => item.id === entryId && item.status !== "binned");
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
    el.circInput.readOnly = nextMode !== "writing";
    showWriting();
    renderEntry();
    // An empty leaf is ready to write on; a written one opens quietly and the
    // caret appears wherever the writer clicks.
    const shownPage = pagesFor(entry)[currentPageIndex];
    if (!shownPage.text.trim()) requestAnimationFrame(() => placeCaret(shownPage.start));
    else requestAnimationFrame(() => el.circField.focus({ preventScroll: true }));
    bridge?.updateContext?.({ entryId: entry.id, mode: nextMode, meaningful: false });
    if (trigger === "catalogue-item") {
      bridge?.updateContext?.({ entryId: entry.id, action: "entry-selected", mode: nextMode, meaningful: true });
    }
    if (pushHistory) pushInnerHistory({ view: "writing", entryId: entry.id, mode: nextMode });
    recordAudit(nextMode === "reading" ? "ENTRY_OPENED_FOR_READING" : "ENTRY_RESUMED", {
      destinationState: nextMode === "reading" ? "EARLIER_LEAF_READING" : "LIVING_PAGE",
      metadata: { trigger },
    });
    if (!transientDraftIds.has(entry.id)) markStoreDirty();
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
    el.circRoot.dataset.view = "writing";
    el.circWritingView.hidden = false;
    el.circCatalogueView.hidden = true;
  }

  function openCatalogue(trigger = "catalogue-strokes", ruleId = "R1", pushHistory = true) {
    enterInner();
    catalogueScope = "active";
    currentView = "catalogue";
    el.circRoot.dataset.view = "catalogue";
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

  function activeEntry() {
    return store.entries.find((entry) => entry.id === currentEntryId && entry.status !== "binned") || null;
  }

  function handleFieldPointer(event) {
    if (event.target.closest("button")) return;
    if (event.target.closest(".rich-toolbar, .rich-mention-menu")) return;
    // Let the browser preserve the exact pointer-derived caret or selection
    // when the user interacts with the editable surface itself.
    if (event.target === el.circInput || el.circInput.contains(event.target)) return;
    if (mode === "revision") el.circRevisionInput.focus({ preventScroll: true });
    else if (store.settings.inkEffect === "none") {
      // A click beside the text continues the leaf; it never jumps to the top.
      event.preventDefault();
      const entry = activeEntry();
      const page = entry ? pagesFor(entry)[currentPageIndex] : null;
      if (page) placeCaret(rememberedCaret(currentPageIndex, page) ?? page.end);
    }
    else if (mode === "writing") focusAppend();
    else el.circInput.focus({ preventScroll: true });
  }

  function acceptCanonicalInput(inputType, forceFinalToken) {
    const entry = activeEntry();
    const directInk = store.settings.inkEffect === "none";
    if (!entry || (mode !== "writing" && !(directInk && mode === "reading"))) return;
    let leaf = el.circInput.value;
    const caretInLeaf = circEditor.hasFocus() ? el.circInput.selectionStart : leaf.length;
    hideDeleteConfirmation();
    const previousContent = entry.content;
    // Write the leaf back into exactly the range it was rendered from. Pages
    // are never re-derived here: what is on screen is what gets replaced.
    const start = displayedPageStart;
    let after = previousContent.slice(displayedPageEnd);
    // The seam between two leaves: a space typed at the end of a leaf that
    // already borders one, or a new paragraph that does, is not doubled.
    if (/[ \t]$/.test(leaf) && /^[ \t]/.test(after)) leaf = leaf.replace(/[ \t]+$/, "");
    if (/\n$/.test(leaf) && /^[ \t]+/.test(after)) after = after.replace(/^[ \t]+/, "");
    const incoming = previousContent.slice(0, start) + leaf + after;
    if (incoming === previousContent) return;
    const caret = start + Math.min(caretInLeaf, leaf.length);
    const priorLength = previousContent.length;
    const edit = changedRange(previousContent, incoming);
    entry.content = incoming;
    entry.manualPageBreaks = offsetsAfterEdit(entry.manualPageBreaks, edit, incoming.length);
    entry.settledUntil = directInk ? incoming.length : Math.min(entry.settledUntil, incoming.length);
    entry.lastMeaningfulAnchor = Math.min(caret, incoming.length);
    entry.lastViewedAnchor = entry.lastMeaningfulAnchor;
    entry.updatedAt = now();
    changedInVisit = true;
    cancelInvalidReveals(incoming.length);
    recordAudit("INPUT_ACCEPTED", {
      sourceState: "LISTENING", destinationState: "COMPOSING",
      metadata: { inputType: allowedInputType(inputType), inputLength: incoming.length },
    });
    const meaningful = Boolean(entry.content.trim());
    if (meaningful && transientDraftIds.has(entry.id)) {
      transientDraftIds.delete(entry.id);
      bridge?.updateContext?.({ entryId: entry.id, action: "input-accepted", mode, meaningful: true });
      markStoreDirty();
    } else if (!transientDraftIds.has(entry.id)) {
      bridge?.updateContext?.({ entryId: entry.id, action: "input-accepted", mode, meaningful: true });
      markStoreDirty();
    }
    el.circListening.classList.add("is-quiet");
    // Follow the caret, not the end of the text: editing in the middle of a
    // full leaf keeps you there while the overflow moves on quietly; typing
    // past the edge carries you onto the next leaf.
    const pages = pagesFor(entry);
    const previousIndex = currentPageIndex;
    currentPageIndex = pageIndexForOffset(pages, caret, previousIndex);
    if (directInk) mode = currentPageIndex === pages.length - 1 ? "writing" : "reading";
    renderEntry({ caret });
    rememberCaret();
    if (!directInk) scheduleCommitted(entry, priorLength, forceFinalToken, false);
    if (currentPageIndex !== previousIndex) animateLeafChange(true);
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

  // ---- Leaves ----------------------------------------------------------------
  //
  // A leaf holds a fixed number of lines of a fixed number of characters for
  // each diary type, independent of window size, zoom, or writing size. The
  // same words therefore always land on the same leaf, and the boundary a
  // leaf was rendered with is the boundary it is written back into.
  //
  // Lines are counted the way they look: a short line ("Theory of self")
  // still takes a whole line, long lines wrap word by word, paragraphs leave
  // a half-line of air. A leaf breaks between words — never inside **bold**,
  // a link, or a list item — and text flows back when earlier text shrinks,
  // because pages are always derived from the whole entry.
  const LEAF_GEOMETRY = {
    "simple-musky": { charsPerLine: 80, lines: 18 },
    "wider-musky": { charsPerLine: 96, lines: 18 },
  };
  const PARAGRAPH_GAP_LINES = 0.5;
  const UNBREAKABLE = /@\[[^\]]+\]\(filum:[a-z]+\/[a-z0-9-]+\)|\[[^\]]+\]\([^)]+\)|\*\*.+?\*\*|__.+?__|\*[^*\n]+?\*|`[^`\n]+`/g;

  function leafGeometry() {
    return LEAF_GEOMETRY[store.settings.diaryLayout] || LEAF_GEOMETRY["simple-musky"];
  }

  function pagesFor(entry) { return paginate(entry.content, entry.manualPageBreaks, leafGeometry(), entry.id); }

  function visibleLength(text) {
    return String(text || "")
      .replace(/@\[([^\]]+)\]\(filum:[a-z]+\/[a-z0-9-]{8,64}\)/gi, "@$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
      .replace(/\*\*|__|\*|`/g, "")
      .length;
  }

  // Greedy word wrap. Returns how many lines the text takes, and — when a
  // line budget is given — the offset of the first word that no longer fits.
  function wrapText(content, from, to, charsPerLine, budget = Infinity) {
    const words = [];
    const pattern = /\S+/g;
    const slice = content.slice(from, to);
    let match;
    while ((match = pattern.exec(slice))) words.push({ start: from + match.index, text: match[0] });
    let lines = 1;
    let lineLength = 0;
    for (const word of words) {
      const length = visibleLength(word.text);
      if (lineLength === 0) {
        lineLength = length;
      } else if (lineLength + 1 + length <= charsPerLine) {
        lineLength += 1 + length;
      } else {
        lines += 1;
        lineLength = length;
      }
      if (lineLength > charsPerLine) {
        lines += Math.floor((lineLength - 1) / charsPerLine);
        lineLength = ((lineLength - 1) % charsPerLine) + 1;
      }
      if (lines > budget) return { lines, breakAt: word.start };
    }
    return { lines, breakAt: null };
  }

  // A break may not land inside a mark or link; slide it back to the start of
  // the span (or give up, if that is the start of the line).
  function safeBreak(content, lineStart, lineEnd, breakAt) {
    const line = content.slice(lineStart, lineEnd);
    UNBREAKABLE.lastIndex = 0;
    let match;
    let point = breakAt;
    while ((match = UNBREAKABLE.exec(line))) {
      const spanStart = lineStart + match.index;
      const spanEnd = spanStart + match[0].length;
      if (spanStart < point && point < spanEnd) point = spanStart;
    }
    return point > lineStart ? point : null;
  }

  function layoutUnits(content, segStart, segEnd) {
    const units = [];
    for (const block of window.FilumRichText.parseBlocks(content.slice(segStart, segEnd))) {
      if (block.type === "pre") {
        units.push({ kind: "pre", start: segStart + block.start, end: segStart + block.end, first: true,
          fixedLines: Math.max(1, block.code.split("\n").length) });
      } else if (block.type === "list") {
        block.items.forEach((item, index) => units.push({
          kind: "item", start: segStart + item.start, end: segStart + item.end, first: index === 0,
          indent: (item.level + 1) * 3,
        }));
      } else {
        block.lines.forEach((line, index) => units.push({
          kind: "line", start: segStart + line.start, end: segStart + line.end, first: index === 0, indent: 0,
        }));
      }
    }
    return units;
  }

  function paginate(content, manualBreaks, geometry, entryId) {
    const pages = [];
    const bounds = [0, ...manualBreaks.filter((offset) => offset > 0 && offset < content.length), content.length];
    if (manualBreaks.includes(content.length) && content.length > 0) bounds.push(content.length);
    for (let i = 0; i < bounds.length - 1; i += 1) {
      paginateSegment(content, bounds[i], bounds[i + 1], geometry, entryId, pages, i === bounds.length - 2);
    }
    return pages.length ? pages : [{ start: 0, end: 0, text: "" }];
  }

  function paginateSegment(content, segStart, segEnd, geometry, entryId, pages, final) {
    const units = layoutUnits(content, segStart, segEnd);
    // A leaf turned by hand ends with the paragraph separator that keeps its
    // words apart from the next leaf's; that separator is not a blank line.
    const tail = units[units.length - 1];
    if (!final && units.length > 1 && tail.kind === "line" && tail.first && tail.start === tail.end) units.pop();
    const budget = geometry.lines;
    let page = null;
    let used = 0;
    const open = (start) => { page = { start, end: start, filled: false }; used = 0; };
    const close = (automatic) => {
      pages.push({ start: page.start, end: page.end, text: content.slice(page.start, page.end) });
      if (automatic) auditAutoBreak(entryId, page.end);
    };
    open(units.length ? units[0].start : segStart);
    for (const unit of units) {
      let from = unit.start;
      let firstPiece = true;
      const width = Math.max(20, geometry.charsPerLine - (unit.indent || 0));
      for (;;) {
        const gap = unit.first && firstPiece && page.filled ? PARAGRAPH_GAP_LINES : 0;
        const cost = unit.kind === "pre" ? unit.fixedLines : wrapText(content, from, unit.end, width).lines;
        const room = budget - used - gap;
        if (cost <= room || (!page.filled && (unit.kind !== "line" || cost <= budget))) {
          if (!page.filled) page.start = from;
          page.end = unit.end;
          page.filled = true;
          used += gap + cost;
          break;
        }
        const lines = Math.floor(page.filled ? room : budget);
        const split = unit.kind === "line" && lines >= 1
          ? wrapText(content, from, unit.end, width, lines).breakAt
          : null;
        const point = split === null ? null : safeBreak(content, unit.start, unit.end, split);
        if (point !== null && point > from) {
          if (!page.filled) page.start = from;
          page.end = from + content.slice(from, point).replace(/\s+$/u, "").length;
          page.filled = true;
          close(true);
          open(point);
          from = point;
          firstPiece = false;
          continue;
        }
        if (!page.filled) {
          // An unbreakable piece taller than a leaf still gets a leaf of its own.
          page.start = from;
          page.end = unit.end;
          page.filled = true;
          used = budget;
          break;
        }
        close(true);
        open(from);
      }
    }
    close(false);
  }

  function auditAutoBreak(entryId, offset) {
    const key = `${entryId}:${offset}`;
    if (activeEntry()?.id !== entryId || auditedPageBreaks.has(key)) return;
    auditedPageBreaks.add(key);
    recordAudit("AUTO_PAGE_BREAK_CREATED", {
      destinationState: "NEXT_PAGE_PREPARED", metadata: { automatic: true, breakOffset: offset },
    });
  }

  // The leaf a caret belongs to. Between leaves (in the space or blank line
  // that separates them) it belongs to the leaf before.
  function pageIndexForOffset(pages, offset, preferred) {
    const containing = [];
    pages.forEach((page, index) => {
      if (page.start <= offset && offset <= page.end) containing.push(index);
    });
    if (containing.includes(preferred)) return preferred;
    if (containing.length) return containing[0];
    let index = 0;
    pages.forEach((page, i) => { if (page.end < offset) index = i; });
    return index;
  }

  // ---- Where the caret was, per leaf ----------------------------------------

  const caretMemory = new Map();
  const freshLeafSeparators = new Map(); // entryId -> content length right after an added separator

  function rememberCaret() {
    const entry = activeEntry();
    if (!entry || !circEditor.hasFocus() || currentView !== "writing") return;
    caretMemory.set(`${entry.id}:${currentPageIndex}`, displayedPageStart + el.circInput.selectionStart);
  }

  function rememberedCaret(pageIndex, page) {
    const entry = activeEntry();
    const offset = entry ? caretMemory.get(`${entry.id}:${pageIndex}`) : undefined;
    if (!Number.isInteger(offset) || !page) return null;
    if (offset >= page.start && offset <= page.end) return offset;
    // Words that overflowed since carry the remembered spot just past this
    // leaf's end; it still belongs here, at the end.
    const next = pagesFor(entry)[pageIndex + 1];
    if (offset > page.end && (!next || offset <= next.end)) return page.end;
    return null;
  }

  // Put the caret at an absolute offset on the leaf being shown.
  function placeCaret(offset) {
    const local = Math.max(0, Math.min(offset - displayedPageStart, displayedPageEnd - displayedPageStart));
    circEditor.focusOffset(local);
  }

  // A fresh, empty leaf invites writing; a written leaf waits for a click so
  // no caret blinks over words that are only being read.
  function settleFocus(page) {
    if (!page.text.trim()) placeCaret(page.start);
    else if (circEditor.hasFocus()) el.circField.focus({ preventScroll: true });
  }


  // options.caret: an absolute offset to keep the caret at if the leaf's DOM
  // had to be rebuilt (overflow, flow-back, repagination). The browser's own
  // caret is never touched when the leaf did not change.
  function renderEntry(options = {}) {
    const entry = activeEntry();
    if (!entry) return;
    const pages = pagesFor(entry);
    currentPageIndex = boundedInteger(currentPageIndex, 0, pages.length - 1, pages.length - 1);
    const page = pages[currentPageIndex];
    displayedPageStart = page.start;
    displayedPageEnd = page.end;
    const directInk = store.settings.inkEffect === "none";
    el.circProjection.innerHTML = directInk ? "" : projectionMarkup(entry, page);
    const hadFocus = circEditor.hasFocus();
    const replaced = el.circInput.value !== page.text;
    if (replaced) el.circInput.value = page.text;
    if (Number.isInteger(options.caret) && (replaced || options.forceCaret) && (hadFocus || options.focus)) {
      placeCaret(options.caret);
    }
    el.circProjection.style.setProperty("--circ-blur", `${store.settings.blurPx}px`);
    el.circProjection.style.setProperty("--circ-settle", `${store.settings.revealDurationMs}ms`);
    const living = currentPageIndex === pages.length - 1;
    const reading = mode === "reading";
    const blankLeaf = !page.text.trim();
    el.circModeLabel.textContent = mode === "revision" ? "Revision" : living ? "Living Page" : "Earlier Leaf";
    el.circField.classList.toggle("is-revision", mode === "revision");
    el.circListening.classList.toggle("is-quiet", Boolean(page.text) || mode === "revision");
    el.circLeafPosition.textContent = living ? `Living Page · ${pages.length}` : `Leaf ${currentPageIndex + 1} of ${pages.length}`;
    el.circPrevLeaf.disabled = currentPageIndex === 0;
    // From a written living page, the arrow turns to a fresh leaf; only an
    // empty leaf has nothing beyond it.
    el.circNextLeaf.disabled = living && blankLeaf;
    el.circNextLeaf.setAttribute("aria-label", living ? "Turn to a fresh leaf" : "Next leaf");
    el.circRevise.hidden = true;
    el.circDeleteLeaf.hidden = mode === "revision";
    el.circDeleteLeaf.disabled = page.start === page.end;
    el.circTurnLeaf.hidden = mode !== "writing" || !living || !entry.content.trim();
    el.circExport.hidden = mode === "revision" || !entry.content.trim();
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
      const localOffset = offset - displayedPageStart;
      const target = Math.max(0, Math.min(localOffset, el.circInput.value.length));
      el.circInput.focus({ preventScroll: true });
      el.circInput.setSelectionRange(target, target);
    });
  }

  function handleInputKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      turnLeaf();
      return;
    }
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || composing) return;
    if (mode === "revision") return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const offset = el.circInput.selectionStart;
    const length = el.circInput.value.length;
    const pages = pagesFor(activeEntry());
    const hasNext = currentPageIndex < pages.length - 1;
    const hasPrevious = currentPageIndex > 0;

    // Backspace at the very start of a leaf reaches back across the seam;
    // Delete at the very end reaches forward. The leaves read as one text.
    if (event.key === "Backspace" && offset === 0 && hasPrevious) {
      event.preventDefault();
      joinAcrossSeam(-1);
      return;
    }
    if (event.key === "Delete" && offset === length && hasNext) {
      event.preventDefault();
      joinAcrossSeam(1);
      return;
    }
    if (event.shiftKey) return;
    // Arrow keys walk off the edge of a leaf onto the next one. Let the
    // browser move first; only if the caret could not move is it at an edge.
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!(forward && hasNext && offset === length) && !(backward && hasPrevious && offset === 0)) {
      if (forward || backward) {
        const before = offset;
        requestAnimationFrame(() => {
          if (!circEditor.hasFocus() || el.circInput.selectionStart !== before) return;
          if (forward && before === el.circInput.value.length && hasNext) crossLeaf(1);
          if (backward && before === 0 && hasPrevious) crossLeaf(-1);
        });
      }
      return;
    }
    event.preventDefault();
    crossLeaf(forward ? 1 : -1);
  }

  // Move the caret onto the neighbouring leaf: its start going forward, its
  // end going back — exactly where the text continues.
  function crossLeaf(delta) {
    const entry = activeEntry();
    if (!entry) return;
    const pages = pagesFor(entry);
    const next = currentPageIndex + delta;
    if (next < 0 || next >= pages.length) return;
    currentPageIndex = next;
    mode = next === pages.length - 1 ? "writing" : "reading";
    entry.lastViewedAnchor = pages[next].start;
    renderEntry();
    placeCaret(delta > 0 ? pages[next].start : pages[next].end);
    rememberCaret();
    bridge?.updateContext?.({ entryId: entry.id, mode, meaningful: false });
  }

  // Remove what separates this leaf from its neighbour: a manual break, the
  // space or blank line between them, or else one character.
  function joinAcrossSeam(direction) {
    const entry = activeEntry();
    if (!entry) return;
    const pages = pagesFor(entry);
    const page = pages[currentPageIndex];
    const neighbour = pages[currentPageIndex + direction];
    if (!neighbour) return;
    const seamStart = direction < 0 ? neighbour.end : page.end;
    const seamEnd = direction < 0 ? page.start : neighbour.start;
    const breakAt = direction < 0 ? page.start : neighbour.start;
    let caret = direction < 0 ? seamStart : page.end;
    if (entry.manualPageBreaks.includes(breakAt)) {
      // A turned leaf joins back first; the paragraph break stays, and a
      // second Backspace merges paragraphs the ordinary way.
      caret = direction < 0 ? page.start : page.end;
      entry.manualPageBreaks = entry.manualPageBreaks.filter((offset) => offset !== breakAt);
      entry.updatedAt = now();
      changedInVisit = true;
      markStoreDirty();
    } else if (seamStart < seamEnd) {
      replaceContent(seamStart, seamEnd, "");
    } else if (direction < 0 && page.start > 0) {
      replaceContent(page.start - 1, page.start, "");
      caret = page.start - 1;
    } else if (direction > 0 && page.end < entry.content.length) {
      replaceContent(page.end, page.end + 1, "");
    }
    const nextPages = pagesFor(entry);
    currentPageIndex = pageIndexForOffset(nextPages, caret, currentPageIndex + Math.min(0, direction));
    mode = currentPageIndex === nextPages.length - 1 ? "writing" : "reading";
    renderEntry({ caret, forceCaret: true, focus: true });
    rememberCaret();
  }

  function replaceContent(start, end, text) {
    const entry = activeEntry();
    const before = entry.content;
    const incoming = before.slice(0, start) + text + before.slice(end);
    const edit = changedRange(before, incoming);
    entry.content = incoming;
    entry.manualPageBreaks = offsetsAfterEdit(entry.manualPageBreaks, edit, incoming.length);
    entry.settledUntil = incoming.length;
    entry.lastMeaningfulAnchor = Math.min(start + text.length, incoming.length);
    entry.lastViewedAnchor = entry.lastMeaningfulAnchor;
    entry.updatedAt = now();
    changedInVisit = true;
    recordAudit("INPUT_ACCEPTED", {
      sourceState: "LISTENING", destinationState: "COMPOSING",
      metadata: { inputType: text ? "insertText" : "deleteContentBackward", inputLength: incoming.length },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "input-accepted", mode, meaningful: true });
    markStoreDirty();
  }

  function handleGlobalKeydown(event) {
    if (el.circRoot.hidden) return;
    // The export dialog owns its own keys; Escape closes it, not Circumspection.
    if (window.FilumCircumspectionExport?.isOpen()) return;
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
    // Typing with no caret placed begins where the writer last was on this
    // leaf (or at its end) — the keystroke itself then lands there.
    if (
      store.settings.inkEffect === "none" &&
      isTextKey(event) &&
      !circEditor.hasFocus() &&
      !(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']"))
    ) {
      const entry = activeEntry();
      if (!entry) return;
      const page = pagesFor(entry)[currentPageIndex];
      const remembered = rememberedCaret(currentPageIndex, page);
      placeCaret(remembered !== null ? remembered : page.end);
      return;
    }
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
    const wasWriting = circEditor.hasFocus();
    let pages = pagesFor(entry);
    const living = currentPageIndex === pages.length - 1;
    if (delta > 0 && living) {
      openFreshLeaf();
      return;
    }
    const next = Math.max(0, Math.min(pages.length - 1, currentPageIndex + delta));
    if (next === currentPageIndex) return;
    hideDeleteConfirmation();
    // Leaving an untouched fresh leaf folds it away again: no blank leaves
    // are left behind at the end of an entry.
    const leaving = pages[currentPageIndex];
    if (living && !leaving.text.trim() && entry.manualPageBreaks.includes(leaving.start) && leaving.start === entry.content.length) {
      entry.manualPageBreaks = entry.manualPageBreaks.filter((offset) => offset !== leaving.start);
      if (freshLeafSeparators.get(entry.id) === entry.content.length && entry.content.endsWith("\n\n")) {
        entry.content = entry.content.slice(0, -2);
        entry.settledUntil = Math.min(entry.settledUntil, entry.content.length);
        entry.lastMeaningfulAnchor = Math.min(entry.lastMeaningfulAnchor, entry.content.length);
        entry.lastViewedAnchor = Math.min(entry.lastViewedAnchor, entry.content.length);
        entry.manualPageBreaks = entry.manualPageBreaks.filter((offset) => offset <= entry.content.length);
      }
      freshLeafSeparators.delete(entry.id);
      markStoreDirty();
      pages = pagesFor(entry);
    }
    currentPageIndex = Math.min(next, pages.length - 1);
    mode = currentPageIndex === pages.length - 1 ? "writing" : "reading";
    entry.lastViewedAnchor = pages[currentPageIndex].start;
    animateLeafChange(false);
    renderEntry();
    bridge?.updateContext?.({ entryId: entry.id, mode, meaningful: false });
    // Return to where the caret last was on this leaf; never park it at the top.
    const page = pages[currentPageIndex];
    const remembered = rememberedCaret(currentPageIndex, page);
    if (wasWriting && remembered !== null) placeCaret(remembered);
    else if (wasWriting) settleFocus(page);
  }

  // The arrow beyond a written living page: a new, empty leaf at the end.
  function openFreshLeaf() {
    const entry = activeEntry();
    if (!entry || !entry.content.trim()) return;
    const pages = pagesFor(entry);
    if (!pages[pages.length - 1].text.trim()) return;
    // A leaf break is also a paragraph break, so words on either side never
    // run together in the stored text (search, counts, excerpts).
    if (!entry.content.endsWith("\n\n")) {
      entry.content += entry.content.endsWith("\n") ? "\n" : "\n\n";
      freshLeafSeparators.set(entry.id, entry.content.length);
    }
    const breakOffset = entry.content.length;
    if (!entry.manualPageBreaks.includes(breakOffset)) {
      entry.manualPageBreaks.push(breakOffset);
      entry.manualPageBreaks.sort((a, b) => a - b);
    }
    entry.settledUntil = entry.content.length;
    entry.updatedAt = now();
    changedInVisit = true;
    recordAudit("MANUAL_PAGE_BREAK_CREATED", {
      destinationState: "NEXT_PAGE_PREPARED", metadata: { automatic: false, breakOffset },
    });
    const nextPages = pagesFor(entry);
    currentPageIndex = nextPages.length - 1;
    mode = "writing";
    hideDeleteConfirmation();
    animateLeafChange(false);
    renderEntry();
    markStoreDirty();
    placeCaret(nextPages[currentPageIndex].start);
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
    const directInk = store.settings.inkEffect === "none";
    if (!entry || (mode !== "writing" && !(directInk && mode === "reading"))) return;
    hideDeleteConfirmation();
    const selectedOffset = circEditor.hasFocus() ? Number(el.circInput.selectionStart) : NaN;
    let breakOffset = Math.max(
      0,
      Math.min(
        displayedPageStart + (Number.isFinite(selectedOffset) ? selectedOffset : el.circInput.value.length),
        entry.content.length
      )
    );
    // The new leaf begins a new paragraph: words either side of the turn are
    // kept apart in the stored text, never run together.
    if (breakOffset > 0 && breakOffset < entry.content.length || (breakOffset > 0 && breakOffset === entry.content.length && !entry.content.endsWith("\n\n"))) {
      const before = entry.content.slice(0, breakOffset);
      const spaces = (entry.content.slice(breakOffset).match(/^[ \t]+/) || [""])[0].length;
      const separator = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
      if (separator || spaces) {
        replaceContent(breakOffset, breakOffset + spaces, separator);
        breakOffset += separator.length;
      }
    }
    if (!entry.manualPageBreaks.includes(breakOffset)) {
      entry.manualPageBreaks.push(breakOffset);
      entry.manualPageBreaks.sort((a, b) => a - b);
    }
    entry.updatedAt = now();
    entry.lastMeaningfulAnchor = breakOffset;
    changedInVisit = true;
    recordAudit("MANUAL_PAGE_BREAK_CREATED", {
      destinationState: "NEXT_PAGE_PREPARED", metadata: { automatic: false, breakOffset },
    });
    bridge?.updateContext?.({ entryId: entry.id, action: "manual-page-break", mode: "writing", meaningful: true });
    const nextPages = pagesFor(entry);
    const nextIndex = nextPages.findIndex((page) => page.start === breakOffset);
    currentPageIndex = nextIndex >= 0 ? nextIndex : nextPages.length - 1;
    animateLeafChange(false);
    renderEntry();
    markStoreDirty();
    focusDirectOffset(breakOffset);
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
    settleFocus(pagesFor(entry)[currentPageIndex]);
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
    const entries = store.entries
      .filter((entry) =>
        catalogueScope === "binned"
          ? entry.status === "binned"
          : entry.status !== "binned" && Boolean(entry.content.trim())
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const hasBlankDraft = store.entries.some(
      (entry) => entry.status === "active" && !entry.content.trim()
    );
    el.circCatalogueHeading.textContent = catalogueScope === "binned" ? "Bin" : "Catalogue";
    el.circBinButton.textContent = catalogueScope === "binned" ? "Catalogue" : "Bin";
    el.circReturnLiving.hidden = !activeEntry();
    el.circNewEntry.hidden = catalogueScope === "binned" || hasBlankDraft;
    if (!entries.length) {
      el.circCatalogueList.innerHTML = `<p class="circ-catalogue-empty">${
        catalogueScope === "binned" ? "The Circumspection bin is empty." : "No leaves have settled here yet."
      }</p>`;
      return;
    }
    el.circCatalogueList.innerHTML = entries.map((entry) => {
      const words = wordCount(entry.content);
      const leaves = pagesFor(entry).length;
      const excerpt = excerptFor(entry.content);
      return `<article class="circ-entry">
        ${
          catalogueScope === "binned"
            ? `<div class="circ-entry-main">
                 <span class="circ-entry-date">${escapeHtml(formatDate(entry.updatedAt))}</span>
                 <span class="circ-entry-excerpt">${escapeHtml(excerpt || "An unwritten leaf")}</span>
                 <span class="circ-entry-meta">${words} ${words === 1 ? "word" : "words"} · about ${leaves} ${leaves === 1 ? "leaf" : "leaves"}</span>
               </div>`
            : `<button class="circ-entry-main" type="button" data-circ-read="${entry.id}"
                       aria-label="Open Circumspection entry edited ${escapeHtml(formatDate(entry.updatedAt))}">
                 <span class="circ-entry-date">${escapeHtml(formatDate(entry.updatedAt))}</span>
                 <span class="circ-entry-excerpt">${escapeHtml(excerpt || "An unwritten leaf")}</span>
                 <span class="circ-entry-meta">${words} ${words === 1 ? "word" : "words"} · about ${leaves} ${leaves === 1 ? "leaf" : "leaves"}</span>
               </button>`
        }
        <div class="circ-entry-actions">
          ${
            catalogueScope === "binned"
              ? `<button class="circ-text-control" type="button" data-circ-restore="${entry.id}">Restore</button>`
              : `<button class="circ-bin-control" type="button" data-circ-export="${entry.id}"
                   aria-label="Export this note as a PDF" title="Export as PDF">
                   <svg viewBox="0 0 24 24" aria-hidden="true">
                     <path d="M12 4v11m0 0-4-4m4 4 4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"></path>
                   </svg>
                 </button>
                 <button class="circ-bin-control" type="button" data-circ-bin="${entry.id}"
                   aria-label="Move this note to the Circumspection bin" title="Move to bin">
                   <svg viewBox="0 0 24 24" aria-hidden="true">
                     <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"></path>
                   </svg>
                 </button>`
          }
        </div>
      </article>`;
    }).join("");
  }

  function handleCatalogueAction(event) {
    const read = event.target.closest("[data-circ-read]");
    const bin = event.target.closest("[data-circ-bin]");
    const restore = event.target.closest("[data-circ-restore]");
    const exporting = event.target.closest("[data-circ-export]");
    if (exporting) openExport(exporting.dataset.circExport, exporting);
    if (read) openEntry(read.dataset.circRead, "reading", "catalogue-item");
    if (bin) moveCatalogueEntry(bin.dataset.circBin, "binned");
    if (restore) moveCatalogueEntry(restore.dataset.circRestore, "active");
  }

  // ---- Export ------------------------------------------------------------------
  //
  // The leaves handed over are the leaves the writer sees — same geometry,
  // same numbering — so "leaf 3 to leaf 7" in the dialog is exactly that.
  function openExport(entryId, returnFocus) {
    const exporter = window.FilumCircumspectionExport;
    const entry = store.entries.find((item) => item.id === entryId);
    if (!exporter || !entry || !entry.content.trim()) return;
    persistNow();
    const layout = store.settings.diaryLayout;
    const showing = currentView === "writing" && activeEntry()?.id === entry.id;
    exporter.open({
      entry: clone(entry),
      pages: pagesFor(entry).map((page) => ({ text: page.text })),
      layout,
      measureCh: layout === "wider-musky" ? 88 : 74,
      lines: leafGeometry().lines,
      currentLeaf: showing ? currentPageIndex : null,
      expandHtml: bridge?.expandAbbreviationsHtml,
      onClose: () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); },
    });
    // Only that an export was opened — never which leaves or what they say.
    recordAudit("DIARY_EXPORT_OPENED");
  }

  function moveCatalogueEntry(entryId, status) {
    const entry = store.entries.find((item) => item.id === entryId);
    if (!entry || !["active", "binned"].includes(status)) return;
    entry.status = status;
    entry.updatedAt = now();
    if (status === "binned" && store.activeEntryId === entry.id) {
      store.activeEntryId = null;
      currentEntryId = null;
      bridge?.updateContext?.({ entryId: null, mode: "catalogue", meaningful: true, action: "entry-binned" });
    }
    markStoreDirty(true);
    renderCatalogue();
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
    writeMirror();
    // A last write that outlives the tab, when there is something unsaved and
    // it fits the browser's keepalive budget. The mirror is the safety net.
    if (!pendingSave() || !serverReconciled) return;
    const body = JSON.stringify(store);
    if (body.length > 60_000) return;
    try {
      fetch("/api/circumspection", {
        method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: true,
      }).catch(() => {});
    } catch { /* the mirror already holds it */ }
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
        <label for="circPrefDiaryLayout">Diary width</label>
        <select id="circPrefDiaryLayout" data-circ-setting="diaryLayout">
          <option value="simple-musky" ${settings.diaryLayout === "simple-musky" ? "selected" : ""}>simple musky diary</option>
          <option value="wider-musky" ${settings.diaryLayout === "wider-musky" ? "selected" : ""}>wider musky diary :)</option>
        </select>
        <small>Both layouts stay centred; the wider diary opens equally to the left and right.</small>
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
        if (key === "diaryLayout") {
          store.settings.writingMeasureCh = value === "wider-musky" ? 88 : 74;
        }
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

  // Excerpts read as words, not markup: "**light**" shows as "light".
  function excerptFor(content) {
    return content
      .replace(/@\[([^\]]+)\]\(filum:[a-z]+\/[a-z0-9-]{8,64}\)/gi, "@$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
      .replace(/\*\*|__|`/g, "")
      .replace(/(^|[^*])\*(?!\*)([^*\n]+?)\*/g, "$1$2")
      .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);
  }
  function wordCount(content) { return (content.trim().match(/\S+/gu) || []).length; }
  function formatDate(value) { return new Date(value).toLocaleString([], { dateStyle: "long", timeStyle: "short" }); }
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
