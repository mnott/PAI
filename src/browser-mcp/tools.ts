/**
 * pai-browser MCP tool table.
 *
 * One definition per tool: MCP-facing name/schema, the wire command it maps
 * to on the browser bridge, param translation, and result formatting. Kept as
 * a data table so tests can drive every mapping without a transport, and so
 * registerBrowserTools stays a five-line loop.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotConnectedError } from "./bridge-client.js";

export interface BridgeLike {
  send(command: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface BrowserToolDef {
  name: string;
  description: string;
  /** zod raw shape for server.tool() */
  shape: z.ZodRawShape;
  /** wire command the extension handles */
  command: string;
  /** MCP args → wire params */
  toParams: (args: Record<string, unknown>) => Record<string, unknown>;
  /** wire result → text shown to the model */
  format?: (result: unknown) => string;
}

const tabSchema = z.number().int().describe("Tab id, as returned by tabs_list.");

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Result formatters
// ---------------------------------------------------------------------------

function formatTabs(result: unknown): string {
  const tabs = (Array.isArray(result) ? result : asRecord(result).tabs) as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(tabs) || tabs.length === 0) return "(no open tabs)";
  return tabs
    .map(
      (t) =>
        `${t.id}${t.active ? " *" : "  "} ${String(t.title ?? "")}\n     ${String(t.url ?? "")}`
    )
    .join("\n");
}

function formatSnapshot(result: unknown): string {
  return String(asRecord(result).yaml ?? "");
}

function formatLogs(result: unknown): string {
  const entries = asRecord(result).entries as Array<Record<string, unknown>>;
  if (!Array.isArray(entries) || entries.length === 0) return "(no console output captured)";
  return entries
    .map((e) => {
      const kind = e.source === "console" ? String(e.type ?? "log") : String(e.level ?? "log");
      return `[${kind}] ${String(e.text ?? "")}`;
    })
    .join("\n");
}

function formatEval(result: unknown): string {
  const value = asRecord(result).value;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatScreenshot(result: unknown): string {
  // Raw base64 PNG — the tool contract is "base64 png", not prose.
  return String(asRecord(result).base64 ?? "");
}

// ---------------------------------------------------------------------------
// Tool table: MCP name → wire command
// ---------------------------------------------------------------------------

export const BROWSER_TOOLS: BrowserToolDef[] = [
  {
    name: "tabs_list",
    description: "List the tabs of the user's real running Chrome (id, title, url, active).",
    shape: {},
    command: "list_tabs",
    toParams: () => ({}),
    format: formatTabs,
  },
  {
    name: "tab_open",
    description: "Open a new tab in the user's Chrome and return its tab id.",
    shape: {
      url: z.string().describe("URL to open."),
      active: z.boolean().optional().describe("Focus the new tab (default true)."),
    },
    command: "open_tab",
    toParams: (a) => ({ url: a.url, ...(a.active !== undefined ? { active: a.active } : {}) }),
  },
  {
    name: "tab_select",
    description: "Bring a tab to the front (activate it and focus its window).",
    shape: { tab: tabSchema },
    command: "select_tab",
    toParams: (a) => ({ tabId: a.tab }),
  },
  {
    name: "tab_close",
    description: "Close a tab.",
    shape: { tab: tabSchema },
    command: "close_tab",
    toParams: (a) => ({ tabId: a.tab }),
  },
  {
    name: "dom_snapshot",
    description:
      "Snapshot a tab's DOM as an accessibility-tree YAML with [ref=sN] ids for interactive elements. " +
      "Take a snapshot before dom_click/dom_type; refs stay valid until the next snapshot or navigation.",
    shape: { tab: tabSchema },
    command: "snapshot",
    toParams: (a) => ({ tabId: a.tab }),
    format: formatSnapshot,
  },
  {
    name: "dom_click",
    description: "Click an element by its [ref=sN] from the latest dom_snapshot (trusted CDP event).",
    shape: { tab: tabSchema, ref: z.string().describe("Ref id from dom_snapshot, e.g. s3.") },
    command: "click",
    toParams: (a) => ({ tabId: a.tab, ref: a.ref }),
  },
  {
    name: "dom_type",
    description:
      "Focus an element by its [ref=sN] and type text into it (inserts at the caret, works in SPAs).",
    shape: {
      tab: tabSchema,
      ref: z.string().describe("Ref id from dom_snapshot, e.g. s5."),
      text: z.string().describe("Text to type."),
    },
    command: "type",
    toParams: (a) => ({ tabId: a.tab, ref: a.ref, text: a.text }),
  },
  {
    name: "page_text",
    description: "Read a tab's visible text (document.body.innerText).",
    shape: { tab: tabSchema },
    command: "eval",
    toParams: () => ({ code: "document.body.innerText" }),
    format: formatEval,
  },
  {
    name: "eval_js",
    description: "Evaluate JavaScript in a tab and return the JSON-safe result. Awaits promises.",
    shape: {
      tab: tabSchema,
      code: z.string().describe("JavaScript expression to evaluate."),
    },
    command: "eval",
    toParams: (a) => ({ code: a.code }),
    format: formatEval,
  },
  {
    name: "tab_screenshot",
    description: "Screenshot a tab (PNG, base64).",
    shape: { tab: tabSchema },
    command: "screenshot",
    toParams: (a) => ({ tabId: a.tab }),
    format: formatScreenshot,
  },
  {
    name: "console_logs",
    description: "Read the console output captured for a tab while the bridge debugger was attached.",
    shape: { tab: tabSchema },
    command: "console_logs",
    toParams: (a) => ({ tabId: a.tab }),
    format: formatLogs,
  },
];

/** Runs one tool against the bridge; returns MCP content + isError. */
export async function runBrowserTool(
  def: BrowserToolDef,
  args: Record<string, unknown>,
  bridge: BridgeLike
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await bridge.send(def.command, def.toParams(args));
    return { content: [{ type: "text", text: def.format ? def.format(result) : JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const msg =
      e instanceof NotConnectedError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/** Registers every browser tool on an MCP server. */
export function registerBrowserTools(server: McpServer, bridge: BridgeLike): void {
  for (const def of BROWSER_TOOLS) {
    server.tool(def.name, def.description, def.shape, (args) => runBrowserTool(def, args, bridge));
  }
}
