// Circumspection → PDF.
//
// A diary is composed into a print document — one sheet per leaf, drawn in
// the same fonts, ink and paper as the writing view — and handed to the
// browser's print engine. The engine embeds the (system) fonts, keeps text
// selectable and links live; "Save as PDF" then opens the Finder save sheet.
//
// The same document is the preview: on screen it shows the sheets scaled
// down; in print it lays them out one per page at full size. What you see in
// the dialog is exactly what is saved.
(() => {
  "use strict";

  const PREFS_KEY = "filum:circumspection-export:v1";
  const MM_PER_PX = 25.4 / 96;
  const LINE_HEIGHT = 1.72;
  const SLACK_LINES = 1; // a line of air beyond the leaf's budget; fitLeaves() handles the rare excess
  const PAPER = {
    leaf: { label: "Leaf shape", width: 240, height: null, marginX: 24, marginTop: 22, marginBottom: 20 },
    a4: { label: "A4", width: 210, height: 297, marginX: 20, marginTop: 24, marginBottom: 22 },
    letter: { label: "US Letter", width: 215.9, height: 279.4, marginX: 20, marginTop: 24, marginBottom: 22 },
  };
  const WRITING_FONT = `"Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif`;
  const LABEL_FONT = `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`;

  let dialog = null;
  let request = null; // { entry, pages, layout, measureCh, lines, currentLeaf, expandHtml, onClose }
  let renderTimer = null;
  let composeVersion = 0;
  let restoreTitle = null;

  window.FilumCircumspectionExport = { open, isOpen: () => Boolean(dialog?.open) };

  // ---- The dialog ------------------------------------------------------------

  function open(options) {
    const pages = (options.pages || []).filter((page, index, all) =>
      // A blank leaf at the end is only a place to write, not part of the diary.
      page.text.trim() || all.slice(index + 1).some((later) => later.text.trim())
    );
    if (!pages.length) return;
    request = { ...options, pages };
    ensureDialog();
    const total = pages.length;
    const prefs = readPrefs();
    const current = Number.isInteger(options.currentLeaf) ? Math.min(total, options.currentLeaf + 1) : null;
    field("from").max = String(total);
    field("to").max = String(total);
    field("from").value = "1";
    field("to").value = String(total);
    field("title").checked = prefs.titleLeaf !== false;
    field("paper").value = PAPER[prefs.paper] ? prefs.paper : "leaf";
    dialog.querySelector("[data-export-this]").hidden = current === null;
    dialog.querySelector("[data-export-this]").dataset.leaf = String(current || 1);
    dialog.querySelector(".circ-export-meta").textContent = [
      firstLine(options.entry.content, 48) || longDate(options.entry.createdAt),
      `${total} ${total === 1 ? "leaf" : "leaves"}`,
      `${words(pages.map((page) => page.text).join(" ")).toLocaleString()} words`,
    ].join(" · ");
    dialog.showModal();
    field("from").focus();
    compose();
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "circ-export";
    dialog.setAttribute("aria-labelledby", "circExportHeading");
    dialog.innerHTML = `
      <form class="circ-export-form">
        <header class="circ-export-header">
          <h2 id="circExportHeading">Export to PDF</h2>
          <p class="circ-export-meta"></p>
        </header>
        <div class="circ-export-preview" aria-label="Preview of the PDF">
          <div class="circ-export-sizer"><iframe class="circ-export-frame" title="PDF preview" tabindex="-1"></iframe></div>
        </div>
        <fieldset class="circ-export-range">
          <legend class="visually-hidden">Leaves to include</legend>
          <label>From leaf <input data-export="from" type="number" min="1" step="1" inputmode="numeric" /></label>
          <span class="circ-export-dash" aria-hidden="true">–</span>
          <label>to leaf <input data-export="to" type="number" min="1" step="1" inputmode="numeric" /></label>
          <span class="circ-export-quick">
            <button class="circ-text-control" type="button" data-export-all>All</button>
            <button class="circ-text-control" type="button" data-export-this>This leaf</button>
          </span>
        </fieldset>
        <div class="circ-export-options">
          <label class="circ-export-check"><input data-export="title" type="checkbox" /> Title leaf</label>
          <label>Paper
            <select data-export="paper">
              ${Object.entries(PAPER).map(([key, paper]) => `<option value="${key}">${paper.label}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="circ-export-summary" aria-live="polite"></p>
        <footer class="circ-export-actions">
          <button class="circ-text-control" type="button" data-export-cancel>Cancel</button>
          <button class="circ-settle-control" type="button" data-export-save>Save as PDF…</button>
        </footer>
        <p class="circ-export-hint">Your browser's print sheet opens — choose <strong>Save as PDF</strong>, then a folder in Finder.</p>
      </form>`;
    (document.getElementById("circRoot") || document.body).append(dialog);

    dialog.addEventListener("input", (event) => {
      if (event.target.matches("[data-export]")) scheduleCompose(event.target.dataset.export);
    });
    dialog.addEventListener("change", (event) => {
      if (event.target.matches("[data-export='from'], [data-export='to']")) settleRange(event.target.dataset.export);
      if (event.target.matches("[data-export='title'], [data-export='paper']")) {
        writePrefs({ titleLeaf: field("title").checked, paper: field("paper").value });
      }
      scheduleCompose();
    });
    dialog.querySelector("[data-export-all]").addEventListener("click", () => setRange(1, request.pages.length));
    dialog.querySelector("[data-export-this]").addEventListener("click", (event) => {
      const leaf = Number(event.currentTarget.dataset.leaf);
      setRange(leaf, leaf);
    });
    dialog.querySelector("[data-export-save]").addEventListener("click", save);
    dialog.querySelector("[data-export-cancel]").addEventListener("click", () => dialog.close());
    // Enter in a range field settles the range; it never closes the dialog.
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      settleRange();
      compose();
    });
    dialog.addEventListener("close", () => {
      clearTimeout(renderTimer);
      const done = request?.onClose;
      request = null;
      done?.();
    });
  }

  function field(name) { return dialog.querySelector(`[data-export="${name}"]`); }

  function range() {
    const total = request.pages.length;
    const clamp = (value, fallback) => {
      const number = Math.round(Number(value));
      return Number.isFinite(number) && number >= 1 ? Math.min(total, number) : fallback;
    };
    const from = clamp(field("from").value, 1);
    const to = clamp(field("to").value, total);
    return from <= to ? { from, to } : { from: to, to: from };
  }

  // Typing a range end past the other end carries the other along.
  function settleRange(changed) {
    const total = request.pages.length;
    let from = Math.min(total, Math.max(1, Math.round(Number(field("from").value)) || 1));
    let to = Math.min(total, Math.max(1, Math.round(Number(field("to").value)) || total));
    if (from > to) {
      if (changed === "from") to = from;
      else from = to;
    }
    field("from").value = String(from);
    field("to").value = String(to);
  }

  function setRange(from, to) {
    field("from").value = String(from);
    field("to").value = String(to);
    compose();
  }

  function scheduleCompose(changed) {
    clearTimeout(renderTimer);
    // A half-typed number ("1" on the way to "12") waits a beat.
    renderTimer = setTimeout(compose, changed === "from" || changed === "to" ? 260 : 0);
  }

  // ---- Composing the document -------------------------------------------------

  function compose() {
    if (!request || !dialog?.open) return;
    const version = ++composeVersion;
    const { from, to } = range();
    const paper = PAPER[field("paper").value] || PAPER.leaf;
    const withTitle = field("title").checked;
    const selected = request.pages.slice(from - 1, to);
    const count = selected.length + (withTitle ? 1 : 0);
    dialog.querySelector(".circ-export-summary").textContent =
      `${selected.length === 1 ? `Leaf ${from}` : `Leaves ${from}–${to}`} · ${count} ${count === 1 ? "page" : "pages"} · ${paper.label.toLowerCase()}`;
    const geometry = sheetGeometry(paper);
    const frame = dialog.querySelector(".circ-export-frame");
    frame.onload = () => {
      if (version !== composeVersion) return;
      const doc = frame.contentDocument;
      expandAbbreviations(doc);
      fitLeaves(doc);
      scalePreview(frame, geometry);
    };
    frame.srcdoc = documentHtml({ selected, from, to, withTitle, geometry });
  }

  // Sheet size and writing size, in millimetres. The text column is the
  // writing view's measure (74ch or 88ch of the writing font), so lines wrap
  // where they do on screen; the type is scaled to fill the sheet's width.
  function sheetGeometry(paper) {
    const contentWidth = paper.width - paper.marginX * 2;
    const font = contentWidth / (request.measureCh * zeroWidthEm());
    const labelBlock = font * (0.76 * 1.4 + 1.47);
    const bodyHeight = (request.lines + SLACK_LINES) * LINE_HEIGHT * font;
    const height = paper.height || paper.marginTop + labelBlock + bodyHeight + paper.marginBottom;
    return {
      width: paper.width,
      height: round(height),
      marginX: paper.marginX,
      marginTop: paper.marginTop,
      marginBottom: paper.marginBottom,
      font: round(font),
    };
  }

  // The width of "0" in the writing font, in em — what CSS calls 1ch.
  function zeroWidthEm() {
    try {
      const context = document.createElement("canvas").getContext("2d");
      context.font = `100px ${WRITING_FONT}`;
      const width = context.measureText("0").width / 100;
      if (width > 0.3 && width < 0.9) return width;
    } catch { /* fall through */ }
    return 0.556;
  }

  function documentHtml({ selected, from, to, withTitle, geometry }) {
    const total = request.pages.length;
    const rich = window.FilumRichText;
    const sheets = [];
    if (withTitle) sheets.push(titleSheet({ selected, from, to, total }));
    selected.forEach((page, index) => {
      const leaf = from + index;
      sheets.push(`<section class="sheet leaf">
        <p class="leaf-label">Leaf ${leaf} of ${total}</p>
        <div class="leaf-body"><div class="leaf-text">${
          page.text.trim() ? rich.markdownToHtml(page.text) : `<p class="leaf-blank">This leaf was left open.</p>`
        }</div></div>
      </section>`);
    });
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(documentTitle(from, to, total))}</title>
<style>${documentCss(geometry)}</style>
</head><body>${sheets.join("")}</body></html>`;
  }

  function titleSheet({ selected, from, to, total }) {
    const { entry, layout } = request;
    const rangeText = from === 1 && to === total
      ? `${total} ${total === 1 ? "leaf" : "leaves"}`
      : from === to ? `Leaf ${from} of ${total}` : `Leaves ${from}–${to} of ${total}`;
    const details = [
      `Begun ${dateTime(entry.createdAt)}`,
      `last written ${dateTime(entry.updatedAt)}`,
    ];
    if (entry.revision?.lastRevisedAt) details.push(`revised ${dateTime(entry.revision.lastRevisedAt)}`);
    const thread = entry.origin?.threadNameSnapshot;
    // The diary's first line is its title; an entry that opens blank is
    // known by the day it was begun.
    const date = longDate(entry.createdAt);
    const heading = firstLine(entry.content, 120) || date;
    const wordTotal = words(selected.map((page) => page.text).join(" "));
    return `<section class="sheet cover">
      <div class="cover-centre">
        <p class="cover-kicker">Circumspection</p>
        <h1 class="cover-title${heading.length > 36 ? " is-long" : ""}">${escapeHtml(heading)}</h1>
        <p class="cover-range">${escapeHtml(heading === date ? rangeText : `${date} · ${rangeText}`)}</p>
        <span class="cover-thread" aria-hidden="true"></span>
        <p class="cover-detail">${escapeHtml(details.join(" · "))}</p>
        ${thread ? `<p class="cover-detail">From the thread “${escapeHtml(thread)}”</p>` : ""}
        <p class="cover-detail">${wordTotal.toLocaleString()} ${wordTotal === 1 ? "word" : "words"} · ${
          layout === "wider-musky" ? "wider musky diary" : "simple musky diary"}</p>
      </div>
      <p class="cover-colophon">Kept in Filum · exported ${escapeHtml(longDate(new Date().toISOString()))}</p>
    </section>`;
  }

  function documentCss(g) {
    const f = `${g.font}mm`;
    return `
@page { size: ${g.width}mm ${g.height}mm; margin: 0; }
:root {
  --ink: #161616; --muted: #6e675c; --line: rgba(22, 22, 22, 0.12); --line-strong: rgba(22, 22, 22, 0.78);
  --link: #3f5d8a; --code-bg: rgba(22, 22, 22, 0.05);
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { color: var(--ink); font-family: ${WRITING_FONT}; }
.sheet {
  position: relative;
  width: ${g.width}mm; height: ${g.height}mm;
  padding: ${g.marginTop}mm ${g.marginX}mm ${g.marginBottom}mm;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% -8%, rgba(255, 255, 255, 0.88), transparent 38%),
    radial-gradient(circle at 92% 46%, rgba(231, 223, 208, 0.56), transparent 34%),
    linear-gradient(180deg, #f9f6ef 0%, #f5f1e8 100%);
  break-after: page; page-break-after: always;
}
.sheet:last-child { break-after: auto; page-break-after: auto; }

/* A leaf, as the writing view draws it. */
.leaf { display: flex; flex-direction: column; font-size: ${f}; }
.leaf-label {
  /* The writing view's mode label: 0.76 of the writing size, 1.47 writing-ems above the text. */
  flex: none; margin: 0 0 calc(1.47em / 0.76); min-height: 1.4em;
  color: var(--muted); font-family: ${LABEL_FONT}; font-size: 0.76em; letter-spacing: 0.03em;
}
.leaf-body { flex: 1; min-height: 0; }
.leaf-text { line-height: ${LINE_HEIGHT}; overflow-wrap: anywhere; }
.leaf-text p { margin: 0 0 0.85em; }
.leaf-text p:last-child { margin-bottom: 0; }
.leaf-text ul, .leaf-text ol { margin: 0.45em 0 0.9em; padding-left: 1.6em; }
.leaf-text :is(ul, ol) :is(ul, ol) { margin-top: 0.15em; margin-bottom: 0.15em; }
/* Links and code read as they do in the writing view: ink, underlined; plain monospace. */
.leaf-text a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.leaf-text strong, .leaf-text b { font-weight: 700; }
.leaf-text code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.leaf-text pre {
  margin: 0.45em 0 0.9em; padding: 0.6em 0.8em; border-radius: 0.5em; background: var(--code-bg);
  white-space: pre-wrap; line-height: 1.5;
}
.leaf-text pre code { padding: 0; background: none; }
.leaf-text abbr { text-decoration: none; }
.leaf-blank { color: var(--muted); font-family: ${LABEL_FONT}; font-style: italic; }
.thread-reference {
  display: inline-flex; align-items: center; margin: 0 0.15em; padding: 0.05em 0.5em;
  border: 1px solid var(--line-strong); border-radius: 0.65em;
  background: rgba(231, 223, 208, 0.48); font-size: 0.9em; line-height: 1.35;
}
.thread-reference-remove { display: none; }

/* The title leaf: one centred axis, the thread drawn once. */
.cover { display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover-centre { display: grid; justify-items: center; gap: 3mm; }
.cover-kicker {
  margin: 0; color: var(--muted); font-size: 3mm; letter-spacing: 0.32em; text-transform: uppercase;
}
.cover-title {
  max-width: 82%; margin: 2mm 0 0; font-family: ${LABEL_FONT}; font-size: 12mm; font-weight: 400; line-height: 1.15;
  text-wrap: balance;
}
.cover-title.is-long { font-size: 8.5mm; }
.cover-range { margin: 0; color: var(--muted); font-family: ${LABEL_FONT}; font-size: 5mm; font-style: italic; }
.cover-thread {
  display: block; width: 36mm; height: 6mm; margin: 5mm 0 4mm;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 20'%3E%3Cpath d='M2 10 C 32 -2, 52 22, 60 10 S 92 -2, 118 10' fill='none' stroke='%23161616' stroke-width='1.3' stroke-linecap='round'/%3E%3Ccircle cx='60' cy='10' r='2.6' fill='%23161616'/%3E%3C/svg%3E") center / contain no-repeat;
}
.cover-detail { margin: 0; color: var(--muted); font-size: 3.4mm; line-height: 1.6; }
.cover-colophon {
  position: absolute; left: 0; right: 0; bottom: ${g.marginBottom}mm; margin: 0;
  color: var(--muted); font-family: ${LABEL_FONT}; font-size: 3mm; font-style: italic;
}

@media screen {
  html { background: transparent; }
  body {
    display: flex; flex-wrap: wrap; justify-content: center; align-content: flex-start;
    gap: 10mm; padding: 10mm;
  }
  .sheet { flex: none; box-shadow: 0 2mm 8mm rgba(18, 18, 18, 0.12), 0 0 0 0.3mm rgba(22, 22, 22, 0.08); border-radius: 1mm; }
}
@media print {
  .sheet { box-shadow: none; border-radius: 0; }
}`;
  }

  // Read views show abbreviations in full; a PDF is a read view.
  function expandAbbreviations(doc) {
    const expand = request?.expandHtml;
    if (typeof expand !== "function") return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("code, pre, .thread-reference, .leaf-label, .cover")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const html = expand(node.data);
      if (!html.includes("<abbr")) continue;
      const holder = doc.createElement("template");
      holder.innerHTML = html;
      node.replaceWith(holder.content);
    }
  }

  // A leaf is cut to fit its sheet by line count, but a few leaves with many
  // short list items can still run long in real type. Such a leaf is set a
  // touch smaller rather than ever losing words off the sheet's edge.
  function fitLeaves(doc) {
    for (const leaf of doc.querySelectorAll(".leaf")) {
      const body = leaf.querySelector(".leaf-body");
      const text = leaf.querySelector(".leaf-text");
      let scale = 1;
      while (text.scrollHeight > body.clientHeight + 1 && scale > 0.62) {
        scale = Math.round((scale - 0.04) * 100) / 100;
        text.style.fontSize = `${scale}em`;
      }
    }
  }

  // The preview frame keeps the sheets at true size inside and is scaled as
  // a whole, so the page that prints is the page that was measured.
  function scalePreview(frame, geometry) {
    const box = frame.closest(".circ-export-preview");
    const doc = frame.contentDocument;
    const pxPerMm = 1 / MM_PER_PX;
    const sheetWidth = geometry.width * pxPerMm;
    const innerWidth = Math.max(sheetWidth * 2 + 30 * pxPerMm, 760);
    frame.style.width = `${innerWidth}px`;
    const scale = Math.min(1, box.clientWidth / innerWidth);
    frame.style.height = "10px";
    const innerHeight = doc.documentElement.scrollHeight;
    frame.style.height = `${innerHeight}px`;
    frame.style.transform = `scale(${scale})`;
    const sizer = frame.parentElement;
    sizer.style.height = `${Math.ceil(innerHeight * scale)}px`;
  }

  // ---- Saving -------------------------------------------------------------------

  function save() {
    const frame = dialog.querySelector(".circ-export-frame");
    const win = frame.contentWindow;
    if (!win || !request) return;
    // Chrome names the saved file after the document title.
    const { from, to } = range();
    const title = documentTitle(from, to, request.pages.length);
    if (restoreTitle === null) restoreTitle = document.title;
    document.title = title;
    const restore = () => {
      if (restoreTitle !== null) document.title = restoreTitle;
      restoreTitle = null;
    };
    win.addEventListener("afterprint", restore, { once: true });
    setTimeout(restore, 60_000);
    win.focus();
    win.print();
  }

  // Chrome suggests this as the file name, so it reads like one: the
  // diary's first line (or the day it was begun), then the leaves if only
  // some were chosen — "Provelis v-s Metaview - a contrastive analysis —
  // leaves 2–3". Characters Finder or other systems refuse are replaced.
  function documentTitle(from, to, total) {
    const name = fileSafe(firstLine(request.entry.content, 80)) || `Circumspection — ${longDate(request.entry.createdAt)}`;
    const leaves = from === 1 && to === total ? "" : from === to ? ` — leaf ${from}` : ` — leaves ${from}–${to}`;
    return `${name}${leaves}`;
  }

  // The first written line as plain words: marks, links, references, list
  // markers and quote/heading signs removed; cut at a word, with an ellipsis.
  function firstLine(content, max) {
    const line = String(content || "").split("\n").map((text) => text.trim()).find(Boolean) || "";
    const plain = line
      .replace(/@\[([^\]]+)\]\(filum:[a-z]+\/[a-z0-9-]{8,64}\)/gi, "@$1")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
      .replace(/\*\*|__|`/g, "")
      .replace(/(^|[^*])\*(?!\*)([^*]+?)\*/g, "$1$2")
      .replace(/^(?:[-*>#]+|\d+\.)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length <= max) return plain;
    const cut = plain.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, "")}…`;
  }

  function fileSafe(text) {
    return text
      .replace(/\s*[:|]\s*/g, " - ")
      .replace(/[\/\\]/g, "-")
      .replace(/[*?"<>\u0000-\u001f]/g, "")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Small helpers ------------------------------------------------------------

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { return {}; }
  }

  function writePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* a convenience only */ }
  }

  function words(text) { return (String(text).trim().match(/\S+/gu) || []).length; }
  function round(value) { return Math.round(value * 100) / 100; }
  function longDate(value) { return new Date(value).toLocaleDateString([], { dateStyle: "long" }); }
  function dateTime(value) {
    return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
})();
