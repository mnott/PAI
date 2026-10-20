/**
 * pool-spares.test.ts — spares: pre-started, task-less workers, one task each.
 * The pool host against a fake claude process and a real temp git repo:
 * a spare per key, a claim binding id/branch/session and feeding the task as
 * the first turn, misses falling back with their reason, the replacement after
 * the task, idle retirement, and the setup/first-answer timing on the ledger.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import { recentWarmKeys, spareStats, type PoolTaskRequest, type SlotProcess } from "./pool.js";
import { defaultWorkersConfig, type WorkerProvider, type WorkersConfig } from "./config.js";
import { ledgerPath, statusPath } from "./paths.js";
import { parseLedger } from "./ledger.js";
import { git } from "./worktree.js";
import { tryPoolRun } from "./run.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const provider: WorkerProvider = {
  enabled: true,
  protocol: "anthropic",
  baseUrl: "https://example.invalid",
  keyFile: null,
  models: { default: "m1" },
  env: {},
};

const config = (pool: Record<string, unknown> = {}): WorkersConfig => ({
  ...defaultWorkersConfig(),
  caveman: false,
  pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 0, native: true, spares: 1, idleKillSec: 1800, continuation: false, ...pool },
  providers: { fakeprov: provider },
});

const R_OK = ["R", "i=sp", "r=-", "t=Smoke+", "c=src/x changed it", "y=not run, smoke only", "z=nothing"].join("\n") + "\n";
const usage = { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 };

class FakeSpare implements SlotProcess {
  readonly pid = process.pid;
  readonly fed: string[] = [];
  killed = false;
  private lineCb: ((l: string) => void) | null = null;
  constructor() {
    queueMicrotask(() => this.emit({ type: "system", subtype: "init", session_id: "sess-spare", model: "m1" }));
  }
  private emit(o: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(o));
  }
  write(text: string): boolean {
    this.fed.push(String(JSON.parse(text).message?.content ?? ""));
    this.emit({ type: "assistant", message: { usage, content: [{ type: "text", text: "on it" }] } });
    this.emit({ type: "result", is_error: false, result: R_OK });
    return true;
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

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-spare-repo-"));
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

function makeHost(repo: string | null, pool: Record<string, unknown> = {}, now?: () => Date) {
  const logDir = mkdtempSync(join(tmpdir(), "pai-spare-host-"));
  const procs: FakeSpare[] = [];
  const cwds: string[] = [];
  const argvs: string[][] = [];
  const host = createPoolHost({
    config: config(pool),
    logDir,
    usageLogFile: join(logDir, "none.jsonl"),
    spawner: (argv, cwd) => {
      argvs.push(argv);
      cwds.push(cwd);
      const p = new FakeSpare();
      procs.push(p);
      return p;
    },
    envFor: () => ({}),
    cmdHead: () => ["fake-claude"],
    warmKeys: repo ? [{ provider: "fakeprov", model: "m1", cwd: repo }] : [],
    ...(now ? { now } : {}),
    noReaper: true,
  });
  live.push(host);
  return { host, logDir, procs, cwds, argvs };
}

const task = (repo: string, over: Partial<PoolTaskRequest> = {}): PoolTaskRequest => ({
  id: "w1",
  label: "first",
  prompt: "TASK ONE SPEC",
  provider: "fakeprov",
  model: "m1",
  cwd: repo,
  reportFormat: "ag2",
  outputFormat: "text",
  maxMinutes: null,
  trailer: "\nREPORT-FORMAT-END",
  worktree: true,
  spare: true,
  ...over,
});

const ledgerLines = (logDir: string) => parseLedger(readFileSync(ledgerPath(logDir), "utf8"));

describe("spares", () => {
  it("starts one task-less spare per warm key: its own worktree, a process, nothing fed", async () => {
    const repo = makeRepo();
    const h = makeHost(repo);
    await h.host.settle();
    const st = h.host.state();
    expect(st.spares).toHaveLength(1);
    expect(st.spares![0]).toMatchObject({ provider: "fakeprov", model: "m1", state: "ready", branch: expect.stringMatching(/^spare\//) });
    expect(existsSync(st.spares![0]!.dir)).toBe(true);
    expect(h.cwds).toEqual([st.spares![0]!.dir]);
    expect(h.procs[0]!.fed).toEqual([]);
    expect(h.argvs[0]!.join(" ")).toContain("started ahead of time");
  });

  it("a claim binds id, branch and session, and sends the task as the first turn", async () => {
    const repo = makeRepo();
    const h = makeHost(repo);
    await h.host.settle();
    const spare = h.host.state().spares![0]!;
    const r = await h.host.runTask(task(repo, { runStartedAt: Date.now() - 1500 }));
    expect(r.pooled).toBe(true);
    expect(r.rc).toBe(0);
    expect(h.procs[0]!.fed).toHaveLength(1);
    const first = h.procs[0]!.fed[0]!;
    expect(first).toContain("TASK ONE SPEC");
    expect(first).toContain("worker id w1");
    expect(first).not.toContain("NEW TASK");
    expect(first.trimEnd().endsWith("REPORT-FORMAT-END")).toBe(true);
    // the spare's branch became the worker's; the worktree is the spare's, kept for merge
    expect(git(repo, ["branch", "--list", "worker/w1"])).toContain("worker/w1");
    expect(git(repo, ["branch", "--list", "spare/*"])).not.toContain(spare.branch);
    const status = JSON.parse(readFileSync(statusPath(h.logDir, "w1"), "utf8"));
    expect(status).toMatchObject({ state: "done", rc: 0, branch: "worker/w1", worktreeDir: spare.dir, claudeSession: "sess-spare" });
    expect(status.pool).toMatchObject({ spare: true, task: 1 });
    expect(existsSync(spare.dir)).toBe(true);
    expect(h.host.state().spareClaims).toBe(1);
  });

  it("records setupMs and firstAnswerMs on the ledger for a hit", async () => {
    const repo = makeRepo();
    const h = makeHost(repo);
    await h.host.settle();
    await h.host.runTask(task(repo, { runStartedAt: Date.now() - 1500 }));
    const lines = ledgerLines(h.logDir);
    const start = lines.find((l) => l.event === "WORKER-START" && l.fields.id === "w1")!;
    expect(start.fields.spare).toBe("hit");
    expect(Number(start.fields.setupMs)).toBeGreaterThanOrEqual(1500);
    const end = lines.find((l) => l.event === "WORKER-END" && l.fields.id === "w1")!;
    expect(end.fields.spare).toBe("hit");
    expect(Number(end.fields.setupMs)).toBeGreaterThanOrEqual(1500);
    expect(Number.isFinite(Number(end.fields.firstAnswerMs))).toBe(true);
    expect(spareStats(readFileSync(ledgerPath(h.logDir), "utf8")).hits).toBe(1);
  });

  it("a miss answers with its reason and starts a spare so the next claim hits", async () => {
    const repo = makeRepo();
    const h = makeHost(null);
    const miss = await h.host.runTask(task(repo));
    expect(miss).toEqual({ pooled: false, reason: "no-spare" });
    expect(h.procs.every((p) => p.fed.length === 0)).toBe(true); // nothing was fed anywhere
    expect(ledgerLines(h.logDir).some((l) => l.event === "WORKER-POOL-MISS" && l.fields.reason === "no-spare")).toBe(true);
    expect(h.host.state().spareMisses).toEqual({ "no-spare": 1 });
    await h.host.settle();
    const hit = await h.host.runTask(task(repo, { id: "w2" }));
    expect(hit.pooled).toBe(true);
  });

  it("misses on a moved HEAD, a dirty checkout, a task without a worktree and spares off", async () => {
    const repo = makeRepo();
    const h = makeHost(repo);
    await h.host.settle();
    writeFileSync(join(repo, "dirty.txt"), "x\n", "utf8");
    expect(await h.host.runTask(task(repo))).toEqual({ pooled: false, reason: "dirty" });
    expect(await h.host.runTask(task(repo, { worktree: false }))).toEqual({ pooled: false, reason: "no-worktree" });
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "moved"]);
    expect(await h.host.runTask(task(repo))).toEqual({ pooled: false, reason: "stale" });
    const off = makeHost(repo, { spares: 0 });
    expect(await off.host.runTask(task(repo))).toEqual({ pooled: false, reason: "spares-off" });
    expect(off.host.state().spares).toEqual([]);
  });

  it("starts a replacement spare when the task ends; the used process is killed", async () => {
    const repo = makeRepo();
    const h = makeHost(repo);
    await h.host.settle();
    const first = h.host.state().spares![0]!;
    await h.host.runTask(task(repo));
    await h.host.settle();
    expect(h.procs[0]!.killed).toBe(true);
    const after = h.host.state().spares!;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(first.id);
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.fed).toEqual([]);
  });

  it("retires a spare idle past idleKillSec: process killed, worktree removed", async () => {
    const repo = makeRepo();
    let t = Date.now();
    const h = makeHost(repo, { idleKillSec: 60 }, () => new Date(t));
    await h.host.settle();
    const spare = h.host.state().spares![0]!;
    t += 30_000;
    expect(h.host.reapSpares()).toBe(0);
    t += 31_000;
    expect(h.host.reapSpares()).toBe(1);
    expect(h.procs[0]!.killed).toBe(true);
    expect(existsSync(spare.dir)).toBe(false);
    expect(h.host.state().spares).toEqual([]);
  });
});

describe("spare helpers and the client", () => {
  it("recentWarmKeys keeps headless workers of the last hour, once per key", () => {
    const now = Date.parse("2026-10-20T14:00:00");
    const text = [
      "2026-10-20 13:50:00 WORKER-START id=a provider=glm mode=headless model=m cwd=/r label=x",
      "2026-10-20 13:55:00 WORKER-START id=b provider=glm mode=headless model=m cwd=/r label=y",
      "2026-10-20 12:00:00 WORKER-START id=c provider=old mode=headless model=m cwd=/r label=z",
      "2026-10-20 13:56:00 WORKER-START id=d provider=glm mode=interactive model=m cwd=/r label=z",
    ].join("\n");
    expect(recentWarmKeys(text, now)).toEqual([{ provider: "glm", model: "m", cwd: "/r" }]);
  });

  it("spareStats: mean setup saved is fresh-miss setup minus hit setup", () => {
    const text = [
      "2026-10-20 13:00:00 WORKER-END id=a spare=hit setupMs=800 firstAnswerMs=3000",
      "2026-10-20 13:01:00 WORKER-END id=b spare=miss spareMiss=no-spare setupMs=9000",
      "2026-10-20 13:01:00 WORKER-POOL-MISS id=b provider=glm reason=no-spare",
    ].join("\n");
    expect(spareStats(text)).toMatchObject({ hits: 1, misses: 1, missReasons: { "no-spare": 1 }, meanHitSetupMs: 800, meanMissSetupMs: 9000, meanSavedMs: 8200 });
  });

  it("client: an unreachable host is a recorded miss and a fresh spawn", async () => {
    const d = mkdtempSync(join(tmpdir(), "pai-spare-cl-"));
    const a = {
      config: { pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 1, spares: 1 } },
      logDir: d,
      quiet: true,
      id: "w-cl",
      label: "x",
      model: "m",
      cwd: tmpdir(),
      worktreeFlag: false,
      reportFormat: "ag2",
      noBrowser: true,
      runT0: Date.now(),
      target: { providerName: "glm", provider: { models: { default: "m" } } },
      parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
    } as never;
    expect(await tryPoolRun(a)).toBeNull();
    expect((a as { spareMiss?: string }).spareMiss).toBe("host-unreachable");
  });
});
