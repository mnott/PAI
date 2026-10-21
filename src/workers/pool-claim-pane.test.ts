import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryPoolRun } from "./run.js";
import { paneHandles } from "./run/pane-handles.js";
import { loadStatus, nowStamp, saveStatus } from "./status.js";
import type { OwnedPane, StartSpec } from "./pane-exec.js";

// no real terminal: the pane rule is active (a terminal backend exists), the pane itself is a fake
vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }), paneBackend: vi.fn().mockReturnValue("iterm") };
});

const servers: Server[] = [];
beforeEach(() => {
  for (const k of ["PAI_WORKER", "PAI_WORKER_PROVIDER", "PAI_SESSION_PROVIDER", "PAI_WORKER_AUTOPANE", "PAI_WORKER_ALLOW_HIDDEN"]) vi.stubEnv(k, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  paneHandles.clear();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const fakePane = (id: string, started: StartSpec[]): OwnedPane => ({
  id,
  where: "fake",
  cancel: () => undefined,
  start: async (spec) => {
    started.push(spec);
    return { asChild: () => Object.assign(new EventEmitter(), { stderr: null }) } as never;
  },
});

const args = (logDir: string, port: number, id: string) =>
  ({
    config: { pool: { enabled: true, maxSlots: 1, idleSecs: 0, port, spares: 1 } },
    logDir,
    quiet: true,
    id,
    noPane: false,
    label: "x",
    model: "m",
    cwd: tmpdir(),
    worktreeFlag: false,
    reportFormat: "ag2",
    noBrowser: true,
    runT0: Date.now(),
    target: { providerName: "glm", provider: { models: { default: "m" } } },
    parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
  }) as never;

describe("a claimed spare under the pane rule", () => {
  it("is not skipped for the pane rule, and its pane follows the claimed run", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const started: StartSpec[] = [];
    paneHandles.set("w-pp", fakePane("w-pp", started));
    const port = await new Promise<number>((resolve) => {
      const server = createServer((req, res) => {
        req.on("data", () => undefined);
        req.on("end", () => {
          // the host binds the run to the spare: its status carries the pool block
          saveStatus(d, { id: "w-pp", pid: process.pid, label: "x", cwd: "/", term: "", provider: "glm", model: "m", state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "p", rc: null, secs: null, pool: { spare: true, task: 1, slotSession: null, hostPid: process.pid } });
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ pooled: true, rc: 0 }));
          }, 400);
        });
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const a = args(d, port, "w-pp");
    expect(await tryPoolRun(a)).toBe(0);
    expect((a as { spareMiss?: string }).spareMiss).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]!.argv.slice(-4)).toEqual(["worker", "follow", "w-pp", "--auto-exit"]);
    expect(started[0]!.stdin).toBe("ignore");
    expect(readFileSync(join(d, "ledger.log"), "utf8")).not.toContain("pane rule");
    void loadStatus;
  });

  it("a pane failure posts no task: skipped with reason 'pane failed'", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    let posted = 0;
    const port = await new Promise<number>((resolve) => {
      const server = createServer((req, res) => {
        posted++;
        req.on("data", () => undefined);
        req.on("end", () => res.end(JSON.stringify({ pooled: true, rc: 0 })));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const a = args(d, port, "w-pf") as { paneOpening?: Promise<void>; spareMiss?: string };
    a.paneOpening = Promise.reject(new Error("pane could not be opened: boom"));
    expect(await tryPoolRun(a as never)).toBeNull();
    expect(posted).toBe(0);
    expect(a.spareMiss).toBe("pane failed");
    const ledger = readFileSync(join(d, "ledger.log"), "utf8");
    expect(ledger).toContain("WORKER-POOL-SKIP");
    expect(ledger).toContain("pane failed");
  });

  it("the claim is posted only after the pane exists", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const order: string[] = [];
    const a = args(d, 0, "w-po") as { paneOpening?: Promise<void> };
    a.paneOpening = new Promise<void>((r) => setTimeout(() => { order.push("pane"); r(); }, 300));
    const port = await new Promise<number>((resolve) => {
      const server = createServer((req, res) => {
        order.push("claim");
        req.on("data", () => undefined);
        req.on("end", () => res.end(JSON.stringify({ pooled: false, reason: "no-spare" })));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    (a as never as { config: { pool: { port: number } } }).config.pool.port = port;
    await tryPoolRun(a as never);
    expect(order).toEqual(["pane", "claim"]);
  });

  it("a miss leaves the pane for the fresh spawn", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-ppane-"));
    const started: StartSpec[] = [];
    paneHandles.set("w-pm", fakePane("w-pm", started));
    const port = await new Promise<number>((resolve) => {
      const server = createServer((req, res) => {
        req.on("data", () => undefined);
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ pooled: false, reason: "no-spare" }));
        });
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const a = args(d, port, "w-pm");
    expect(await tryPoolRun(a)).toBeNull();
    expect((a as { spareMiss?: string }).spareMiss).toBe("no-spare");
    expect(started).toHaveLength(0);
    expect(paneHandles.has("w-pm")).toBe(true);
  });
});
