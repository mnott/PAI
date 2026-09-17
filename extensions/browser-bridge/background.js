/**
 * PAI Browser Bridge — MV3 module service worker.
 *
 * Owns the native messaging port to com.pai.browser_bridge and answers JSON
 * commands arriving over it with {id, ok, result} / {id, ok: false, error}.
 * Tab operations go through chrome.tabs; DOM operations attach the CDP
 * debugger (chrome.debugger) per tab — the real running Chrome, no remote
 * debugging port, nothing headless.
 *
 * Keeps itself alive with a 20s ping from the host over the port (incoming
 * messages reset the MV3 idle timer), and reconnects the port on wake.
 */

import { buildSnapshot } from "./snapshot.js";

const HOST_NAME = "com.pai.browser_bridge";

/** @type {chrome.runtime.Port|null} */
let port = null;

/** tabId -> Map(ref -> CDP nodeId), valid until next snapshot/navigation */
const refMaps = new Map();

/** tabId -> console/log entries (ring, cap below) */
const consoleBuffers = new Map();
const CONSOLE_CAP = 500;

/** tabIds this worker attached the debugger to (best effort) */
const attached = new Set();

// ---------------------------------------------------------------------------
// Native messaging port
// ---------------------------------------------------------------------------

function connectHost() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error("browser-bridge: connectNative failed", e);
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Chrome may have killed the host (or the SW is going down); retry soon.
    setTimeout(connectHost, 2_000);
  });
}

/**
 * Handles one framed JSON message from the host.
 * Bridge control messages (ping) are silent; commands get a reply.
 */
function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return; // host keepalive, resets the idle timer
  const { id, command, ...params } = msg;
  if (command === undefined) return;
  handleCommand(command, params)
    .then((result) => reply(id, true, result))
    .catch((e) => reply(id, false, undefined, e?.message ?? String(e)));
}

function reply(id, ok, result, error) {
  if (port && id !== undefined) {
    try {
      port.postMessage(ok ? { id, ok: true, result } : { id, ok: false, error });
    } catch (e) {
      console.error("browser-bridge: postMessage failed", e);
    }
  }
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

function cdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(`${method}: ${e.message}`));
      else resolve(res);
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve();
    });
  });
}

/**
 * Attaches unless already attached. "Already attached" after a service worker
 * restart is usually OUR old session — probe and reuse it; if the tab answers
 * nothing (someone else's debugger), detach and reattach once, then give up.
 */
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await attachDebugger(tabId);
    attached.add(tabId);
    await cdp(tabId, "Runtime.enable");
    await cdp(tabId, "Log.enable");
    return;
  } catch (e) {
    if (!/already attached/i.test(String(e?.message ?? e))) throw e;
  }
  try {
    await cdp(tabId, "Runtime.enable");
    await cdp(tabId, "Log.enable");
    attached.add(tabId); // ours after all — reuse
  } catch {
    try {
      await detachDebugger(tabId);
      await attachDebugger(tabId);
      attached.add(tabId);
      await cdp(tabId, "Runtime.enable");
      await cdp(tabId, "Log.enable");
    } catch (e2) {
      throw new Error(
        `debugger already attached by another client: ${e2?.message ?? e2}`
      );
    }
  }
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
    resolve();
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId !== undefined) attached.delete(source.tabId);
});

// Console + log collection while the debugger is attached.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId === undefined) return;
  if (method !== "Runtime.consoleAPICalled" && method !== "Log.entryAdded") return;
  const buf = consoleBuffers.get(tabId) ?? [];
  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
      .join(" ");
    buf.push({ source: "console", type: params.type, text, timestamp: params.timestamp });
  } else {
    buf.push({
      source: "log",
      level: params.level,
      text: params.text,
      url: params.url,
      timestamp: params.timestamp,
    });
  }
  while (buf.length > CONSOLE_CAP) buf.shift();
  consoleBuffers.set(tabId, buf);
});

// Navigation invalidates refs and console context for that tab.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    refMaps.delete(tabId);
    consoleBuffers.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  refMaps.delete(tabId);
  consoleBuffers.delete(tabId);
  attached.delete(tabId);
});

// ---------------------------------------------------------------------------
// DOM walk → distilled tree for snapshot.js
// ---------------------------------------------------------------------------

const KEEP_ATTRS = new Set([
  "role",
  "aria-label",
  "name",
  "id",
  "placeholder",
  "href",
  "type",
  "value",
  "tabindex",
  "title",
]);

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD"]);

/** Flattens CDP's [name, value, name, value...] attribute array. */
function attrsToMap(flat) {
  const out = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const name = flat[i];
    if (!KEEP_ATTRS.has(name)) continue;
    out[name === "aria-label" ? "aria-label" : name] = flat[i + 1];
  }
  return out;
}

/**
 * Distills a CDP DOM Node into the simplified shape snapshot.js expects.
 * getAttributes is only called when the node came back without inline
 * attributes (large documents may omit them).
 */
