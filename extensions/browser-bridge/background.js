/**
 * PAI Browser Bridge — MV3 module service worker.
 *
 * Owns the native messaging port to com.pai.browser_bridge and answers JSON
 * commands arriving over it with {id, ok, result} / {id, ok: false, error}.
 * Tab operations go through chrome.tabs; DOM operations inject script via
 * chrome.scripting — the real running Chrome, no remote debugging port, no
 * debugger attachment (and therefore no "started debugging this browser"
 * banner), nothing headless.
 *
 * Every command frame gets a reply — ok or explicit error. A bad wire key
 * fails loudly instead of hanging the caller (that silent drop cost an hour
 * once). Keeps itself alive with a 20s ping from the host over the port
 * (incoming messages reset the MV3 idle timer), and reconnects the port on
 * wake and after host death.
 */

import { buildSnapshot } from "./snapshot.js";
import {
  walkDom,
  clickByPath,
  typeByPath,
  evalInPage,
  installConsoleHook,
  readConsole,
} from "./injected.js";

const HOST_NAME = "com.pai.browser_bridge";

/** @type {chrome.runtime.Port|null} */
let port = null;

let reconnectTimer = null;
let reconnectDelay = 2_000;
const RECONNECT_MAX_DELAY = 30_000;

/** tabId -> Map(ref -> child-index path from document.documentElement) */
const refMaps = new Map();

// ---------------------------------------------------------------------------
// Native messaging port
// ---------------------------------------------------------------------------

function connectHost() {
  if (port) return;
  let nativePort;
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error("browser-bridge: connectNative failed", e);
    scheduleReconnect();
    return;
  }
  port = nativePort;
  reconnectDelay = 2_000; // connected — reset the backoff
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    // Consume the disconnect reason, or Chrome logs an unchecked-lastError
    // error on the extension card for every host death.
    const why = chrome.runtime.lastError?.message;
    if (why) console.warn("browser-bridge: host disconnected:", why);
    port = null;
    scheduleReconnect();
  });
}

/**
 * Reconnects with capped backoff. connectNative respawns host.mjs from disk,
 * so a killed or stale host is replaced with fresh code on every retry.
 * MV3 note: a pending timer dies with a suspended service worker, but any
 * wake event (tab activity, onStartup) re-runs this module's top-level
 * connectHost(), so reconnect also happens on service-worker wake.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHost();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
}

/**
 * Handles one framed JSON message from the host.
 * Bridge control messages (ping) are silent; every command frame gets a
 * reply, so malformed or unknown requests fail loudly instead of hanging.
 */
function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") return; // host keepalive, resets the idle timer
  const { id, command, ...params } = msg;
  if (command === undefined) {
    reply(id, false, undefined, "missing command key (send 'command')");
    return;
  }
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
// Scripting plumbing
// ---------------------------------------------------------------------------

/**
 * Runs one injected function in a tab and resolves its result.
 * Injection needs host permission for the tab (host_permissions: all_urls).
 */
function execScript(tabId, func, args = [], world = "ISOLATED") {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, func, args, world }, (results) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(results?.[0]?.result);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message));
      else resolve(tab);
    });
  });
}

// Navigation invalidates refs for that tab.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") refMaps.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  refMaps.delete(tabId);
});

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

/** ref → child-index path from the last snapshot, or a loud error. */
function resolveRefPath(tabId, ref) {
  const path = refMaps.get(tabId)?.get(String(ref));
  if (!path) throw new Error(`unknown ref ${ref} — take a new snapshot`);
  return path;
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
      return { closed: true };

    case "snapshot": {
      const tabId = Number(p.tabId);
      const { tree, paths } = await execScript(tabId, walkDom);
      if (!tree) throw new Error("could not read DOM for this tab");
      const { yaml, refMap } = buildSnapshot(tree);
      const map = new Map();
      for (const [ref, nodeId] of Object.entries(refMap)) {
        const path = paths[nodeId];
        if (path) map.set(ref, path); // interactive elements only
      }
      refMaps.set(tabId, map);
      // Console capture hook, installed with the snapshot (MAIN world, best effort).
      await execScript(tabId, installConsoleHook, [], "MAIN").catch(() => {});
      return { yaml };
    }

    case "click": {
      const tabId = Number(p.tabId);
      const path = resolveRefPath(tabId, String(p.ref));
      const r = await execScript(tabId, clickByPath, [path]);
      if (r?.error) throw new Error(r.error);
      return { clicked: true, ref: String(p.ref), x: r.x, y: r.y };
    }

    case "type": {
      const tabId = Number(p.tabId);
      const path = resolveRefPath(tabId, String(p.ref));
      const r = await execScript(tabId, typeByPath, [path, String(p.text)]);
      if (r?.error) throw new Error(r.error);
      return { typed: true, ref: String(p.ref) };
    }

    case "eval": {
      const tabId = Number(p.tabId);
      const r = await execScript(tabId, evalInPage, [String(p.code)]);
      if (!r?.ok) throw new Error(r?.error ?? "eval failed");
      return { value: jsonSafe(r.value) };
    }

    case "screenshot": {
      const tabId = Number(p.tabId);
      const tab = await tabsGet(tabId);
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (url) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve(url);
        });
      });
      return { base64: String(dataUrl).replace(/^data:image\/\w+;base64,/, "") };
    }

    case "console_logs": {
      const tabId = Number(p.tabId);
      const r = await execScript(tabId, readConsole, [], "MAIN").catch(() => null);
      return { entries: r?.entries ?? [] };
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
