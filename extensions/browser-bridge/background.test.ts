/**
 * Tests for background.js against a mocked chrome.* API and the REAL host.mjs
 * child process — the full WS → native-messaging → handler → reply loop,
 * without Chrome and without chrome.debugger (none is registered anymore).
 *
 * The mock port does exactly what Chrome does for native messaging: onMessage
 * receives parsed JSON objects, postMessage objects are framed onto stdin.
 * The mocked chrome.scripting.executeScript runs the REAL injected functions
 * from injected.js against a hand-built fake DOM, so snapshot → ref → click /
 * type / eval / console_logs are covered end to end at the handler level.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

// --- fake DOM + page globals for the injected functions ----------------------------

// Subclass the REAL Event: replacing globalThis.Event outright breaks Node's
// own WebSocket internals, which validate instanceof Event.
class FakePointerEvent extends Event {}
class FakeMouseEvent extends Event {}

interface FakeElement {
  tagName: string;
  nodeName: string;
  nodeType: number;
  children: FakeElement[];
  attributes: { name: string; value: string }[];
  nodeValue?: string;
  isContentEditable: boolean;
  value?: string;
  events: FakeEvent[];
  clicked: number;
  scrolled?: boolean;
  focused?: boolean;
  appendChild(child: FakeElement): FakeElement;
  scrollIntoView(): void;
  focus(): void;
  click(): void;
  dispatchEvent(e: FakeEvent): void;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function makeEl(tagName: string, attrs: Record<string, string> = {}): FakeElement {
  const el = {
    tagName,
    nodeName: tagName,
    nodeType: 1,
    children: [],
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    isContentEditable: false,
    events: [],
    clicked: 0,
    appendChild(child: FakeElement) {
      el.children.push(child);
      return child;
    },
    scrollIntoView() {
      el.scrolled = true;
    },
    focus() {
      el.focused = true;
    },
    click() {
      el.clicked++;
    },
    dispatchEvent(e: FakeEvent) {
      el.events.push(e);
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 100, height: 50 };
    },
  } as unknown as FakeElement;
  return el;
}

function makeText(text: string): FakeElement {
  return { tagName: "#text", nodeName: "#text", nodeType: 3, nodeValue: text, children: [], attributes: [] } as unknown as FakeElement;
}

const html = makeEl("HTML");
const body = makeEl("BODY");
const anchor = makeEl("A", { href: "https://example.com/", "aria-label": "Docs link" });
const input = makeEl("INPUT", { type: "text", placeholder: "search" });
input.value = "";
html.appendChild(body);
body.appendChild(anchor);
anchor.appendChild(makeText("Docs"));
body.appendChild(input);

const fakeConsole = {
  entries: [] as unknown[],
  log: (...a: unknown[]) => fakeConsole.entries.push(["log", ...a]),
  warn: (...a: unknown[]) => fakeConsole.entries.push(["warn", ...a]),
  error: (...a: unknown[]) => fakeConsole.entries.push(["error", ...a]),
  info: (...a: unknown[]) => fakeConsole.entries.push(["info", ...a]),
  debug: (...a: unknown[]) => fakeConsole.entries.push(["debug", ...a]),
};
const fakeWindow: Record<string, unknown> = { console: fakeConsole };

const g = globalThis as unknown as Record<string, unknown>;
g.document = { documentElement: html, title: "Test Page" };
g.window = fakeWindow;
g.PointerEvent = FakePointerEvent;
g.MouseEvent = FakeMouseEvent;

// --- chrome mock -------------------------------------------------------------------

interface MockPort {
  onMessageListener: ((msg: unknown) => void) | null;
  onDisconnectListener: (() => void) | null;
  posted: unknown[];
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

const tabsFixture = [
  { id: 10, title: "PAI", url: "https://example.com/pai", active: true, windowId: 1 },
  { id: 11, title: "Docs", url: "https://example.com/docs", active: false, windowId: 1 },
];

const connectNativeCalls: MockPort[] = [];
let connectNativeAttempts = 0;
/** When > 0, the next that many connectNative calls throw (host missing). */
let connectNativeFailures = 0;
let lastError: { message: string } | undefined;
/** Hook fired (synchronously) whenever background.js posts to the native port. */
let onNativePost: ((msg: unknown) => void) | null = null;

