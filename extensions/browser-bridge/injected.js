/**
 * Functions injected into pages via chrome.scripting.executeScript.
 *
 * Each exported function must be fully self-contained: Chrome serializes the
 * function body and runs it in the page, so module-level constants and imports
 * are NOT available inside them (constants are inlined per function on
 * purpose). They use only ambient page globals (document, Event, ...).
 *
 * Exported so vitest can run them against a hand-built fake DOM — no Chrome,
 * no jsdom; the tests provide the few globals these functions touch.
 *
 * No chrome.debugger anywhere: attach-free DOM access is the point.
 */

/**
 * Walks the live DOM and distills it into the tree shape snapshot.js
 * consumes: { nodeId, nodeName, nodeType, attrs, children }. Also returns
 * `paths` (nodeId → child-index path from document.documentElement) so later
 * click/type can navigate straight back to the element without CDP nodeIds.
 * Runs in the ISOLATED world; the DOM is shared, the page's JS is not.
 */
export function walkDom() {
  const KEEP_ATTRS = new Set([
    "role", "aria-label", "name", "id", "placeholder", "href", "type", "value", "tabindex", "title",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD"]);
  let nextId = 1;
  const paths = {};

  const attrsOf = (el) => {
    const out = {};
    for (const a of el.attributes || []) {
      if (KEEP_ATTRS.has(a.name)) out[a.name] = a.value;
    }
    return out;
  };

  const walk = (node, path, depth) => {
    if (!node || depth > 60) return null;
    if (node.nodeType === 3) {
      const text = String(node.nodeValue ?? "").replace(/\s+/g, " ").trim();
      return text ? { nodeId: 0, nodeName: "#text", nodeType: 3, attrs: { text }, children: [] } : null;
    }
    const id = nextId++;
    paths[id] = path;
    const children = [];
    const kids = node.children || [];
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (SKIP_TAGS.has(child.tagName)) continue;
      const distilled = walk(child, path.concat([i]), depth + 1);
      if (distilled) children.push(distilled);
    }
    return { nodeId: id, nodeName: node.tagName, nodeType: node.nodeType, attrs: attrsOf(node), children };
  };

  const root = document.documentElement;
  const tree = {
    nodeId: nextId++,
    nodeName: "#document",
    nodeType: 9,
    attrs: {},
    children: root ? [walk(root, [], 0)].filter(Boolean) : [],
  };
  const title = document.title;
  if (title) tree.attrs.name = title;
  return { tree, paths };
}

/**
 * Clicks the element at a snapshot path: scrollIntoView, then the element's
 * own click(); a pointerdown/pointerup/click dispatch is the fallback for
 * elements that do not implement click(). Exactly one click fires either way.
 */
export function clickByPath(path) {
  let el = document.documentElement;
  if (!el) return { clicked: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { clicked: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (!el || el.nodeType !== 1) return { clicked: false, error: "stale ref — take a new snapshot" };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (typeof el.click === "function") {
    el.click();
  } else {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  const r = el.getBoundingClientRect();
  return { clicked: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Types text into the element at a snapshot path. Form fields get the value
 * appended through the native setter (so framework listeners see it) plus
 * input/change events; contenteditable elements (and anything caret-oriented)
 * get document.execCommand("insertText") at the caret.
 */
export function typeByPath(path, text) {
  let el = document.documentElement;
  if (!el) return { typed: false, error: "stale ref — take a new snapshot" };
  for (const i of path) {
    const next = el.children[i];
    if (!next) return { typed: false, error: "stale ref — take a new snapshot" };
    el = next;
  }
  if (el.nodeType !== 1) return { typed: false, error: "stale ref — take a new snapshot" };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (typeof el.focus === "function") el.focus();
  if (typeof el.value === "string") {
    const proto = Object.getPrototypeOf(el) || {};
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, el.value + text);
    else el.value = el.value + text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: true };
  }
  if (el.isContentEditable && typeof document.execCommand === "function") {
    if (document.execCommand("insertText", false, text)) return { typed: true };
  }
  return { typed: false, error: "element is not typable (no value property, not contenteditable)" };
}

/**
 * Evaluates code in the page. Returns { ok, value } with the value pre-sanitized
 * to JSON (executeScript drops non-serializable returns outright).
 */
export function evalInPage(code) {
  try {
    const value = eval(code);
    try {
      JSON.stringify(value);
      return { ok: true, value: value === undefined ? null : value };
    } catch {
      return { ok: true, value: String(value) };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * Patches console.log/info/warn/error/debug in the page (MAIN world) to append
 * to a window buffer, ring-capped. Idempotent. Installed at snapshot time so
 * console_logs has something to read back on demand.
 */
export function installConsoleHook() {
  const w = window;
  if (w.__paiConsoleInstalled) return { installed: false, already: true };
  const CAP = 500;
  const buf = (w.__paiConsole = Array.isArray(w.__paiConsole) ? w.__paiConsole : []);
  const textOf = (a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const orig = w.console[method];
    if (typeof orig !== "function") continue;
    w.console[method] = function (...args) {
      try {
        buf.push({ source: "console", type: method, text: args.map(textOf).join(" "), timestamp: Date.now() });
        while (buf.length > CAP) buf.shift();
      } catch {
        /* never break the page's own logging */
      }
      return orig.apply(this, args);
    };
  }
  w.__paiConsoleInstalled = true;
  return { installed: true };
}

/** Reads the console buffer back (MAIN world). */
export function readConsole() {
  return { entries: (window.__paiConsole || []).slice(-500) };
}
