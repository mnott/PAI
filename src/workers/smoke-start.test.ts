import { afterAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeStart, startStubServer, stubMessage } from "./smoke-start.js";
import { startDetachedWorker } from "./reroute.js";
import { readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";
import { saveStatus, type WorkerStatus } from "./status.js";

const stub = { serve: async () => ({ url: "http://127.0.0.1:1/v1", close: async () => {} }), addProvider: () => {}, removeProvider: () => {} };

/** A finished smoke run the result check can read (defaultStart waits for exactly this shape). */
function standInRun(logDir: string, id: string): void {
  saveStatus(
    logDir,
    { id, pid: process.pid, label: "merge gate smoke start", cwd: logDir, state: "done", started: "2026-11-19 00:00:00", rc: 0 } as WorkerStatus,
    new Date(),
    true
  );
  writeFileSync(join(logDir, `${id}.jsonl`), JSON.stringify({ type: "result", result: "ok", is_error: false }) + "\n");
}

describe("smokeStart", () => {
  it("a start that throws reads as a failure with the first error line", async () => {
    const r = await smokeStart({ cwd: "." }, { ...stub, start: async () => { throw new Error("Cannot access 'toolFold' before initialization\n at x"); } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Cannot access 'toolFold' before initialization");
  });

  it("a non-zero exit is a failure", async () => {
    const r = await smokeStart({ cwd: "." }, { ...stub, start: async () => ({ rc: 1, id: "nope" }) });
    expect(r).toMatchObject({ ok: false, error: "worker run exited 1" });
  });

  it("the smoke child runs with the at-start housekeeping off and no inherited worker identity", async () => {
    // the env defaultStart builds for the detached CLI (merge 2026-11-19 14:31: a throttled worktree gc archiving
    // 1000+ commits ran before the smoke worker announced, blew its 30 s start window and read as "worker did not
    // start"). runWorker gates its at-start gc pass on exactly this flag (src/workers/run/worker.ts).
    const logDir = workersLogDir(readWorkersSection().workers);
    let seen: NodeJS.ProcessEnv | undefined;
    const r = await smokeStart(
      { cwd: "." },
      {
        ...stub,
        env: { PAI_WORKER: "1", PAI_WORKER_ID: "w-old", PAI_WORKER_ORCHESTRATOR: "1", CLAUDE_CODE_SESSION_ID: "s", ITERM_SESSION_ID: "i", TMUX_PANE: "p", KEEP: "1" },
        start: async (o) => {
          seen = o.env;
          standInRun(logDir, o.id); // the run ends rc 0 with a valid result, as defaultStart's wait reads it
          return { rc: 0, id: o.id };
        },
      }
    );
    expect(r.ok).toBe(true);
    expect(seen?.PAI_NO_WORKTREE_GC).toBe("1"); // the flag reaches the smoke child's env prep
    for (const k of ["PAI_WORKER", "PAI_WORKER_ID", "PAI_WORKER_ORCHESTRATOR", "CLAUDE_CODE_SESSION_ID", "ITERM_SESSION_ID", "TMUX_PANE"]) expect(seen?.[k]).toBeUndefined();
    expect(seen?.KEEP).toBe("1"); // the caller's other env still rides along
  });

  it("a housekeeping pass stubbed slow is not on the smoke's start path: ok, well under its window", async () => {
    // "housekeeping stubbed slow": a gc pass that sleeps 45 s — past the smoke's 30 s window. It runs inline before
    // the worker announces (the old start path's shape) and skips itself exactly where runWorker skips it: on the
    // flag. With the smoke env set the pass is never waited for, so the wait only measures the worker's own end.
    const logDir = workersLogDir(readWorkersSection().workers);
    let seen: NodeJS.ProcessEnv | undefined;
    const t0 = Date.now();
    const r = await smokeStart(
      { cwd: ".", timeoutMs: 30_000 },
      {
        ...stub,
        env: process.env,
        start: async (o) => {
          seen = o.env;
          if (o.env?.PAI_NO_WORKTREE_GC !== "1") spawnSync("/bin/sh", ["-c", "sleep 45"], { timeout: 50_000 }); // a 1000+ commit archive pass
          standInRun(logDir, o.id);
          return { rc: 0, id: o.id };
        },
      }
    );
    expect(seen?.PAI_NO_WORKTREE_GC).toBe("1");
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000); // the 45 s housekeeping never stands between the smoke and its start
  }, 60_000);

});

// The false failure of merge 2026-11-19 14:31, reproduced at the wait that made it: a worker start whose inline
// housekeeping outlives the window never announces in time and the wait throws "worker did not start within Ns".
describe("a slow start against the smoke's window", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a start slower than its window throws did-not-start-within (what the gc pass did to the smoke)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-window-"));
    dirs.push(dir);
    // a worker start that does its housekeeping first and announces only after — never inside the window.
    // The injected spawn stands in for the CLI process; the waiting itself is the real startDetachedWorker loop.
    const slowSpawn = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      void bin; void args; void o;
      const child = spawn("/bin/sh", ["-c", "sleep 10"], { detached: true, stdio: "ignore" }); // alive, silent: no announce ever
      child.unref();
      return child.pid ?? process.pid;
    }) as typeof import("./reroute.js").spawnSession;
    const t0 = Date.now();
    await expect(startDetachedWorker(join(dir, "logs"), ["--print-id"], { cwd: dir, env: {}, timeoutMs: 2_000, start: slowSpawn })).rejects.toThrow(/did not start within/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
  }, 30_000);

  it("a start that announces inside its window is ok even when the run itself ends late (housekeeping off)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-window-ok-"));
    dirs.push(dir);
    // with PAI_NO_WORKTREE_GC=1 the start path skips housekeeping: announce at once, end later
    const fastSpawn = ((bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; outPath: string }) => {
      void bin; void args;
      expect(o.env.PAI_NO_WORKTREE_GC).toBe("1"); // the smoke's env crossed into the spawned child's env
      writeFileSync(o.env.PAI_WORKER_ID_FILE!, '{"id":"w-1","state":"running"}');
      return process.pid; // alive; the run would finish after the window, like a real worker
    }) as typeof import("./reroute.js").spawnSession;
    const t0 = Date.now();
    const id = await startDetachedWorker(join(dir, "logs"), ["--print-id"], { cwd: dir, env: { PAI_NO_WORKTREE_GC: "1" }, timeoutMs: 2_000, start: fastSpawn });
    expect(id).toContain("w-1"); // announced inside the window: the smoke reads its end, never times out
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 30_000);
});

