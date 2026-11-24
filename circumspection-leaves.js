// Circumspection leaves — how a diary entry is cut into leaves.
//
// Pure functions only (no DOM), so the same code paginates in the writing
// view, in the PDF export, and in Node tests against stored diaries.
//
// A leaf holds a fixed number of lines of a fixed number of characters for
// each diary type, independent of window size, zoom, or writing size. The
// same words therefore always land on the same leaf, and the boundary a leaf
// was rendered with is the boundary it is written back into.
//
// Lines are counted the way they look: a short line ("Theory of self") still
// takes a whole line, long lines wrap word by word, paragraphs leave a
// half-line of air. A leaf breaks between words — never inside **bold**, a
// link, or a list item — and text flows back when earlier text shrinks (or a
// leaf grows), because pages are always derived from the whole entry. No
// automatic break is ever stored; only breaks the writer turned by hand are.
(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FilumLeaves = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  // measureCh is the writing column in CSS ch (the width of "0"), so it
  // scales with the writing size. charsPerLine is how many visible
  // characters of ordinary prose fill that column in the writing font:
  // measured in Chrome, Avenir Next sets 1.24–1.32 characters per ch, so
  // 1.22 per ch never promises a line more than the type delivers.
  const CHARS_PER_CH = 1.22;
  const LEAF_GEOMETRY = {
    "simple-musky": { measureCh: 82, charsPerLine: Math.round(82 * CHARS_PER_CH), lines: 20 },
    "wider-musky": { measureCh: 108, charsPerLine: Math.round(108 * CHARS_PER_CH), lines: 20 },
  };
  // The leaves every diary was cut with before 2026-11-24, kept so tests can
  // show stored diaries flowing back under the current geometry.
  const LEGACY_LEAF_GEOMETRY = {
    "simple-musky": { measureCh: 74, charsPerLine: 80, lines: 18 },
    "wider-musky": { measureCh: 88, charsPerLine: 96, lines: 18 },
  };
  const DEFAULT_WRITING_SIZE_PX = 17;
  const LEGACY_WRITING_SIZE_PX = 19;
  const SETTINGS_VERSION = 3;
  const PARAGRAPH_GAP_LINES = 0.5;
  const UNBREAKABLE = /@\[[^\]]+\]\(filum:[a-z]+\/[a-z0-9-]+\)|\[[^\]]+\]\([^)]+\)|\*\*.+?\*\*|__.+?__|\*[^*\n]+?\*|`[^`\n]+`/g;

  function geometryFor(layout) {
    return LEAF_GEOMETRY[layout] || LEAF_GEOMETRY["simple-musky"];
  }

  // Settings written before version 3 carry the old default writing size;
  // a writer who never moved the slider gets the new, smaller default. A
  // size the writer chose is kept.
  function migrateSettings(settings) {
    const version = Number.isInteger(settings.writingMeasureVersion) ? settings.writingMeasureVersion : 1;
    if (version >= SETTINGS_VERSION) return false;
    if (version < 2 && settings.writingMeasureCh === 62) settings.writingMeasureCh = 74;
    if (settings.writingSizePx === LEGACY_WRITING_SIZE_PX) settings.writingSizePx = DEFAULT_WRITING_SIZE_PX;
    settings.writingMeasureVersion = SETTINGS_VERSION;
    return true;
  }

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

  function layoutUnits(content, segStart, segEnd, parseBlocks) {
    const units = [];
    for (const block of parseBlocks(content.slice(segStart, segEnd))) {
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

  // options.parseBlocks: FilumRichText.parseBlocks (the editor's own parser).
  // options.onAutoBreak(offset): told about every break the geometry made.
  function paginate(content, manualBreaks, geometry, options = {}) {
    const parseBlocks = options.parseBlocks || globalThis.FilumRichText?.parseBlocks;
    const pages = [];
    const bounds = [0, ...manualBreaks.filter((offset) => offset > 0 && offset < content.length), content.length];
    if (manualBreaks.includes(content.length) && content.length > 0) bounds.push(content.length);
    for (let i = 0; i < bounds.length - 1; i += 1) {
      paginateSegment(content, bounds[i], bounds[i + 1], geometry, parseBlocks, options.onAutoBreak, pages,
        i === bounds.length - 2);
    }
    return pages.length ? pages : [{ start: 0, end: 0, text: "" }];
  }

  function paginateSegment(content, segStart, segEnd, geometry, parseBlocks, onAutoBreak, pages, final) {
    const units = layoutUnits(content, segStart, segEnd, parseBlocks);
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
      if (automatic) onAutoBreak?.(page.end);
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

  return {
    LEAF_GEOMETRY,
    LEGACY_LEAF_GEOMETRY,
    DEFAULT_WRITING_SIZE_PX,
    SETTINGS_VERSION,
    geometryFor,
    migrateSettings,
    visibleLength,
    wrapText,
    paginate,
    pageIndexForOffset,
  };
});
