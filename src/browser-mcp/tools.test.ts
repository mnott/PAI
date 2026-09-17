/**
 * Tests for the pai-browser MCP tools: every tool must map to the right wire
 * command with the right params, the not-connected case must surface the
 * "start Chrome" error text as a tool error, and BridgeClient must correlate
 * replies by request id. No real Chrome, no real socket — the bridge is a
 * mock, the WebSocket a fake.
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBrowserTools, BROWSER_TOOLS, runBrowserTool } from "./tools.js";
import { BridgeClient, NOT_CONNECTED_MESSAGE, type WebSocketLike } from "./bridge-client.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Immediately-failing socket: connects to nothing, errors right away. */
function failingSocketFactory() {
  return () => {
    const ws: WebSocketLike = {
      readyState: 0,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: () => {},
      close: () => {},
    };
    setTimeout(() => ws.onerror?.(), 0);
    return ws;
  };
}

/**
 * Scriptable socket: opens on the next tick, records everything sent, and
 * lets the test deliver replies by id.
 */
function fakeSocketFactory() {
  const sockets: Array<WebSocketLike & { sent: string[]; reply: (s: string) => void }> = [];
  const factory = () => {
    const ws = {
      readyState: 0,
      sent: [] as string[],
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onmessage: null as ((ev: { data: string }) => void) | null,
      send: (data: string) => {
        ws.sent.push(data);
      },
      close: () => {
        ws.readyState = 3;
        ws.onclose?.();
      },
      reply: (s: string) => ws.onmessage?.({ data: s }),
    };
    sockets.push(ws);
    setTimeout(() => {
      ws.readyState = 1;
      ws.onopen?.();
    }, 0);
    return ws;
  };
  return { factory, sockets };
}

async function connectedPair(bridge: { send: (c: string, p?: Record<string, unknown>) => Promise<unknown> }) {
  const server = new McpServer({ name: "pai-browser-test", version: "0.0.0" });
  registerBrowserTools(server, bridge);
  const client = new Client({ name: "pai-browser-test-client", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

// ---------------------------------------------------------------------------
// Tool → wire mapping
// ---------------------------------------------------------------------------

describe("browser MCP tool → wire command mapping", () => {
  it("exposes exactly the 11 tools from the brief", () => {
    expect(BROWSER_TOOLS.map((t) => t.name)).toEqual([
      "tabs_list",
      "tab_open",
      "tab_select",
      "tab_close",
      "dom_snapshot",
      "dom_click",
      "dom_type",
      "page_text",
      "eval_js",
      "tab_screenshot",
      "console_logs",
    ]);
  });

  const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
    ["tabs_list", {}, "list_tabs", {}],
    ["tab_open", { url: "https://example.org", active: false }, "open_tab", { url: "https://example.org", active: false }],
    ["tab_open", { url: "https://example.org" }, "open_tab", { url: "https://example.org" }],
    ["tab_select", { tab: 7 }, "select_tab", { tabId: 7 }],
    ["tab_close", { tab: 7 }, "close_tab", { tabId: 7 }],
    ["dom_snapshot", { tab: 3 }, "snapshot", { tabId: 3 }],
    ["dom_click", { tab: 3, ref: "s5" }, "click", { tabId: 3, ref: "s5" }],
    ["dom_type", { tab: 3, ref: "s5", text: "hello" }, "type", { tabId: 3, ref: "s5", text: "hello" }],
    ["page_text", { tab: 3 }, "eval", { code: "document.body.innerText" }],
    ["eval_js", { tab: 3, code: "1 + 1" }, "eval", { code: "1 + 1" }],
    ["tab_screenshot", { tab: 3 }, "screenshot", { tabId: 3 }],
    ["console_logs", { tab: 3 }, "console_logs", { tabId: 3 }],
  ];

  it.each(cases)("%s maps to %s with the right params", async (tool, args, command, params) => {
    const send = vi.fn().mockResolvedValue({});
    const result = await runBrowserTool(
      BROWSER_TOOLS.find((t) => t.name === tool)!,
      args,
      { send }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(command, params);
    expect(result.isError).toBeFalsy();
  });

  it("tabs_list formats the tab list", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "tabs_list")!;
    const result = await runBrowserTool(def, {}, {
      send: async () => [
        { id: 1, title: "Example", url: "https://example.org", active: true },
        { id: 2, title: "Other", url: "https://other.org", active: false },
      ],
    });
    expect(result.content[0].text).toContain("1 * Example");
    expect(result.content[0].text).toContain("https://other.org");
  });

  it("dom_snapshot returns the YAML verbatim", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "dom_snapshot")!;
    const result = await runBrowserTool(def, { tab: 1 }, {
      send: async () => ({ yaml: '- document "X":\n  - button "Go" [ref=s1]' }),
    });
    expect(result.content[0].text).toBe('- document "X":\n  - button "Go" [ref=s1]');
  });
});

// ---------------------------------------------------------------------------
// Not connected
// ---------------------------------------------------------------------------

describe("browser MCP when the bridge is not connected", () => {
  it("returns the start-Chrome error as a tool error, end to end through MCP", async () => {
    const client = await connectedPair(new BridgeClient("ws://127.0.0.1:1", failingSocketFactory()));
    const res = (await client.callTool({ name: "tabs_list", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(NOT_CONNECTED_MESSAGE);
  });

  it("bridge errors surface as tool errors with the bridge message", async () => {
    const def = BROWSER_TOOLS.find((t) => t.name === "dom_click")!;
    const result = await runBrowserTool(def, { tab: 1, ref: "s99" }, {
      send: async () => {
        throw new Error("unknown ref s99 — take a new snapshot");
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown ref s99");
  });
});

// ---------------------------------------------------------------------------
// Request id correlation
// ---------------------------------------------------------------------------

describe("BridgeClient request id correlation", () => {
  it("correlates replies by id, even out of order", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const client = new BridgeClient("ws://127.0.0.1:8756", factory);
    const p1 = client.send("list_tabs");
    const p2 = client.send("screenshot", { tabId: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const sock = sockets[0];
    expect(sock.sent).toHaveLength(2);
    const f1 = JSON.parse(sock.sent[0]);
    const f2 = JSON.parse(sock.sent[1]);
    expect(f1.command).toBe("list_tabs");
    expect(f2.command).toBe("screenshot");
    expect(f2.id).toBe(f1.id + 1); // monotonic ids
    // reply out of order
    sock.reply(JSON.stringify({ id: f2.id, ok: true, result: "png-first" }));
    sock.reply(JSON.stringify({ id: f1.id, ok: true, result: ["tab"] }));
    expect(await p2).toBe("png-first");
    expect(await p1).toEqual(["tab"]);
  });

  it("rejects a not-ok reply with the bridge error", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const client = new BridgeClient("ws://127.0.0.1:8756", factory);
    const p = client.send("click", { tabId: 1, ref: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    const id = JSON.parse(sockets[0].sent[0]).id;
    sockets[0].reply(JSON.stringify({ id, ok: false, error: "unknown ref s1 — take a new snapshot" }));
    await expect(p).rejects.toThrow("unknown ref s1");
  });
});
