import { mkdtempSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateStart, tryPoolRun } from "./run.js";
import { loadStatuses, nowStamp, saveStatus } from "./status.js";

// the follow pane is opened before the pool post; keep these tests off the real terminal
vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
};

const args = (logDir: string, port: number, id: string) =>
  ({
    config: { pool: { enabled: true, maxSlots: 1, idleSecs: 0, port }, capacity: { enabled: true } },
    logDir,
    quiet: true,
    id,
    label: "x",
    model: "m",
    cwd: tmpdir(),
    worktreeFlag: false,
    reportFormat: "ag2",
    noBrowser: true,
    noStagger: true,
    target: { providerName: "loc", provider: { models: { default: "m" }, maxConcurrent: 1 } },
    parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
  }) as never;

describe("pooled runs pass the capacity gate", () => {
  it("cap 1: the second pooled run waits until the first finishes", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-pgate-"));
    const posted: string[] = [];
    const finish: Record<string, () => void> = {};
    const port = await listen((req, res) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c));
      req.on("end", () => {
        const id = JSON.parse(data).id as string;
        posted.push(id);
        // the pool host saves the pooled task's status under the slot pid
        const st = { id, pid: process.pid, label: "x", cwd: "/", term: "", provider: "loc", model: "m", state: "running" as const, started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "p", rc: null, secs: null };
        saveStatus(d, st);
        finish[id] = () => {
          saveStatus(d, { ...st, state: "done", rc: 0 });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ pooled: true, rc: 0 }));
        };
      });
    });
    const run = async (id: string) => {
      const a = args(d, port, id);
      await gateStart(a);
      return tryPoolRun(a);
    };
    const pa = run("w-a");
    await vi_waitFor(() => posted.includes("w-a"));
    const pb = run("w-b");
    await new Promise((r) => setTimeout(r, 1500));
    expect(posted).toEqual(["w-a"]);
    const queued = loadStatuses(d).find((s) => s.id === "w-b");
    expect(queued?.capacity?.cap).toBe(1);
    expect(queued?.last).toMatch(/^queued: /);
    finish["w-a"]();
    expect(await pa).toBe(0);
    await vi_waitFor(() => posted.includes("w-b"));
    expect(existsSync(join(d, "queue", "loc", "w-b"))).toBe(false);
    finish["w-b"]();
    expect(await pb).toBe(0);
  }, 20_000);

  it("a declined pool attempt was gated once and is not gated again", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-pgate-"));
    const port = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pooled: false, reason: "busy" }));
    });
    const a = args(d, port, "w-d") as { gated?: boolean };
    await gateStart(a as never);
    expect(a.gated).toBe(true);
    expect(await tryPoolRun(a as never)).toBeNull();
    // a second pass is a no-op: a blocker now would hang, so hold a slot and expect an instant return
    saveStatus(d, { id: "w-other", pid: process.pid, label: "x", cwd: "/", term: "", provider: "loc", model: "m", state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "p", rc: null, secs: null });
    await gateStart(a as never);
    expect(existsSync(join(d, "queue", "loc", "w-d"))).toBe(false);
  });
});

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
