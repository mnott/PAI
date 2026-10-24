/**
 * pool-auth-restart.test.ts — the pool host must not outlive its login or its build:
 * a changed credential retires the spares, a spare that dies on an auth error is retired
 * and its task retried once outside the pool, a newer build drains the host and restarts it.
 * Injected clock, credential stamps and fake spares over a real temp git repo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import { credentialChangeStamp, looksLikeAuthFailure, poolSettings, type PoolTaskRequest, type SlotProcess } from "./pool.js";
import { defaultWorkersConfig, type WorkersConfig } from "./config.js";
import { ledgerPath } from "./paths.js";
import { parseLedger } from "./ledger.js";
import { git } from "./worktree.js";

const config = (pool: Record<string, unknown> = {}): WorkersConfig => ({
  ...defaultWorkersConfig(),
  pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 0, native: true, spares: 1, idleKillSec: 1800, continuation: false, credWatchSec: 30, drainTimeoutSec: 120, ...pool },
  providers: { fakeprov: { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "m1" }, env: {} } },
});

const R_OK = ["R", "i=sp", "r=-", "t=Smoke+", "c=src/x changed it", "y=not run, smoke only", "z=nothing"].join("\n") + "\n";

class FakeSpare implements SlotProcess {
  readonly pid = process.pid;
  killed = false;
  hold = false;
  private held: (() => void) | null = null;
  private lineCb: ((l: string) => void) | null = null;
  constructor(private readonly failWith: string | null) {
    queueMicrotask(() => this.emit({ type: "system", subtype: "init", session_id: "sess-spare", model: "m1" }));
  }
  private emit(o: Record<string, unknown>): void {
    this.lineCb?.(JSON.stringify(o));
  }
  write(): boolean {
    const answer = (): void => {
      if (this.failWith) this.emit({ type: "result", is_error: true, result: this.failWith });
      else {
        this.emit({ type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "on it" }] } });
        this.emit({ type: "result", is_error: false, result: R_OK });
      }
    };
    if (this.hold) this.held = answer;
    else answer();
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

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-auth-repo-"));
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

interface HostOpts {
  failFirst?: string;
  stamp?: { v: string | null };
  clock?: { t: number };
  mtime?: { v: number };
  reexec?: () => Promise<boolean>;
  retryFresh?: Parameters<typeof createPoolHost>[0] extends infer O ? (O extends { retryFresh?: infer F } ? F : never) : never;
  hold?: boolean;
}

function makeHost(repo: string, o: HostOpts = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pai-auth-host-"));
  const procs: FakeSpare[] = [];
  const host = createPoolHost({
    config: config(),
    logDir,
    usageLogFile: join(logDir, "none.jsonl"),
    spawner: () => {
      const p = new FakeSpare(procs.length === 0 ? (o.failFirst ?? null) : null);
      p.hold = o.hold === true && procs.length === 0;
      procs.push(p);
      return p;
    },
    envFor: () => ({}),
    cmdHead: () => ["fake-claude"],
    warmKeys: [{ provider: "fakeprov", model: "m1", cwd: repo }],
    ...(o.stamp ? { credStamp: () => o.stamp!.v } : {}),
    ...(o.clock ? { now: () => new Date(o.clock!.t) } : {}),
    ...(o.mtime ? { bundlePath: "/bundle/host.mjs", fileMtime: () => o.mtime!.v, reexec: o.reexec, bundleStableMs: 0 } : {}),
    ...(o.retryFresh ? { retryFresh: o.retryFresh } : {}),
    noReaper: true,
  });
  live.push(host);
  return { host, logDir, procs };
}

const task = (repo: string, over: Partial<PoolTaskRequest> = {}): PoolTaskRequest => ({
  id: "w1", label: "first", prompt: "TASK ONE SPEC", provider: "fakeprov", model: "m1", cwd: repo,
  reportFormat: "ag2", outputFormat: "text", maxMinutes: null, trailer: "", worktree: true, spare: true, ...over,
});
const ledger = (logDir: string) => parseLedger(readFileSync(ledgerPath(logDir), "utf8"));

describe("credential change retires spares", () => {
  it("an unchanged stamp keeps the spare; a changed one kills it and starts a replacement", async () => {
    const repo = makeRepo();
    const stamp = { v: "keychain:A" as string | null };
    const h = makeHost(repo, { stamp });
    await h.host.settle();
    expect(h.procs).toHaveLength(1);
    expect(h.host.checkCredentials()).toBe(false); // baseline
    expect(h.host.checkCredentials()).toBe(false);
    expect(h.procs[0]!.killed).toBe(false);
    stamp.v = "keychain:B";
    expect(h.host.checkCredentials()).toBe(true);
    await h.host.settle();
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.procs).toHaveLength(2);
    expect(h.procs[1]!.killed).toBe(false);
    const st = h.host.state().spares!;
    expect(st).toHaveLength(1);
    expect(ledger(h.logDir).some((l) => l.event === "POOL-HOST-CRED-CHANGE")).toBe(true);
    expect(h.host.checkCredentials()).toBe(false); // the new stamp is the baseline now
  });

  it("a claimed spare finishes its task untouched; the replacement started at the claim is retired and replaced", async () => {
    const repo = makeRepo();
    const stamp = { v: "A" as string | null };
    const h = makeHost(repo, { stamp, hold: true });
    await h.host.settle();
    h.host.checkCredentials();
    const run = h.host.runTask(task(repo));
    for (let i = 0; i < 100 && !h.host.state().spareClaims; i++) await new Promise((r) => setTimeout(r, 10));
    stamp.v = "B";
    h.host.checkCredentials();
    expect(h.procs[0]!.killed).toBe(false); // busy: left to finish
    h.procs[0]!.release();
    const r = await run;
    expect(r.pooled).toBe(true);
    expect(r.rc).toBe(0);
    await h.host.settle();
    const ready = h.host.state().spares!.filter((s) => s.state === "ready");
    expect(ready.length).toBeGreaterThan(0);
    // the replacement started at the claim held the old login: retired; the one after it is live
    expect(h.procs[1]!.killed).toBe(true);
    expect(h.procs[h.procs.length - 1]!.killed).toBe(false);
  });

  it("credentialChangeStamp reads the keychain mdat and the credentials file mtime", () => {
    const home = mkdtempSync(join(tmpdir(), "pai-cred-home-"));
    const run = vi.fn(() => 'keychain: "x"\nattributes:\n    "mdat"<timedate>=0x32 "20261024054300Z\\000"\n    "mdat"="2026-10-24 05:43:00"\n');
    expect(credentialChangeStamp(home, "someone", run)).toBe("keychain:2026-10-24 05:43:00");
    expect(run).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", "someone", "-g"]);
    mkdirSyncP(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    expect(credentialChangeStamp(home, "someone", run)).toMatch(/^keychain:2026-10-24 05:43:00\|file:\d+/);
    expect(credentialChangeStamp(home, "", () => { throw new Error("no security"); })).toMatch(/^file:/);
    expect(credentialChangeStamp(mkdtempSync(join(tmpdir(), "pai-cred-empty-")), "u", () => { throw new Error("none"); })).toBeNull();
  });

  it("settings carry the defaults", () => {
    expect(poolSettings(defaultWorkersConfig())).toMatchObject({ credWatchSec: 30, drainTimeoutSec: 120 });
  });
});

import { mkdirSync } from "node:fs";
const mkdirSyncP = (p: string): void => void mkdirSync(p, { recursive: true });

describe("auth failure on a spare", () => {
  it("recognises the login-gone messages", () => {
    for (const t of ["Failed to authenticate: OAuth session expired and could not be refreshed", "Not logged in", "OAuth session expired"]) expect(looksLikeAuthFailure(t)).toBe(true);
    expect(looksLikeAuthFailure("tests failed")).toBe(false);
    expect(looksLikeAuthFailure(null)).toBe(false);
  });

  it("retires the spare, records it, starts a fresh one and hands the task back to a fresh spawn", async () => {
    const repo = makeRepo();
    const h = makeHost(repo, { failFirst: "Failed to authenticate: OAuth session expired and could not be refreshed" });
    await h.host.settle();
    const r = await h.host.runTask(task(repo));
    await h.host.settle();
    expect(r).toEqual({ pooled: false, reason: "auth-retry" });
    expect(h.procs[0]!.killed).toBe(true);
    expect(h.procs.length).toBeGreaterThanOrEqual(2);
    expect(ledger(h.logDir).some((l) => l.event === "WORKER-POOL-AUTH-RETRY")).toBe(true);
    // the failed attempt left no branch behind, so the fresh spawn can take the id
    expect(git(repo, ["branch", "--list", "worker/w1"]).trim()).toBe("");
  });

  it("with retryFresh the task is retried exactly once outside the pool and its answer returned", async () => {
    const repo = makeRepo();
    const retryFresh = vi.fn(async (_t: PoolTaskRequest) => ({ pooled: true, rc: 0 }));
    const h = makeHost(repo, { failFirst: "Not logged in", retryFresh });
    await h.host.settle();
    const r = await h.host.runTask(task(repo));
    expect(retryFresh).toHaveBeenCalledTimes(1);
    expect(retryFresh.mock.calls[0]![0]).toMatchObject({ id: "w1", spare: false });
    expect(r).toEqual({ pooled: true, rc: 0 });
  });

  it("a plain task failure is not an auth failure: the spare serves it and the answer stands", async () => {
    const repo = makeRepo();
    const h = makeHost(repo, { failFirst: "tests failed" });
    await h.host.settle();
    const r = await h.host.runTask(task(repo));
    expect(r.pooled).toBe(true);
    expect(r.rc).toBe(1);
  });
});

describe("stale build drains and restarts", () => {
  it("stops handing out work while a task runs, restarts after it ends, and logs the drain", async () => {
    const repo = makeRepo();
    const mtime = { v: 1000 };
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const reexec = vi.fn(async () => true);
    const h = makeHost(repo, { mtime, clock, reexec, hold: true });
    await h.host.settle();
    const run = h.host.runTask(task(repo));
    for (let i = 0; i < 100 && !h.host.state().spareClaims; i++) await new Promise((r) => setTimeout(r, 10));
    mtime.v = 2000;
    expect(await h.host.checkReload()).toBe(false);
    expect(reexec).not.toHaveBeenCalled();
    // draining: new work is refused so the client spawns fresh
    expect(await h.host.runTask(task(repo, { id: "w2" }))).toEqual({ pooled: false, reason: "busy" });
    h.procs[0]!.release();
    await run;
    expect(await h.host.checkReload()).toBe(true);
    expect(reexec).toHaveBeenCalledTimes(1);
    expect(ledger(h.logDir).filter((l) => l.event === "POOL-HOST-DRAIN").length).toBe(1);
  });

  it("restarts anyway once the drain timeout has passed with a task still running", async () => {
    const repo = makeRepo();
    const mtime = { v: 1000 };
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const reexec = vi.fn(async () => true);
    const h = makeHost(repo, { mtime, clock, reexec, hold: true });
    await h.host.settle();
    void h.host.runTask(task(repo));
    for (let i = 0; i < 100 && !h.host.state().spareClaims; i++) await new Promise((r) => setTimeout(r, 10));
    mtime.v = 2000;
    expect(await h.host.checkReload()).toBe(false);
    clock.t += 119_000;
    expect(await h.host.checkReload()).toBe(false);
    clock.t += 2_000;
    expect(await h.host.checkReload()).toBe(true);
    expect(reexec).toHaveBeenCalledTimes(1);
    const notes = ledger(h.logDir).filter((l) => l.event === "POOL-HOST-DRAIN");
    expect(notes.length).toBe(2);
  });
});