describe("smoke run never falls through or escalates", () => {
  it("an invalid report on the smoke label gives no fall-through reason (a normal local run does)", async () => {
    const { fallThroughReason } = await import("./policy.js");
    const route = { policy: "auto", reason: "x", local: true } as never;
    const st = { reportValid: false, rc: 0, state: "done" };
    expect(fallThroughReason(route, st, null, "merge gate smoke start", true)).toBeNull();
    expect(fallThroughReason(route, st, null, "other task", true)).toBe("invalid report");
  });

  it("the smoke label is the one the live start uses; the exit reason names state and first error line", async () => {
    const { SMOKE_LABEL, isSmokeLabel } = await import("../daemon/battery-guard.js");
    const { exitWhy } = await import("./smoke-start.js");
    expect(isSmokeLabel(SMOKE_LABEL)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "pai-exitwhy-"));
    writeFileSync(join(dir, "X.log"), "starting\nError: provider unreachable\nbye\n");
    expect(exitWhy(dir, "X", { state: "failed", endReason: "crash" })).toBe("state failed, reason crash, Error: provider unreachable");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("smoke stub server", () => {
  it("lists smoke-stub on /v1/models and answers /v1/messages (json and SSE) with a valid AG2 report", async () => {
    const srv = await startStubServer();
    try {
      const models = (await (await fetch(`${srv.url}/v1/models`)).json()) as { data: Array<{ id: string }> };
      expect(models.data.map((m) => m.id)).toEqual(["smoke-stub"]);
      const json = (await (await fetch(`${srv.url}/v1/messages?beta=true`, { method: "POST", body: JSON.stringify({ model: "smoke-stub" }) })).json()) as { content: Array<{ text: string }>; model: string };
      expect(json.model).toBe("smoke-stub");
      expect(json.content[0].text).toMatch(/^R\ni=smoke\nr=\?\n/);
      const sse = await (await fetch(`${srv.url}/v1/messages`, { method: "POST", body: JSON.stringify({ stream: true }) })).text();
      expect(sse).toContain("event: message_start");
      expect(sse).toContain("event: message_stop");
      expect((await fetch(`${srv.url}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      await srv.close();
    }
    expect(stubMessage({}).json).toContain("smoke-stub");
  });
});