/** What the mocked chrome.scripting.executeScript does with an injection spec. */
let scriptingImpl: ((spec: { func: (...args: unknown[]) => unknown; args: unknown[] }) => unknown) | null = null;

function makePort(): MockPort {
  const port = {
    onMessageListener: null,
    onDisconnectListener: null,
    posted: [],
    onMessage: { addListener: (fn: (msg: unknown) => void) => (port.onMessageListener = fn) },
    onDisconnect: { addListener: (fn: () => void) => (port.onDisconnectListener = fn) },
    postMessage: (msg: unknown) => {
      port.posted.push(msg);
      onNativePost?.(msg);
    },
  };
  return port;
}

const listenerBags = () => ({ addListener: () => {} });

g.chrome = {
  runtime: {
    connectNative: (_name: string) => {
      connectNativeAttempts++;
      if (connectNativeFailures > 0) {
        connectNativeFailures--;
        throw new Error("Specified native messaging host not found.");
      }
      const p = makePort();
      connectNativeCalls.push(p);
      return p;
    },
    get lastError() {
      return lastError;
    },
    onStartup: listenerBags(),
    onInstalled: listenerBags(),
  },
  tabs: {
    query: (_q: unknown, cb: (tabs: unknown) => void) => cb(tabsFixture),
    get: (id: number, cb: (t: unknown) => void) => cb({ id, windowId: 1 }),
    create: (_o: unknown, cb: (t: unknown) => void) => cb({ id: 1, windowId: 1 }),
    update: (_id: number, _o: unknown, cb: (t: unknown) => void) => cb({ id: 1, windowId: 1 }),
    remove: (_id: number, cb: () => void) => cb(),
    captureVisibleTab: (_winId: number, _opts: unknown, cb: (url: string) => void) =>
      cb("data:image/png;base64,QUJD"),
    onUpdated: listenerBags(),
    onRemoved: listenerBags(),
  },
  windows: { update: (_id: number, _o: unknown, cb: () => void) => cb() },
  scripting: {
    executeScript: (
      spec: { func: (...args: unknown[]) => unknown; args?: unknown[] },
      cb: (results: { result: unknown }[]) => void,
    ) => {
      let result: unknown;
      try {
        result = scriptingImpl ? scriptingImpl(spec) : undefined;
      } catch {
        result = undefined;
      }
      cb([{ result }]);
    },
  },
};

// Import the service worker AFTER the chrome global exists — that is also the
// real order: the SW module evaluates with chrome already present. The default
// scripting impl runs the real injected functions against the fake DOM.
scriptingImpl = (spec) => spec.func(...(spec.args || []));
await import("./background.js");

const activePort = () => connectNativeCalls[connectNativeCalls.length - 1];

/** Drives one command through the handler and resolves the posted reply. */
function sendCommand(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    onNativePost = (m) => {
      onNativePost = null;
      resolve(m as Record<string, unknown>);
    };
    activePort().onMessageListener!(msg);
  });
}

// --- host.mjs helpers for the wire-level loop --------------------------------------

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  ws: WebSocket;
}

/** Spawns host.mjs (ephemeral port, private log) and connects one WS client. */
async function startHostWithClient(): Promise<HostProcess> {
  const hostUrl = new URL("../../src/browser-bridge/host/host.mjs", import.meta.url);
  const logPath = join(mkdtempSync(join(tmpdir(), "pai-bg-test-")), "bridge.log");
  const child = spawn(process.execPath, [fileURLToPath(hostUrl)], {
    env: { ...process.env, PAI_BROWSER_BRIDGE_PORT: "0", PAI_BROWSER_BRIDGE_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  cleanups.push(() => child.kill());

  const port = await new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const timer = setTimeout(() => reject(new Error("host never logged its port")), 5000);
    const poll = setInterval(() => {
      if (!existsSync(logPath)) return;
      const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(logPath, "utf8"));
      if (m) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(Number(m[1]));
      } else if (Date.now() - started > 4900) {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new Error("host log exists but never mentioned its port"));
      }
    }, 25);
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  cleanups.push(() => ws.close());
  return { child, ws };
}

