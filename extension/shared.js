// Filum — Web Journey: helpers shared by the popup and the service worker.
// Plain functions, no state. See engineering.md → "Web Journey".

export const DEFAULT_SERVER = "http://localhost:4317";
export const MAX_TRAIL_NODES = 80;

const SEARCH_ENGINES = [
  { host: /(^|\.)google\.[a-z.]+$/i, path: /^\/search/, name: "Google" },
  { host: /(^|\.)bing\.com$/i, path: /^\/search/, name: "Bing" },
  { host: /(^|\.)duckduckgo\.com$/i, path: /^\/($|\?)/, name: "DuckDuckGo" },
  { host: /(^|\.)search\.brave\.com$/i, path: /^\/search/, name: "Brave" },
  { host: /(^|\.)ecosia\.org$/i, path: /^\/search/, name: "Ecosia" },
  { host: /(^|\.)kagi\.com$/i, path: /^\/search/, name: "Kagi" },
];

export function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function isCapturableUrl(value) {
  return !!parseHttpUrl(value);
}

// Two addresses are "the same page" if they differ only by #fragment.
export function samePage(a, b) {
  const ua = parseHttpUrl(a);
  const ub = parseHttpUrl(b);
  if (!ua || !ub) return a === b;
  ua.hash = "";
  ub.hash = "";
  return ua.href === ub.href;
}

export function searchInfo(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const engine = SEARCH_ENGINES.find(
    (e) => e.host.test(parsed.hostname) && e.path.test(parsed.pathname + parsed.search)
  );
  if (!engine) return null;
  return { name: engine.name, query: parsed.searchParams.get("q") || parsed.searchParams.get("query") || "" };
}

// Chrome's transition vocabulary, folded into the four words Filum stores.
export function nodeType(url, transitionType) {
  if (searchInfo(url) || transitionType === "generated") return "search";
  if (transitionType === "typed" || transitionType === "keyword") return "typed";
  if (transitionType === "auto_bookmark") return "bookmark";
  return "link";
}

export function hostOf(url) {
  const parsed = parseHttpUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, "") : "";
}

export function displayTitle(node) {
  const search = searchInfo(node.url);
  if (search && search.query) return `${search.name}: ${search.query}`;
  return node.ogTitle || node.title || node.firstH1 || hostOf(node.url) || node.url;
}

export function truncate(text, max) {
  const clean = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// "✦ web journey — 3 steps from Google: chaos theory" — written into the
// task's notes so the trail is discoverable without opening it.
export function crossReference(trail) {
  const n = trail.nodes.length;
  const origin = n > 1 ? truncate(displayTitle(trail.nodes[0]), 60) : "direct visit";
  return `✦ web journey — ${n} step${n === 1 ? "" : "s"} from ${origin}`;
}

export function emptyNode(url) {
  return {
    url,
    title: "",
    type: "link",
    referrer: "",
    snippet: "",
    metaDescription: "",
    ogTitle: "",
    ogDescription: "",
    ogImage: "",
    ogImageData: "",
    firstH1: "",
    visitedAt: new Date().toISOString(),
  };
}

// Fold a page's harvested context into a trail node.
export function withContext(node, context, { includeSnippet }) {
  if (!context) return node;
  return {
    ...node,
    title: context.title || node.title,
    referrer: node.referrer || context.referrer || "",
    snippet: includeSnippet ? context.selectedText || "" : node.snippet,
    metaDescription: context.metaDescription || "",
    ogTitle: context.ogTitle || "",
    ogDescription: context.ogDescription || "",
    ogImage: context.ogImage || "",
    ogImageData: context.ogImageData || "",
    firstH1: context.firstH1 || "",
  };
}

// Only loopback addresses: Filum runs on the user's own machine, and browsing
// trails should never be sent anywhere else.
export function normalizeServerUrl(value) {
  const raw = String(value || "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = parseHttpUrl(withScheme);
  if (!url) return null;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
}

export async function getServerUrl() {
  try {
    const { serverUrl } = await chrome.storage.local.get("serverUrl");
    return normalizeServerUrl(serverUrl) || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export async function api(server, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 6000);
  try {
    const res = await fetch(`${server}${pathname}`, {
      method: options.method || "GET",
      headers: options.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((data && data.error) || `request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Runs inside the page via chrome.scripting.executeScript, so it must stay
// self-contained (no closures over this module). It reads what the page says
// about itself, plus whatever text the user has highlighted, and inlines a
// small thumbnail of the Open Graph image so Filum never has to fetch it.
export async function extractPageContext() {
  const meta = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute("content") || "").replace(/\s+/g, " ").trim() : "";
  };
  const absolute = (value) => {
    try {
      return value ? new URL(value, location.href).href : "";
    } catch {
      return "";
    }
  };
  const clip = (value, max) => String(value || "").slice(0, max);
  const ogImage = absolute(
    meta('meta[property="og:image"]') || meta('meta[name="og:image"]') || meta('meta[name="twitter:image"]')
  );

  let ogImageData = "";
  if (/^https?:/i.test(ogImage)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(ogImage, { credentials: "omit", signal: controller.signal });
      clearTimeout(timer);
      const blob = res.ok ? await res.blob() : null;
      if (blob && blob.type.startsWith("image/") && blob.size < 8 * 1024 * 1024) {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, 240 / bitmap.width, 240 / bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#f5f1e8"; // transparent PNGs settle onto Filum cream
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        ogImageData = canvas.toDataURL("image/jpeg", 0.78);
      }
    } catch {
      // Cross-origin, blocked, or slow: the URL alone is still stored.
    }
  }

  const h1 = document.querySelector("h1");
  const selection = typeof window.getSelection === "function" ? String(window.getSelection() || "") : "";
  return {
    title: clip(document.title, 300),
    url: location.href,
    referrer: document.referrer || "",
    selectedText: clip(selection.replace(/\s+/g, " ").trim(), 2000),
    metaDescription: clip(meta('meta[name="description"]') || meta('meta[name="Description"]'), 600),
    ogTitle: clip(meta('meta[property="og:title"]'), 300),
    ogDescription: clip(meta('meta[property="og:description"]'), 600),
    ogImage: clip(ogImage, 2000),
    ogImageData,
    firstH1: clip(h1 ? h1.textContent.replace(/\s+/g, " ").trim() : "", 300),
  };
}
