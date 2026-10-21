/**
 * pool-reload-inflight.test.ts — a new build on disk must not kill a task that a spare is serving.
 * (A claimed spare leaves the spare list and holds no slot: the reload guard used to see an idle host,
 * discarded the spares, closed every connection, and the pooled run ended "pool slot died mid-task".)
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import { postTaskToPool, poolReloadMarkerPath, reloadInProgress, writeReloadMarker, type PoolTaskRequest, type SlotProcess } from "./pool.js";
import { defaultWorkersConfig, type WorkersConfig } from "./config.js";
import { git } from "./worktree.js";

const R_OK = ["R", "i=sp", "r=-", "t=Smoke+", "c=src/x changed it", "y=not run, smoke only", "z=nothing"].join("\n") + "\n";
const usage = { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 };

class HeldSpare implements SlotProcess {
  readonly pid = process.pid;
  killed = false;
  private held: (() => void) | null = null;
  private lineCb: ((l: string) => void) | null = null;
  constructor() {
    queueMicrotask(() => this.emit({ type: "system", subtype: "init", session_id: "sess-spare", model: "m1" }));
  }
  private emit(o: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(o));
  }
  write(): boolean {
    this.held = () => {
      this.emit({ type: "assistant", message: { usage, content: [{ type: "text", text: "on it" }] } });
      this.emit({ type: "result", is_error: false, result: R_OK });
    };
    return true;
  }
  release(): void {
    this.held?.();
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(): void {}
}

const config = (): WorkersConfig => ({
  ...defaultWorkersConfig(),
  pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 0, native: true, spares: 1, idleKillSec: 1800, continuation: false },
  providers: { fakeprov: { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "m1" }, env: {} } },
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-reload-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

const live: PoolHost[] = [];
afterEach(async () => {
  while (live.length) {
    const h = live.pop()!;
    await h.settle();
    h.server.closeAllConnections?.();
    await h.shutdown();
  }
});

describe("a build change while a spare serves a task", () => {
  it("defers the reload until the task has ended, and the task completes", async () => {
    const repo = makeRepo();
    const logDir = mkdtempSync(join(tmpdir(), "pai-reload-host-"));
    const procs: HeldSpare[] = [];
    const mtime = { v: 1000 };
    const reexec = vi.fn(async () => true);
    const h = createPoolHost({
      config: config(),
      logDir,
      usageLogFile: join(logDir, "none.jsonl"),
      spawner: () => {
        const p = new HeldSpare();
        procs.push(p);
        return p;
      },
      envFor: () => ({}),
      cmdHead: () => ["fake-claude"],
      warmKeys: [{ provider: "fakeprov", model: "m1", cwd: repo }],
      bundlePath: "/bundle/worker-pool-host.mjs",
      fileMtime: () => mtime.v,
      reexec,
      bundleStableMs: 0,
      noReaper: true,
    });
    live.push(h);
    await h.settle();
    const req: PoolTaskRequest = { id: "w-inflight", label: "x", prompt: "SPEC", provider: "fakeprov", model: "m1", cwd: repo, reportFormat: "ag2", outputFormat: "text", maxMinutes: null, trailer: "", worktree: true, spare: true };
    const running = h.runTask(req);
    await vi.waitFor(() => expect(procs.some((p) => p["held"])).toBe(true));
    mtime.v = 2000; // the build lands while the task runs
    expect(await h.checkReload()).toBe(false);
    expect(reexec).not.toHaveBeenCalled();
    expect(procs.filter((p) => p.killed)).toHaveLength(0);
    procs.find((p) => p["held"])!.release();
    const res = await running;
    expect(res.pooled).toBe(true);
    expect(res.rc).toBe(0);
    await h.settle();
    expect(await h.checkReload()).toBe(true); // idle now: the reload goes ahead
    expect(reexec).toHaveBeenCalledTimes(1);
  });
});

describe("the reload handover", () => {
  it("marks itself while the replacement starts, and clears the mark afterwards", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-reload-mark-"));
    const mtime = { v: 1000 };
    let markedDuringReexec = false;
    const h = createPoolHost({
      config: { ...config(), pool: { ...config().pool!, spares: 0 } },
      logDir,
      usageLogFile: join(logDir, "none.jsonl"),
      spawner: () => new HeldSpare(),
      envFor: () => ({}),
      cmdHead: () => ["fake-claude"],
      bundlePath: "/bundle/worker-pool-host.mjs",
      fileMtime: () => mtime.v,
      reexec: async () => {
        markedDuringReexec = reloadInProgress(logDir);
        return true;
      },
      bundleStableMs: 0,
      noReaper: true,
    });
    live.push(h);
    mtime.v = 2000;
    expect(await h.checkReload()).toBe(true);
    expect(markedDuringReexec).toBe(true);
    expect(existsSync(poolReloadMarkerPath(logDir))).toBe(false);
  });

  it("a claim that finds the port closed mid-handover is retried and reaches the replacement", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-reload-retry-"));
    writeReloadMarker(logDir);
    // reserve a port, close it (the old host's listener is gone), and bring the replacement up on it shortly after
    const probe = createServer();
    const port = await new Promise<number>((r) => probe.listen(0, "127.0.0.1", () => r((probe.address() as { port: number }).port)));
    await new Promise<void>((r) => probe.close(() => r()));
    const replacement = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => res.end(JSON.stringify({ pooled: true, rc: 0 })));
    });
    setTimeout(() => replacement.listen(port, "127.0.0.1"), 700);
    const task = { id: "w-retry" } as PoolTaskRequest;
    const res = await postTaskToPool(port, task, 5000, "/claim", () => reloadInProgress(logDir));
    await new Promise<void>((r) => replacement.close(() => r()));
    expect(res).toMatchObject({ ok: { pooled: true, rc: 0 } });
  });

  it("without a handover a refused connection is a miss at once (no host)", async () => {
    const probe = createServer();
    const port = await new Promise<number>((r) => probe.listen(0, "127.0.0.1", () => r((probe.address() as { port: number }).port)));
    await new Promise<void>((r) => probe.close(() => r()));
    const t0 = Date.now();
    expect(await postTaskToPool(port, { id: "w-none" } as PoolTaskRequest, 5000, "/claim", () => false)).toMatchObject({ error: "unreachable" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