/** Reads length-prefixed frames off the host's stdout, skipping bridge noise (pings). */
function nextStdoutFrame(child: ChildProcessWithoutNullStreams, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("no framed stdout within timeout"));
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
        if (msg?.type === "ping") continue; // keepalive, not ours
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(msg);
      }
    };
    child.stdout.on("data", onData);
  });
}

function nextWsMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ws message within timeout")), timeoutMs);
    ws.onmessage = (ev: MessageEvent) => {
      clearTimeout(timer);
      resolve(String(ev.data));
    };
  });
}

/** Frames one JSON object onto the host's stdin, the way Chrome does. */
function writeFrameToHost(child: ChildProcessWithoutNullStreams, msg: unknown) {
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  child.stdin.write(Buffer.concat([header, payload]));
}

/**
 * Full round trip: WS frame in → host frames it to stdout → deliver it to the
 * extension's onMessage listener (as Chrome would) → the extension's reply via
 * port.postMessage is framed back onto the host's stdin → WS message out.
 */
async function roundTrip(host: HostProcess, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { child, ws } = host;
  const stdoutFrame = nextStdoutFrame(child);
  ws.send(JSON.stringify(request));
  const forwarded = await stdoutFrame; // what Chrome would deliver to the port

  const replyPosted = new Promise<unknown>((resolve) => {
    onNativePost = (msg) => {
      onNativePost = null;
      resolve(msg);
    };
  });
  activePort().onMessageListener!(forwarded);
  writeFrameToHost(child, await replyPosted);
  return JSON.parse(await nextWsMessage(ws));
}

// --- tests -------------------------------------------------------------------------

describe("service worker boot", () => {
  it("connects the native host on startup and registers no debugger API", () => {
    expect(connectNativeCalls).toHaveLength(1);
    expect(activePort().onMessageListener).toBeTypeOf("function");
    expect((g.chrome as Record<string, unknown>).debugger).toBeUndefined();
  });

  it("contains zero chrome.debugger usage — no attach anywhere", () => {
    const src = readFileSync(fileURLToPath(new URL("./background.js", import.meta.url)), "utf8");
    expect(src).not.toMatch(/chrome\.debugger/);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./manifest.json", import.meta.url)), "utf8"));
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.host_permissions).toContain("<all_urls>");
  });
});

describe("full bridge loop (WS → host → NM → handler → reply)", () => {
  it("answers list_tabs sent with the canonical 'command' key", async () => {
    const host = await startHostWithClient();
    const reply = await roundTrip(host, { id: 1, command: "list_tabs" });
    expect(reply).toEqual({
      id: 1,
      ok: true,
      result: tabsFixture.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      })),
    });
  }, 15000);

  it("fails loudly on a wrong wire key instead of hanging — the no-reply repro", async () => {
    const host = await startHostWithClient();
    // A probe using 'cmd' used to get silence until timeout; now it errors.
    const reply = await roundTrip(host, { id: 2, cmd: "list_tabs" });
    expect(reply).toMatchObject({
      id: 2,
      ok: false,
      error: expect.stringContaining("missing command key"),
    });
  }, 15000);

  it("fails loudly on unknown commands", async () => {
    const host = await startHostWithClient();
    const reply = await roundTrip(host, { id: 3, command: "no_such_command" });
    expect(reply).toMatchObject({ id: 3, ok: false, error: expect.stringContaining("unknown command") });
  }, 15000);
});

