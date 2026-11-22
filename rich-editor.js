(() => {
  "use strict";

  // ---- The markdown subset ------------------------------------------------
  //
  // Notes and Circumspection are stored as a small markdown subset and edited
  // as rich text. The two directions below are written as exact inverses on
  // the canonical form, so a leaf can be rendered, edited, and serialised any
  // number of times without its spacing or structure drifting:
  //
  //   blocks      separated by exactly "\n\n"; extra blank lines are empty
  //               paragraphs, never collapsed
  //   paragraph   lines joined by "\n" (a soft line break)
  //   list        "- item" / "1. item", nested by three spaces per level,
  //               at most two levels below the main point; a soft break
  //               inside an item continues on an indented line
  //   code        ``` fenced ```
  //   inline      **bold**, *italic*, __underline__, `code`, [label](url),
  //               @[label](filum:thread/id), @[label](filum:image/id)

  const URL_PATTERN = /^(?:https?:\/\/|mailto:)/i;
  const LIST_LINE = /^( *)([-*]|\d{1,9}\.)[ \t]+(.*)$/;
  const CONTINUATION_LINE = /^ {2,}\S/;
  const MAX_LIST_LEVEL = 2; // main point → sub-point → sub-sub-point
  const LIST_INDENT = "   ";
  const REFERENCE_PATTERN = /@\[([^\]]+)\]\(filum:(thread|image)\/([a-z0-9-]{8,64})\)/gi;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function safeHref(value) {
    const href = String(value || "").trim();
    if (!URL_PATTERN.test(href)) return null;
    return href;
  }

  function referenceHtml(kind, label, id) {
    const safeLabel = escapeHtml(label);
    const attr = kind === "image" ? "data-image-ref" : "data-thread-ref";
    const extra = kind === "image" ? " thread-reference--image" : "";
    return `<span class="thread-reference thread-reference--editable${extra}"
      ${attr}="${escapeHtml(id)}" data-thread-label="${safeLabel}" contenteditable="false"><button
      class="thread-reference-remove" type="button" data-thread-ref-remove
      aria-label="Remove @${safeLabel} reference">×</button><span
      class="thread-reference-label">@${safeLabel}</span></span>`;
  }

  // Kept for callers that only know about thread chips.
  function threadReferenceHtml(label, id) {
    return referenceHtml("thread", label, id);
  }

  function inlineMarkdown(raw) {
    const tokens = [];
    const stash = (html) => {
      tokens.push(html);
      return `\u0000${tokens.length - 1}\u0000`;
    };
    let text = String(raw || "");
    text = text.replace(REFERENCE_PATTERN, (_m, label, kind, id) => stash(referenceHtml(kind, label, id)));
    text = text.replace(/`([^`\n]+)`/g, (_m, body) => stash(`<code>${escapeHtml(body)}</code>`));
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi, (_m, label, href) =>
      stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
    );
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__(.+?)__/g, "<u>$1</u>");
    html = html.replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>");
    // Spaces that HTML would collapse (leading, trailing, doubled) are drawn
    // as non-breaking spaces, exactly as the browser does while typing —
    // otherwise the next keystroke swallows them and words run together.
    // The serialiser reads them back as ordinary spaces. (Only <strong>,
    // <em> and <u> are in the string at this point; none contain spaces.)
    html = html.replace(/^ /, "&nbsp;").replace(/ (?= |$)/g, "&nbsp;");
    return html.replace(/\u0000(\d+)\u0000/g, (_m, index) => tokens[Number(index)]);
  }

  // ---- Parsing -------------------------------------------------------------

  // Split on "\n\n" outside code fences. Exactly the inverse of joining the
  // serialised blocks with "\n\n", so blank-line counts survive untouched.
  function splitChunks(markdown) {
    const md = String(markdown || "").replace(/\r\n/g, "\n");
    const chunks = [];
    let start = 0;
    let inFence = false;
    let lineStart = true;
    for (let i = 0; i <= md.length; i += 1) {
      if (lineStart) {
        const lineEnd = md.indexOf("\n", i);
        if (md.slice(i, lineEnd < 0 ? md.length : lineEnd).trim().startsWith("```")) inFence = !inFence;
        lineStart = false;
      }
      if (i === md.length) break;
      if (!inFence && md[i] === "\n" && md[i + 1] === "\n") {
        chunks.push({ start, end: i, text: md.slice(start, i) });
        start = i + 2;
        i += 1;
        lineStart = true;
        continue;
      }
      if (md[i] === "\n") lineStart = true;
    }
    chunks.push({ start, end: md.length, text: md.slice(start) });
    return chunks;
  }

  function listLevel(spaces) {
    return Math.min(MAX_LIST_LEVEL, Math.round(spaces.length / LIST_INDENT.length));
  }

  // One chunk → one block, with per-line offsets relative to the chunk.
  function parseChunk(text) {
    const lines = [];
    let offset = 0;
    for (const line of text.split("\n")) {
      lines.push({ text: line, start: offset, end: offset + line.length });
      offset += line.length + 1;
    }
    if (text.startsWith("```")) {
      const body = lines.slice(1);
      if (body.length && body[body.length - 1].text.trim().startsWith("```")) body.pop();
      return { type: "pre", code: body.map((line) => line.text).join("\n"), lines };
    }
    const isList =
      LIST_LINE.test(lines[0].text) &&
      lines.every((line) => LIST_LINE.test(line.text) || CONTINUATION_LINE.test(line.text));
    if (isList) {
      const items = [];
      for (const line of lines) {
        const match = line.text.match(LIST_LINE);
        if (match) {
          items.push({
            level: listLevel(match[1]),
            ordered: match[2] !== "-" && match[2] !== "*",
            number: Number.parseInt(match[2], 10) || 1,
            lines: [match[3]],
            start: line.start,
            end: line.end,
            contentStart: line.start + line.text.length - match[3].length,
          });
        } else {
          const last = items[items.length - 1];
          last.lines.push(line.text.trim());
          last.end = line.end;
        }
      }
      return { type: "list", items, lines };
    }
    return { type: "p", lines };
  }

  // Blocks with absolute offsets — shared with Circumspection's pagination so
  // a page break and a rendered block always agree about where things are.
  function parseBlocks(markdown) {
    return splitChunks(markdown).map((chunk) => {
      const block = parseChunk(chunk.text);
      block.start = chunk.start;
      block.end = chunk.end;
      for (const line of block.lines) {
        line.start += chunk.start;
        line.end += chunk.start;
      }
      if (block.items) {
        for (const item of block.items) {
          item.start += chunk.start;
          item.end += chunk.start;
          item.contentStart += chunk.start;
        }
      }
      return block;
    });
  }

  function paragraphHtml(lines, inline, className) {
    const body = lines.map(inline).join("<br>");
    const trailing = lines[lines.length - 1] === "" ? "<br>" : "";
    return `<p${className ? ` class="${className}"` : ""}>${body}${trailing}</p>`;
  }

  function listHtml(items, inline, className) {
    // Build a tree; an item may only sit one level deeper than the item before.
    const root = { lists: [] };
    const lastAtLevel = [];
    let previousLevel = -1;
    for (const item of items) {
      const level = Math.min(item.level, previousLevel + 1, MAX_LIST_LEVEL);
      previousLevel = level;
      const holder = level === 0 ? root : lastAtLevel[level - 1] || root;
      const tag = item.ordered ? "ol" : "ul";
      let list = holder.lists[holder.lists.length - 1];
      if (!list || list.tag !== tag) {
        list = { tag, start: item.number, items: [] };
        holder.lists.push(list);
      }
      const node = { item, lists: [] };
      list.items.push(node);
      lastAtLevel[level] = node;
      lastAtLevel.length = level + 1;
    }
    const render = (list) => {
      const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      const cls = className ? ` class="${className}"` : "";
      const lis = list.items
        .map((node) => {
          const lines = node.item.lines;
          const body = lines.map(inline).join("<br>");
          const trailing = lines[lines.length - 1] === "" ? "<br>" : "";
          return `<li>${body}${trailing}${node.lists.map(render).join("")}</li>`;
        })
        .join("");
      return `<${list.tag}${start}${cls}>${lis}</${list.tag}>`;
    };
    return root.lists.map(render).join("");
  }

  // options.inline lets a read-only view (task notes) bring its own inline
  // renderer; the block structure stays identical to the editor's.
  function markdownToHtml(markdown, options = {}) {
    const inline = options.inline || inlineMarkdown;
    const html = parseBlocks(markdown)
      .map((block) => {
        if (block.type === "pre") {
          const cls = options.preClass ? ` class="${options.preClass}"` : "";
          return `<pre${cls}><code>${escapeHtml(block.code)}</code></pre>`;
        }
        if (block.type === "list") return listHtml(block.items, inline, options.listClass);
        return paragraphHtml(block.lines.map((line) => line.text), inline, options.paragraphClass);
      })
      .join("");
    return html || "<p><br></p>";
  }

  // ---- Serialising, with a position map --------------------------------------
  //
  // One walk produces the markdown and records where every text node (and
  // every empty block) begins in it. Caret offsets read from and written to
  // the editor go through this map, so they are exact in markdown characters
  // whatever formatting sits around them.

  const BLOCK_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE|SECTION|ARTICLE)$/;

  function isReference(node) {
    return node instanceof HTMLElement && (node.hasAttribute("data-thread-ref") || node.hasAttribute("data-image-ref"));
  }

  function isBlockNode(node) {
    return node instanceof HTMLElement && (BLOCK_TAGS.test(node.tagName) || /^(UL|OL|PRE)$/.test(node.tagName));
  }

  // Content leaves in order: non-empty text, <br>, reference chips. A block's
  // final <br> is the browser's placeholder and never a line of its own.
  function collectLeaves(nodes, out = []) {
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue) out.push(node);
      } else if (node instanceof HTMLElement) {
        if (node.tagName === "BR" || isReference(node)) out.push(node);
        else if (node.tagName !== "UL" && node.tagName !== "OL") collectLeaves(node.childNodes, out);
      }
    }
    return out;
  }

  class Writer {
    constructor() {
      this.out = "";
      this.texts = []; // { node, start }
      this.slots = []; // { node, offset, start } for empty blocks
      this.starts = new Map(); // node -> start
      this.ends = new Map(); // element -> content end
      this.trailingBreaks = new Set();
    }

    emit(text) {
      this.out += text;
    }

    markTrailing(nodes) {
      const leaves = collectLeaves(nodes);
      const last = leaves[leaves.length - 1];
      if (last && last.nodeType !== Node.TEXT_NODE && last.tagName === "BR") this.trailingBreaks.add(last);
      return leaves.some((leaf) => leaf.nodeType === Node.TEXT_NODE || isReference(leaf) || !this.trailingBreaks.has(leaf));
    }

    inline(node, continuation) {
      if (node.nodeType === Node.TEXT_NODE) {
        this.starts.set(node, this.out.length);
        this.texts.push({ node, start: this.out.length });
        this.emit((node.nodeValue || "").replace(/ /g, " "));
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      this.starts.set(node, this.out.length);
      if (isReference(node)) {
        const kind = node.hasAttribute("data-image-ref") ? "image" : "thread";
        const id = node.getAttribute(kind === "image" ? "data-image-ref" : "data-thread-ref") || "";
        const label =
          node.dataset.threadLabel ||
          node.querySelector(".thread-reference-label")?.textContent.replace(/^@/, "") ||
          (kind === "image" ? "Image" : "Thread");
        this.emit(`@[${label}](filum:${kind}/${id})`);
        this.ends.set(node, this.out.length);
        return;
      }
      if (node.tagName === "BR") {
        if (!this.trailingBreaks.has(node)) this.emit(`\n${continuation || ""}`);
        this.ends.set(node, this.out.length);
        return;
      }
      if (node.tagName === "UL" || node.tagName === "OL") return; // handled by the list writer
      let open = "";
      let close = "";
      const tag = node.tagName;
      if (tag === "STRONG" || tag === "B") open = close = "**";
      else if (tag === "EM" || tag === "I") open = close = "*";
      else if (tag === "U") open = close = "__";
      else if (tag === "CODE" && node.parentElement?.tagName !== "PRE") open = close = "`";
      else if (tag === "SPAN") {
        const weight = node.style.fontWeight;
        if (weight === "bold" || Number.parseInt(weight, 10) >= 600) { open += "**"; close = "**" + close; }
        if (node.style.fontStyle === "italic") { open += "*"; close = "*" + close; }
        if ((node.style.textDecorationLine || "").includes("underline")) { open += "__"; close = "__" + close; }
      } else if (tag === "A") {
        const href = safeHref(node.getAttribute("href"));
        if (href && node.textContent) {
          open = "[";
          close = `](${href})`;
        }
      }
      // Empty marks (a bold run whose text was deleted) leave no stray "****".
      if (open && !node.textContent.replace(/​/g, "")) open = close = "";
      this.emit(open);
      for (const child of node.childNodes) this.inline(child, continuation);
      this.emit(close);
      this.ends.set(node, this.out.length);
    }

    // container is the <p>/<div>, or null for a run of bare inline nodes.
    paragraph(container, nodes) {
      if (container) this.starts.set(container, this.out.length);
      const hasContent = this.markTrailing(nodes);
      if (!hasContent) {
        const node = container || nodes[0]?.parentNode;
        if (node) this.slots.push({ node, offset: 0, start: this.out.length });
      }
      for (const node of nodes) this.inline(node, "");
      if (container) this.ends.set(container, this.out.length);
    }

    list(listEl, level, first) {
      const ordered = listEl.tagName === "OL";
      let number = ordered ? Number.parseInt(listEl.getAttribute("start"), 10) || 1 : 0;
      let wrote = !first;
      this.starts.set(listEl, this.out.length);
      for (const child of listEl.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim()) continue;
        if (child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")) {
          this.list(child, Math.min(level + 1, MAX_LIST_LEVEL), !wrote);
          wrote = true;
          continue;
        }
        if (wrote) this.emit("\n");
        wrote = true;
        this.emit(`${LIST_INDENT.repeat(level)}${ordered ? `${number}.` : "-"} `);
        number += 1;
        const continuation = LIST_INDENT.repeat(level + 1);
        const isItem = child instanceof HTMLElement && child.tagName === "LI";
        const parts = isItem ? Array.from(child.childNodes) : [child];
        this.starts.set(child, this.out.length);
        const inlineParts = parts.filter((part) => !(part instanceof HTMLElement && (part.tagName === "UL" || part.tagName === "OL")));
        const hasContent = this.markTrailing(inlineParts);
        if (!hasContent) this.slots.push({ node: child, offset: 0, start: this.out.length });
        let firstPart = true;
        for (const part of inlineParts) {
          // A paragraph inside an item continues the item on its own line.
          if (part instanceof HTMLElement && BLOCK_TAGS.test(part.tagName)) {
            if (!firstPart) this.emit(`\n${continuation}`);
            this.markTrailing(part.childNodes);
            for (const sub of part.childNodes) this.inline(sub, continuation);
          } else {
            this.inline(part, continuation);
          }
          firstPart = false;
        }
        this.ends.set(child, this.out.length);
        for (const part of parts) {
          if (part instanceof HTMLElement && (part.tagName === "UL" || part.tagName === "OL")) {
            this.list(part, Math.min(level + 1, MAX_LIST_LEVEL), false);
          }
        }
      }
      this.ends.set(listEl, this.out.length);
    }

    pre(preEl) {
      this.starts.set(preEl, this.out.length);
      this.emit("```\n");
      const walker = document.createTreeWalker(preEl, NodeFilter.SHOW_TEXT);
      let node;
      let any = false;
      while ((node = walker.nextNode())) {
        any = true;
        this.starts.set(node, this.out.length);
        this.texts.push({ node, start: this.out.length });
        this.emit(node.nodeValue || "");
      }
      if (!any) this.slots.push({ node: preEl, offset: 0, start: this.out.length });
      this.emit("\n```");
      this.ends.set(preEl, this.out.length);
    }

    // Group the container's children into blocks: runs of inline nodes become
    // one paragraph, block elements are flattened when they nest blocks.
    blocksOf(container, into = []) {
      let run = [];
      const flush = () => {
        if (run.length && run.some((n) => n.nodeType !== Node.TEXT_NODE || n.nodeValue.trim() || n.nodeValue.includes(" "))) {
          into.push({ kind: "run", nodes: run });
        }
        run = [];
      };
      for (const node of container.childNodes) {
        if (!(node instanceof HTMLElement) || !isBlockNode(node)) {
          if (node.nodeType === Node.TEXT_NODE || node instanceof HTMLElement) run.push(node);
          continue;
        }
        flush();
        if (node.tagName === "UL" || node.tagName === "OL") into.push({ kind: "list", node });
        else if (node.tagName === "PRE") into.push({ kind: "pre", node });
        else if (Array.from(node.children).some(isBlockNode)) this.blocksOf(node, into);
        else into.push({ kind: "p", node });
      }
      flush();
      return into;
    }

    document(root) {
      const blocks = this.blocksOf(root);
      blocks.forEach((block, index) => {
        if (index) this.emit("\n\n");
        if (block.kind === "list") this.list(block.node, 0, true);
        else if (block.kind === "pre") this.pre(block.node);
        else if (block.kind === "p") this.paragraph(block.node, Array.from(block.node.childNodes));
        else this.paragraph(null, block.nodes);
      });
      if (!blocks.length) this.slots.push({ node: root, offset: 0, start: 0 });
      return this;
    }
  }

  function serializeWithMap(root) {
    return new Writer().document(root);
  }

  function serializeRoot(root) {
    return serializeWithMap(root).out;
  }

  // DOM position → markdown offset.
  function offsetForPosition(map, root, container, offset) {
    if (container.nodeType === Node.TEXT_NODE && map.starts.has(container)) {
      return map.starts.get(container) + Math.min(offset, (container.nodeValue || "").length);
    }
    if (container instanceof Element) {
      if (offset >= container.childNodes.length) {
        if (map.ends.has(container)) return map.ends.get(container);
        if (container === root) return map.out.length;
      } else {
        const child = container.childNodes[offset];
        if (map.starts.has(child)) return map.starts.get(child);
      }
    }
    // Fall back to the first mapped node at or after this position.
    const probe = document.createRange();
    probe.setStart(container, offset);
    let best = map.out.length;
    for (const { node, start } of map.texts) {
      const range = document.createRange();
      range.selectNode(node);
      if (probe.compareBoundaryPoints(Range.START_TO_START, range) <= 0) {
        best = start;
        break;
      }
    }
    return best;
  }

  // Markdown offset → DOM position.
  function positionForOffset(map, root, target) {
    const slots = [
      ...map.texts.map(({ node, start }) => ({ node, start, end: start + (node.nodeValue || "").length, text: true })),
      ...map.slots.filter((slot) => slot.node).map((slot) => ({ ...slot, end: slot.start, text: false })),
    ].sort((a, b) => a.start - b.start);
    if (!slots.length) return { node: root, offset: 0 };
    const hit = slots.find((slot) => slot.start <= target && target <= slot.end);
    const chosen = hit || slots.find((slot) => slot.start > target) || slots[slots.length - 1];
    if (!chosen.text) return { node: chosen.node, offset: 0 };
    const local = hit ? target - chosen.start : chosen === slots[slots.length - 1] && chosen.start <= target ? chosen.end - chosen.start : 0;
    return { node: chosen.node, offset: Math.max(0, Math.min(local, (chosen.node.nodeValue || "").length)) };
  }

  function selectionInside(root) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer);
  }

  function closestIn(node, root, selector) {
    let current = node instanceof Element ? node : node?.parentElement;
    while (current && current !== root) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // ---- The editor ----------------------------------------------------------------

  class RichEditor {
    constructor(source, options = {}) {
      this.source = source;
      this.options = options;
      this.savedLinkRange = null;
      this.savedCommandRange = null;
      this.mentionIndex = 0;
      this.mentionItems = [];
      this.isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

      if (source instanceof HTMLTextAreaElement) {
        this.root = document.createElement("div");
        this.root.className = "rich-surface";
        this.root.contentEditable = "true";
        this.root.setAttribute("role", "textbox");
        this.root.setAttribute("aria-multiline", "true");
        this.root.setAttribute("aria-label", source.getAttribute("aria-label") || "Rich text");
        this.wrapper = document.createElement("div");
        this.wrapper.className = "rich-editor";
        source.parentNode.insertBefore(this.wrapper, source);
        this.wrapper.appendChild(source);
        this.wrapper.appendChild(this.root);
        source.classList.add("rich-source");
        // The source may live inside an implicit <label>. Keep it available as
        // the canonical form value, but remove it from interaction so a click
        // on the visible editor cannot be redirected to this hidden textarea.
        source.inert = true;
        source.tabIndex = -1;
        source.setAttribute("aria-hidden", "true");
      } else {
        this.root = source;
        this.root.contentEditable = source.getAttribute("aria-readonly") === "true" ? "false" : "true";
        this.root.classList.add("rich-surface");
        this.wrapper = source.parentElement;
      }

      this.toolbar = this.buildToolbar();
      if (options.toolbarPosition === "top") {
        this.root.parentNode.insertBefore(this.toolbar, this.root);
      } else {
        this.root.parentNode.insertBefore(this.toolbar, this.root.nextSibling);
      }
      this.mentionMenu = document.createElement("div");
      this.mentionMenu.className = "rich-mention-menu";
      this.mentionMenu.hidden = true;
      this.root.parentNode.insertBefore(this.mentionMenu, this.toolbar.nextSibling);

      this.setMarkdown(this.sourceValue());
      this.bind();
      this.installCompatibilityProperties();
    }

    sourceValue() {
      return this.source instanceof HTMLTextAreaElement
        ? this.source.value
        : this.source.dataset.initialMarkdown || this.source.textContent || "";
    }

    buildToolbar() {
      const toolbar = document.createElement("div");
      toolbar.className = "rich-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "Text formatting");
      toolbar.innerHTML = `
        <button type="button" data-rich-command="bold" aria-label="Bold" aria-pressed="false"><strong>B</strong></button>
        <button type="button" data-rich-command="italic" aria-label="Italic" aria-pressed="false"><em>I</em></button>
        <button type="button" data-rich-command="underline" aria-label="Underline" aria-pressed="false"><u>U</u></button>
        <span class="rich-toolbar-divider" aria-hidden="true"></span>
        <button type="button" data-rich-command="insertUnorderedList" aria-label="Bulleted list" aria-pressed="false">•</button>
        <button type="button" data-rich-command="insertOrderedList" aria-label="Numbered list" aria-pressed="false">1.</button>
        <button type="button" data-rich-link aria-label="Add hyperlink">
          <svg class="rich-link-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9.5 7H7a5 5 0 0 0 0 10h2.5m5-10H17a5 5 0 0 1 0 10h-2.5M8 12h8"></path>
          </svg>
        </button>
        <div class="rich-link-panel" hidden>
          <input type="url" inputmode="url" placeholder="https://…" aria-label="Link address">
          <button type="button" data-rich-link-apply>Apply</button>
          <button type="button" data-rich-link-cancel>Cancel</button>
        </div>`;
      return toolbar;
    }

    bind() {
      this.root.addEventListener("input", () => {
        this.syncSource();
        this.updateToolbar();
        this.updateMentionMenu();
      });
      this.root.addEventListener("keydown", (event) => this.handleKeydown(event));
      // List autoformat listens to beforeinput, not keydown: IME and mobile
      // keyboards insert the space without a usable key event.
      this.root.addEventListener("beforeinput", (event) => {
        if (event.inputType === "insertText" && (event.data === " " || event.data === "\u00a0") && this.autoformatList()) {
          event.preventDefault();
        }
      });
      this.root.addEventListener("paste", (event) => {
        if (this.options.onPaste?.(event) === true) return;
        const text = event.clipboardData?.getData("text/plain");
        if (typeof text !== "string") return;
        event.preventDefault();
        document.execCommand("insertText", false, text);
      });
      this.root.addEventListener("click", (event) => {
        const remove = event.target.closest("[data-thread-ref-remove]");
        if (remove) {
          event.preventDefault();
          event.stopPropagation();
          this.removeThreadReference(remove.closest("[data-thread-ref], [data-image-ref]"));
          return;
        }
        const image = event.target.closest("[data-image-ref]");
        if (image) {
          this.options.onImageReference?.(image.dataset.imageRef);
          return;
        }
        const reference = event.target.closest("[data-thread-ref]");
        if (reference) this.options.onThreadReference?.(reference.dataset.threadRef);
      });
      this.root.addEventListener("mousedown", (event) => {
        if (event.target.closest("[data-thread-ref-remove]")) event.preventDefault();
      });
      this.toolbar.addEventListener("mousedown", (event) => {
        if (event.target.closest("button") && !event.target.closest(".rich-link-panel")) {
          const selection = window.getSelection();
          if (selection?.rangeCount && selectionInside(this.root)) {
            this.savedCommandRange = selection.getRangeAt(0).cloneRange();
          }
          event.preventDefault();
        }
      });
      this.toolbar.addEventListener("click", (event) => this.handleToolbarClick(event));
      this.mentionMenu.addEventListener("mousedown", (event) => event.preventDefault());
      this.mentionMenu.addEventListener("click", (event) => {
        const row = event.target.closest("[data-mention-id]");
        if (row) this.insertMention(row.dataset.mentionId, row.dataset.mentionName, row.dataset.mentionKind);
      });
      document.addEventListener("selectionchange", () => {
        if (selectionInside(this.root)) this.updateToolbar();
      });
    }

    handleKeydown(event) {
      const primary = this.isMac ? event.metaKey : event.ctrlKey;
      if (primary && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "a") {
          event.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(this.root);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        const command = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
        if (command) {
          event.preventDefault();
          this.command(command);
          return;
        }
        if (key === "k") {
          event.preventDefault();
          this.openLinkPanel();
          return;
        }
        if (event.shiftKey && event.key === "7") {
          event.preventDefault();
          this.command("insertOrderedList");
          return;
        }
        if (event.shiftKey && event.key === "8") {
          event.preventDefault();
          this.command("insertUnorderedList");
          return;
        }
      }
      if (!this.mentionMenu.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          this.mentionIndex =
            (this.mentionIndex + direction + this.mentionItems.length) % this.mentionItems.length;
          this.renderMentionMenu();
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && this.mentionItems[this.mentionIndex]) {
          event.preventDefault();
          const item = this.mentionItems[this.mentionIndex];
          this.insertMention(item.id, item.name, item.kind);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.closeMentionMenu();
          return;
        }
      }
      if ((event.key === "Backspace" || event.key === "Delete") && this.deleteSelectedReferences()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Tab" && !primary && !event.altKey && this.indentListItem(event.shiftKey)) {
        event.preventDefault();
        return;
      }
    }

    // "1. " or "- " at the start of a paragraph begins a list, the way it
    // reads on paper. "3. " starts the numbering at three.
    autoformatList() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed || !selectionInside(this.root)) return false;
      if (closestIn(selection.anchorNode, this.root, "li, pre")) return false;
      const block = closestIn(selection.anchorNode, this.root, "p, div, h1, h2, h3, h4, h5, h6") || this.root;
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(selection.anchorNode, selection.anchorOffset);
      if (block === this.root) {
        // Bare text at the root: only the current line counts.
        const text = before.toString();
        if (text.includes("\n")) return false;
      }
      const marker = before.toString().replace(/ /g, " ");
      const ordered = marker.match(/^\s*(\d{1,3})\.$/);
      const bullet = /^\s*[-*]$/.test(marker);
      if (!ordered && !bullet) return false;
      if (Array.from(before.cloneContents().childNodes).some((n) => n.nodeName === "BR")) return false;
      before.deleteContents();
      if (!block.textContent && block !== this.root && !block.querySelector("br")) block.appendChild(document.createElement("br"));
      const caret = document.createRange();
      caret.setStart(block, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
      document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList", false, null);
      const number = ordered ? Number.parseInt(ordered[1], 10) : 1;
      const list = closestIn(window.getSelection().anchorNode, this.root, ordered ? "ol" : "ul");
      if (list && number !== 1) list.setAttribute("start", String(number));
      this.root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    }

    // Tab / Shift+Tab inside a list nests or lifts the item, at most two
    // levels below the main point.
    indentListItem(outdent) {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selectionInside(this.root)) return false;
      const item = closestIn(selection.anchorNode, this.root, "li");
      if (!item) return false;
      let depth = 0;
      for (let node = item.parentElement; node && node !== this.root; node = node.parentElement) {
        if (node.tagName === "UL" || node.tagName === "OL") depth += 1;
      }
      if (!outdent && depth > MAX_LIST_LEVEL) return true; // swallow: already as deep as it goes
      if (!outdent && !item.previousElementSibling) return true; // nothing to nest under
      document.execCommand(outdent ? "outdent" : "indent", false, null);
      this.root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      return true;
    }

    handleToolbarClick(event) {
      const commandButton = event.target.closest("[data-rich-command]");
      if (commandButton) {
        this.command(commandButton.dataset.richCommand);
        return;
      }
      if (event.target.closest("[data-rich-link]")) {
        this.openLinkPanel();
        return;
      }
      if (event.target.closest("[data-rich-link-apply]")) this.applyLink();
      if (event.target.closest("[data-rich-link-cancel]")) this.closeLinkPanel();
    }

    command(command) {
      const selection = window.getSelection();
      const activeRange =
        this.savedCommandRange ||
        (selection?.rangeCount && selectionInside(this.root)
          ? selection.getRangeAt(0).cloneRange()
          : null);
      this.root.focus({ preventScroll: true });
      if (
        activeRange &&
        selection &&
        this.root.contains(activeRange.startContainer) &&
        this.root.contains(activeRange.endContainer)
      ) {
        selection.removeAllRanges();
        selection.addRange(activeRange);
      }
      this.savedCommandRange = null;
      const before = this.getMarkdown();
      document.execCommand("styleWithCSS", false, false);
      document.execCommand(command, false, null);
      const after = this.getMarkdown();
      if (after !== before) {
        this.root.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: `format${command}` })
        );
      } else {
        this.syncSource();
      }
      this.updateToolbar();
    }

    updateToolbar() {
      const states = {
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        insertUnorderedList: document.queryCommandState("insertUnorderedList"),
        insertOrderedList: document.queryCommandState("insertOrderedList"),
      };
      for (const [command, active] of Object.entries(states)) {
        const button = this.toolbar.querySelector(`[data-rich-command="${command}"]`);
        button?.setAttribute("aria-pressed", active ? "true" : "false");
      }
    }

    openLinkPanel() {
      this.savedCommandRange = null;
      const selection = window.getSelection();
      if (selection?.rangeCount && selectionInside(this.root)) {
        this.savedLinkRange = selection.getRangeAt(0).cloneRange();
      }
      const panel = this.toolbar.querySelector(".rich-link-panel");
      panel.hidden = false;
      const input = panel.querySelector("input");
      input.value = "";
      input.focus();
    }

    closeLinkPanel() {
      this.toolbar.querySelector(".rich-link-panel").hidden = true;
      this.root.focus({ preventScroll: true });
    }

    applyLink() {
      const panel = this.toolbar.querySelector(".rich-link-panel");
      const input = panel.querySelector("input");
      let href = input.value.trim();
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) href = `https://${href}`;
      href = safeHref(href);
      if (!href) {
        input.focus();
        return;
      }
      const selection = window.getSelection();
      if (this.savedLinkRange) {
        selection.removeAllRanges();
        selection.addRange(this.savedLinkRange);
      }
      this.root.focus({ preventScroll: true });
      if (selection?.isCollapsed) document.execCommand("insertText", false, href);
      document.execCommand("createLink", false, href);
      const anchor = selection?.anchorNode?.parentElement?.closest("a");
      if (anchor) {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      }
      this.savedLinkRange = null;
      panel.hidden = true;
      this.root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    }

    updateMentionMenu() {
      if (typeof this.options.mentionProvider !== "function") return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selectionInside(this.root) || !selection.isCollapsed) {
        this.closeMentionMenu();
        return;
      }
      const node = selection.anchorNode;
      if (node?.nodeType !== Node.TEXT_NODE) {
        this.closeMentionMenu();
        return;
      }
      const before = (node.nodeValue || "").slice(0, selection.anchorOffset);
      const match = before.match(/(?:^|\s)@([^\s@]{0,40})$/);
      if (!match) {
        this.closeMentionMenu();
        return;
      }
      this.mentionQuery = match[1].toLowerCase();
      this.mentionRange = {
        node,
        start: selection.anchorOffset - match[1].length - 1,
        end: selection.anchorOffset,
      };
      this.mentionItems = this.options
        .mentionProvider(this.mentionQuery)
        .filter((item) => item?.id && item?.name)
        .slice(0, 8);
      this.mentionIndex = 0;
      if (!this.mentionItems.length) {
        this.closeMentionMenu();
        return;
      }
      this.renderMentionMenu();
    }

    renderMentionMenu() {
      this.mentionMenu.hidden = false;
      let lastGroup = null;
      this.mentionMenu.innerHTML = this.mentionItems
        .map((item, index) => {
          const group = item.group && item.group !== lastGroup
            ? `<span class="rich-mention-group">${escapeHtml(item.group)}</span>`
            : "";
          lastGroup = item.group || lastGroup;
          const thumb = item.thumb
            ? `<img class="rich-mention-thumb" src="${escapeHtml(item.thumb)}" alt="" />`
            : "";
          return `${group}<button type="button" data-mention-id="${escapeHtml(item.id)}"
            data-mention-name="${escapeHtml(item.name)}" data-mention-kind="${escapeHtml(item.kind || "thread")}"
            class="${index === this.mentionIndex ? "is-active" : ""}">${thumb}<span>${escapeHtml(item.name)}</span></button>`;
        })
        .join("");
    }

    closeMentionMenu() {
      this.mentionMenu.hidden = true;
      this.mentionMenu.innerHTML = "";
      this.mentionItems = [];
      this.mentionRange = null;
    }

    insertMention(id, name, kind = "thread") {
      if (!this.mentionRange?.node?.isConnected) return;
      const range = document.createRange();
      range.setStart(this.mentionRange.node, this.mentionRange.start);
      range.setEnd(this.mentionRange.node, this.mentionRange.end);
      range.deleteContents();
      const holder = document.createElement("div");
      holder.innerHTML = referenceHtml(kind === "image" ? "image" : "thread", name, id);
      const chip = holder.firstElementChild;
      const space = document.createTextNode(" ");
      range.insertNode(space);
      range.insertNode(chip);
      range.setStartAfter(space);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.closeMentionMenu();
      this.root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    }

    removeThreadReference(reference) {
      if (!reference || !this.root.contains(reference)) return;
      const parent = reference.parentNode;
      const next = reference.nextSibling;
      reference.remove();
      this.root.focus({ preventScroll: true });
      if (parent?.isConnected) {
        const range = document.createRange();
        if (next?.isConnected) range.setStartBefore(next);
        else range.setStart(parent, parent.childNodes.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.root.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
      );
    }

    // Browsers delete non-editable chips unevenly; when a selection holds one,
    // delete it ourselves and leave the caret where the selection began.
    // Everything else uses native deletion, which merges blocks correctly.
    deleteSelectedReferences() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || !selectionInside(this.root)) return false;
      const range = selection.getRangeAt(0);
      const holder = document.createElement("div");
      holder.appendChild(range.cloneContents());
      if (!holder.querySelector("[data-thread-ref], [data-image-ref]")) return false;
      range.deleteContents();
      if (!this.root.childNodes.length) this.root.innerHTML = "<p><br></p>";
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      this.root.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
      );
      return true;
    }

    getMarkdown() {
      return serializeRoot(this.root);
    }

    setMarkdown(markdown) {
      const value = String(markdown || "");
      if (this.getMarkdown() === value) return false;
      this.root.innerHTML = markdownToHtml(value);
      if (this.source instanceof HTMLTextAreaElement) this.source.value = value;
      return true;
    }

    syncSource() {
      const value = this.getMarkdown();
      if (this.source instanceof HTMLTextAreaElement) {
        this.source.value = value;
        this.source.dispatchEvent(new Event("input", { bubbles: true }));
      }
      this.options.onChange?.(value);
      return value;
    }

    hasFocus() {
      return document.activeElement === this.root || this.root.contains(document.activeElement);
    }

    getMarkdownOffset(which = "start") {
      const map = serializeWithMap(this.root);
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selectionInside(this.root)) return map.out.length;
      const range = selection.getRangeAt(0);
      return which === "end"
        ? offsetForPosition(map, this.root, range.endContainer, range.endOffset)
        : offsetForPosition(map, this.root, range.startContainer, range.startOffset);
    }

    focusOffset(offset, { focus = true } = {}) {
      if (focus) this.root.focus({ preventScroll: true });
      const map = serializeWithMap(this.root);
      const target = Math.max(0, Math.min(Number(offset) || 0, map.out.length));
      const { node, offset: local } = positionForOffset(map, this.root, target);
      const range = document.createRange();
      range.setStart(node, local);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const rect = range.getBoundingClientRect?.();
      if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
        (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.scrollIntoView?.({ block: "nearest" });
      }
    }

    installCompatibilityProperties() {
      if (this.source instanceof HTMLTextAreaElement) return;
      Object.defineProperties(this.root, {
        value: {
          configurable: true,
          get: () => this.getMarkdown(),
          set: (value) => this.setMarkdown(value),
        },
        selectionStart: {
          configurable: true,
          get: () => this.getMarkdownOffset("start"),
        },
        selectionEnd: {
          configurable: true,
          get: () => this.getMarkdownOffset("end"),
        },
        readOnly: {
          configurable: true,
          get: () => this.root.contentEditable !== "true",
          set: (value) => {
            this.root.contentEditable = value ? "false" : "true";
          },
        },
      });
      this.root.setSelectionRange = (start) => this.focusOffset(start);
    }
  }

  window.FilumRichText = {
    enhance(source, options) {
      if (!source || source._filumRichEditor) return source?._filumRichEditor || null;
      const editor = new RichEditor(source, options);
      source._filumRichEditor = editor;
      return editor;
    },
    markdownToHtml,
    serializeRoot,
    parseBlocks,
    inlineMarkdown,
    escapeHtml,
    MAX_LIST_LEVEL,
  };
})();
