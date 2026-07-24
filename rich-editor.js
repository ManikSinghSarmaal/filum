(() => {
  "use strict";

  const URL_PATTERN = /^(?:https?:\/\/|mailto:)/i;

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

  function threadReferenceHtml(label, id) {
    const safeLabel = escapeHtml(label);
    return `<span class="thread-reference thread-reference--editable"
      data-thread-ref="${escapeHtml(id)}" data-thread-label="${safeLabel}" contenteditable="false">
      <button class="thread-reference-remove" type="button"
        data-thread-ref-remove aria-label="Remove @${safeLabel} reference">×</button>
      <span class="thread-reference-label">@${safeLabel}</span>
    </span>`;
  }

  function inlineMarkdown(raw) {
    const tokens = [];
    const stash = (html) => {
      tokens.push(html);
      return `\u0000${tokens.length - 1}\u0000`;
    };
    let text = String(raw || "");

    text = text.replace(
      /@\[([^\]]+)\]\(filum:thread\/([a-z0-9-]{8,64})\)/gi,
      (_match, label, id) => stash(threadReferenceHtml(label, id))
    );
    text = text.replace(/`([^`\n]+)`/g, (_match, body) =>
      stash(`<code>${escapeHtml(body)}</code>`)
    );
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi, (_match, label, href) =>
      stash(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      )
    );

    let html = escapeHtml(text);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<u>$1</u>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
  }

  function markdownToHtml(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let paragraph = [];
    let list = null;
    let fence = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      blocks.push(
        `<${list.tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${list.tag}>`
      );
      list = null;
    };

    for (const line of lines) {
      if (fence) {
        if (line.trim().startsWith("```")) {
          blocks.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
          fence = null;
        } else {
          fence.push(line);
        }
        continue;
      }
      if (line.trim().startsWith("```")) {
        flushParagraph();
        flushList();
        fence = [];
        continue;
      }
      const bullet = line.match(/^\s*-\s+(.*)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (bullet || ordered) {
        flushParagraph();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || ordered)[1]);
        continue;
      }
      flushList();
      if (!line && paragraph.length) {
        flushParagraph();
      } else {
        paragraph.push(line);
      }
    }
    if (fence) blocks.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
    flushParagraph();
    flushList();
    return blocks.join("") || "<p><br></p>";
  }

  function inlineFromNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (!(node instanceof HTMLElement)) return "";
    const inner = Array.from(node.childNodes).map(inlineFromNode).join("");
    if (node.matches("[data-thread-ref]")) {
      const id = node.dataset.threadRef || "";
      const label =
        node.dataset.threadLabel ||
        node.querySelector(".thread-reference-label")?.textContent.replace(/^@/, "") ||
        "Thread";
      return `@[${label}](filum:thread/${id})`;
    }
    if (node.tagName === "STRONG" || node.tagName === "B") return `**${inner}**`;
    if (node.tagName === "EM" || node.tagName === "I") return `*${inner}*`;
    if (node.tagName === "U") return `__${inner}__`;
    if (node.tagName === "SPAN") {
      let marked = inner;
      const weight = node.style.fontWeight;
      if (weight === "bold" || Number.parseInt(weight, 10) >= 600) marked = `**${marked}**`;
      if (node.style.fontStyle === "italic") marked = `*${marked}*`;
      if (node.style.textDecorationLine.includes("underline")) marked = `__${marked}__`;
      return marked;
    }
    if (node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") return `\`${inner}\``;
    if (node.tagName === "A") {
      const href = safeHref(node.getAttribute("href"));
      return href ? `[${inner || href}](${href})` : inner;
    }
    if (node.tagName === "BR") return "\n";
    return inner;
  }

  function serializeRoot(root) {
    const parts = [];
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || "");
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      if (node.tagName === "UL" || node.tagName === "OL") {
        const ordered = node.tagName === "OL";
        const items = Array.from(node.children)
          .filter((child) => child.tagName === "LI")
          .map((child, index) => `${ordered ? `${index + 1}.` : "-"} ${inlineFromNode(child)}`);
        parts.push(items.join("\n"));
      } else if (node.tagName === "PRE") {
        parts.push(`\`\`\`\n${node.textContent || ""}\n\`\`\``);
      } else if (/^(P|DIV|H[1-6])$/.test(node.tagName)) {
        parts.push(Array.from(node.childNodes).map(inlineFromNode).join(""));
      } else {
        parts.push(inlineFromNode(node));
      }
    }
    return parts
      .join("\n\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+$/g, "")
      .replace(/\n{4,}/g, "\n\n\n");
  }

  function selectionInside(root) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer);
  }

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
          this.removeThreadReference(remove.closest("[data-thread-ref]"));
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
        if (row) this.insertMention(row.dataset.mentionId, row.dataset.mentionName);
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
      if ((event.key === "Backspace" || event.key === "Delete") && this.deleteSelectedContent()) {
        event.preventDefault();
        return;
      }
      if (!this.mentionMenu.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          this.mentionIndex =
            (this.mentionIndex + direction + this.mentionItems.length) % this.mentionItems.length;
          this.renderMentionMenu();
        } else if (event.key === "Enter" && this.mentionItems[this.mentionIndex]) {
          event.preventDefault();
          const item = this.mentionItems[this.mentionIndex];
          this.insertMention(item.id, item.name);
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.closeMentionMenu();
        }
      }
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
      this.syncSource();
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
      this.mentionMenu.innerHTML = this.mentionItems
        .map(
          (item, index) =>
            `<button type="button" data-mention-id="${escapeHtml(item.id)}" data-mention-name="${escapeHtml(item.name)}" class="${index === this.mentionIndex ? "is-active" : ""}">${escapeHtml(item.name)}</button>`
        )
        .join("");
    }

    closeMentionMenu() {
      this.mentionMenu.hidden = true;
      this.mentionMenu.innerHTML = "";
      this.mentionItems = [];
      this.mentionRange = null;
    }

    insertMention(id, name) {
      if (!this.mentionRange?.node?.isConnected) return;
      const range = document.createRange();
      range.setStart(this.mentionRange.node, this.mentionRange.start);
      range.setEnd(this.mentionRange.node, this.mentionRange.end);
      range.deleteContents();
      const holder = document.createElement("div");
      holder.innerHTML = threadReferenceHtml(name, id);
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
      this.syncSource();
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

    deleteSelectedContent() {
      const selection = window.getSelection();
      if (
        !selection?.rangeCount ||
        selection.isCollapsed ||
        !this.root.contains(selection.anchorNode) ||
        !this.root.contains(selection.focusNode)
      ) {
        return false;
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      if (!this.root.childNodes.length) this.root.innerHTML = "<p><br></p>";
      range.selectNodeContents(this.root);
      range.collapse(false);
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
      if (this.getMarkdown() === value) return;
      this.root.innerHTML = markdownToHtml(value);
      if (this.source instanceof HTMLTextAreaElement) this.source.value = value;
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

    getMarkdownOffset() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selectionInside(this.root)) return this.getMarkdown().length;
      const selected = selection.getRangeAt(0);
      const prefix = document.createRange();
      prefix.selectNodeContents(this.root);
      prefix.setEnd(selected.startContainer, selected.startOffset);
      const holder = document.createElement("div");
      holder.appendChild(prefix.cloneContents());
      return serializeRoot(holder).length;
    }

    focusOffset(offset) {
      this.root.focus({ preventScroll: true });
      const target = Math.max(0, Number(offset) || 0);
      const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
      let remaining = target;
      let node;
      while ((node = walker.nextNode())) {
        if (remaining <= node.nodeValue.length) {
          const range = document.createRange();
          range.setStart(node, remaining);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= node.nodeValue.length;
      }
      const range = document.createRange();
      range.selectNodeContents(this.root);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
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
          get: () => this.getMarkdownOffset(),
        },
        selectionEnd: {
          configurable: true,
          get: () => this.getMarkdownOffset(),
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
  };
})();