describe("scripting-based DOM handlers (fake DOM, real injected functions)", () => {
  const TAB = 77;

  it("snapshots via injected walk, wires refs to paths, installs the console hook", async () => {
    const reply = await sendCommand({ id: 10, command: "snapshot", tabId: TAB });
    expect(reply.ok).toBe(true);
    const yaml = (reply.result as { yaml: string }).yaml;
    expect(yaml).toContain('- document "Test Page"');
    expect(yaml).toContain("link"); // the anchor distilled with its role
    expect(fakeWindow.__paiConsoleInstalled).toBe(true); // hook installed at snapshot time
  });

  it("clicks the element behind a ref through the injected click function", async () => {
    const reply = await sendCommand({ id: 11, command: "click", tabId: TAB, ref: "s1" });
    expect(reply).toMatchObject({ id: 11, ok: true, result: { clicked: true, ref: "s1", x: 50, y: 25 } });
    expect(anchor.clicked).toBe(1);
    expect(anchor.scrolled).toBe(true);
  });

  it("types into a field through the injected type function", async () => {
    const reply = await sendCommand({ id: 12, command: "type", tabId: TAB, ref: "s2", text: "hello" });
    expect(reply).toMatchObject({ id: 12, ok: true, result: { typed: true, ref: "s2" } });
    expect(input.value).toBe("hello");
    expect(input.events.map((e) => e.type)).toEqual(["input", "change"]);
    expect(input.focused).toBe(true);
  });

  it("evaluates code in the page and returns the value", async () => {
    const reply = await sendCommand({ id: 13, command: "eval", tabId: TAB, code: "1 + 1" });
    expect(reply).toEqual({ id: 13, ok: true, result: { value: 2 } });
  });

  it("screenshots via captureVisibleTab and strips the data-url prefix", async () => {
    const reply = await sendCommand({ id: 14, command: "screenshot", tabId: TAB });
    expect(reply).toEqual({ id: 14, ok: true, result: { base64: "QUJD" } });
  });

  it("reads back console entries captured by the hook", async () => {
    fakeConsole.error("boom", { a: 1 });
    const reply = await sendCommand({ id: 15, command: "console_logs", tabId: TAB });
    const entries = (reply.result as { entries: { type: string; text: string }[] }).entries;
    expect(entries.at(-1)).toMatchObject({ type: "error", text: "boom {\"a\":1}" });
  });

  it("rejects unknown refs loudly", async () => {
    const reply = await sendCommand({ id: 16, command: "click", tabId: TAB, ref: "s99" });
    expect(reply).toMatchObject({ id: 16, ok: false, error: expect.stringContaining("unknown ref s99") });
  });
});

describe("native port reconnect", () => {
  afterEach(() => {
    vi.useRealTimers();
    lastError = undefined;
    connectNativeFailures = 0;
  });

  it("reconnects after the host dies, consuming lastError", async () => {
    vi.useFakeTimers();
    const before = connectNativeCalls.length;
    lastError = { message: "Native host has exited." };
    activePort().onDisconnectListener!(); // Chrome fires this when host.mjs dies
    expect(connectNativeCalls).toHaveLength(before); // not instantly —
    vi.advanceTimersByTime(2_000); // after the retry delay
    expect(connectNativeCalls).toHaveLength(before + 1); // fresh port, host respawned from disk
  });

  it("keeps retrying with growing backoff while the host cannot be spawned", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const portsBefore = connectNativeCalls.length;
    const attemptsBefore = connectNativeAttempts;
    connectNativeFailures = 2; // first two respawn attempts find no host

    activePort().onDisconnectListener!();
    vi.advanceTimersByTime(2_000); // attempt 1 (2s) throws
    expect(connectNativeAttempts).toBe(attemptsBefore + 1);
    expect(connectNativeCalls).toHaveLength(portsBefore); // still no port
    vi.advanceTimersByTime(2_000); // backoff doubled to 4s — nothing yet
    expect(connectNativeAttempts).toBe(attemptsBefore + 1);
    vi.advanceTimersByTime(2_000); // attempt 2 (4s mark) throws
    expect(connectNativeAttempts).toBe(attemptsBefore + 2);
    vi.advanceTimersByTime(8_000); // 8s backoff elapses, this one succeeds
    expect(connectNativeCalls).toHaveLength(portsBefore + 1);
    errorSpy.mockRestore();
  });
});