async function distill(node, tabId, depthGuard = 0) {
  if (!node || depthGuard > 60) return null;
  if (node.nodeType === 3) {
    const text = String(node.nodeValue ?? "").replace(/\s+/g, " ").trim();
    return text ? { nodeId: node.nodeId, nodeName: "#text", nodeType: 3, attrs: { text }, children: [] } : null;
  }
  let flat = node.attributes;
  if (flat === undefined && node.nodeId) {
    try {
      flat = (await cdp(tabId, "DOM.getAttributes", { nodeId: node.nodeId })).attributes;
    } catch {
      flat = [];
    }
  }
  const attrs = attrsToMap(flat);
  if (node.nodeName === "#document") {
    const title = (node.children || [])
      .flatMap((c) => c.children || [])
      .filter((c) => c.nodeName === "TITLE")
      .map((c) => c.children || [])
      .flat()
      .map((t) => t.nodeValue)
      .join(" ")
      .trim();
    if (title) attrs.name = title;
  }
  const children = [];
  for (const child of node.children || []) {
    if (SKIP_TAGS.has(child.nodeName)) continue;
    const distilled = await distill(child, tabId, depthGuard + 1);
    if (distilled) children.push(distilled);
  }
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    nodeType: node.nodeType,
    attrs,
    children,
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function tabsQuery(query) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(query, (tabs) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(tabs);
    });
  });
}

function resolveRef(tabId, ref) {
  const map = refMaps.get(tabId);
  const nodeId = map?.get(ref);
  if (nodeId === undefined) {
    throw new Error(`unknown ref ${ref} — take a new snapshot`);
  }
  return nodeId;
}

async function handleCommand(command, p) {
  switch (command) {
    case "list_tabs": {
      const tabs = await tabsQuery({});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        url: t.url ?? "",
        active: !!t.active,
        windowId: t.windowId,
      }));
    }

    case "open_tab": {
      const created = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: String(p.url), active: p.active !== false }, (t) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve(t);
        });
      });
      return { id: created.id, windowId: created.windowId };
    }

    case "select_tab": {
      const tabId = Number(p.tabId);
      const tab = await new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, { active: true }, (t) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve(t);
        });
      });
      await new Promise((resolve) => {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      return { id: tab.id };
    }

    case "close_tab":
      await new Promise((resolve, reject) => {
        chrome.tabs.remove(Number(p.tabId), () => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve();
        });
      });
      refMaps.delete(Number(p.tabId));
      consoleBuffers.delete(Number(p.tabId));
      return { closed: true };

    case "snapshot": {
      const tabId = Number(p.tabId);
      await ensureAttached(tabId);
      const { root } = await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });
      const tree = await distill(root, tabId);
      if (!tree) throw new Error("could not read DOM for this tab");
      const { yaml, refMap } = buildSnapshot(tree);
      const map = new Map(Object.entries(refMap).map(([ref, id]) => [ref, id]));
      refMaps.set(tabId, map);
      return { yaml };
    }

    case "click": {
      const tabId = Number(p.tabId);
      const nodeId = resolveRef(tabId, String(p.ref));
      await ensureAttached(tabId);
      const { object } = await cdp(tabId, "DOM.resolveNode", { nodeId });
      await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { nodeId }).catch(() => {});
      const box = await cdp(tabId, "DOM.getBoxModel", {
        ...(object?.objectId ? { objectId: object.objectId } : { nodeId }),
      }).catch(() => cdp(tabId, "DOM.getBoxModel", { nodeId }));
      const [x1, , x2, , , y2, , y1] = box.model.border;
      const x = (x1 + x2) / 2;
      const y = (y1 + y2) / 2;
      const base = { x, y, button: "left", clickCount: 1 };
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
      return { clicked: true, ref: String(p.ref), x, y };
    }

    case "type": {
      const tabId = Number(p.tabId);
      const nodeId = resolveRef(tabId, String(p.ref));
      await ensureAttached(tabId);
      const { object } = await cdp(tabId, "DOM.resolveNode", { nodeId });
      if (!object?.objectId) throw new Error("could not resolve element for typing");
      await cdp(tabId, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.focus(); }",
      });
      await cdp(tabId, "Input.insertText", { text: String(p.text) });
      return { typed: true, ref: String(p.ref) };
    }

    case "eval": {
      const tabId = Number(p.tabId);
      await ensureAttached(tabId);
      const r = await cdp(tabId, "Runtime.evaluate", {
        expression: String(p.code),
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return { value: jsonSafe(r.result?.value) };
    }

    case "screenshot": {
      const tabId = Number(p.tabId);
      await ensureAttached(tabId);
      const r = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
      return { base64: r.data };
    }

    case "console_logs": {
      const tabId = Number(p.tabId);
      return { entries: consoleBuffers.get(tabId) ?? [] };
    }

    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/** JSON-safe serialization for eval results (DOM nodes, circular refs, ...). */
function jsonSafe(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? String(value) : value;
  }
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === "function" ? "[function]" : jsonSafe(v, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

connectHost();
chrome.runtime.onStartup.addListener(connectHost);
chrome.runtime.onInstalled.addListener(connectHost);
