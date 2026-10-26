/**
 * executeUhpRun against a fake UHP server (no network beyond loopback): a
 * completed run, and a kill that cancels the response upstream and leaves the
 * worker status "killed".
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pane-handles.js", async (orig) => ({
  ...(await orig<typeof import("./pane-handles.js")>()),
  announcePane: vi.fn(async () => undefined),
  requireVisiblePane: vi.fn(async () => true),
}));
vi.mock("../pane.js", async (orig) => ({
  ...(await orig<typeof import("../pane.js")>()),
  resolveHostSession: vi.fn(async () => ({ term: "test-term" })),
}));

import { executeUhpRun, type UhpArgs } from "./execute-uhp.js";
import { loadStatus } from "../status.js";

let root: string;
let logDir: string;
let server: Server | undefined;
const exits: number[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "uhp-run-")));
  logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  exits.length = 0;
  vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
    exits.push(c ?? 0);
    return undefined as never;
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.removeAllListeners(sig);
  server?.closeAllConnections();
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const ev = (n: number, e: Record<string, unknown>) => `data: ${JSON.stringify({ sequence_number: n, ...e })}\n\n`;
const resp = (extra: Record<string, unknown> = {}) => ({ id: "resp_7", model: "m", metadata: { session_id: "sess_7" }, ...extra });

async function start(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function args(baseUrl: string): UhpArgs {
  return {
    config: { routing: {} },
    logDir,
    target: { providerName: "uhp-test", provider: { baseUrl, engine: "uhp", key: "k", models: {} }, via: "flag" },
    model: "m",
    label: "uhp-run",
    parsed: { headless: true, prompt: "do it", outputFormat: "text", allowedTools: [], mcp: [], rest: [], callerSystemPrompts: [] },
    claudeArgs: [],
    cwd: root,
    id: "w-uhp",
    quiet: true,
    reportFormat: "ag2",
    limit: null,
    noBrowser: false,
  } as unknown as UhpArgs;
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe("executeUhpRun", () => {
  it("a completed run lands done with the response and session ids", async () => {
    const url = await start((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        ev(0, { type: "response.created", response: resp({ status: "in_progress" }) }) +
          ev(1, { type: "response.output_text.done", text: "done it" }) +
          ev(2, { type: "response.completed", response: resp({ status: "completed" }) }),
      );
    });
    const rc = await executeUhpRun(args(url));
    expect(rc).toBe(0);
    const st = loadStatus(logDir, "w-uhp");
    expect(st?.state).toBe("done");
    expect(st?.uhpResponseId).toBe("resp_7");
    expect(st?.uhpSessionId).toBe("sess_7");
  });

  it("kill cancels the response upstream and the worker ends killed", async () => {
    const calls: string[] = [];
    const url = await start((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      req.resume();
      if (req.url === "/v1/responses") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(ev(0, { type: "response.created", response: resp({ status: "in_progress" }) }));
        // then hangs until the run is cancelled
      } else if (req.url === "/v1/responses/resp_7/cancel") {
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      } else res.writeHead(404).end();
    });
    const run = executeUhpRun(args(url));
    await waitFor(() => loadStatus(logDir, "w-uhp")?.uhpResponseId === "resp_7");
    process.emit("SIGTERM");
    await run;
    await waitFor(() => calls.includes("POST /v1/responses/resp_7/cancel"));
    expect(loadStatus(logDir, "w-uhp")?.state).toBe("killed");
    expect(exits).toContain(143);
  });
});
