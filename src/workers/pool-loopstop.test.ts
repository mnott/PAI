/**
 * pool-loopstop.test.ts — a pooled run the loop guard stopped ends like a fresh
 * run: the loop-stop report (r=- or r=~ with commits), and under prefer-local the
 * local no-commit failure re-runs once on the cloud while committed work is kept.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoolHost, type PoolHost } from "./pool-host.js";
import type { PoolTaskRequest, SlotProcess } from "./pool.js";
import { defaultWorkersConfig, type WorkerProvider, type WorkersConfig } from "./config.js";
import { loopStopMarkerPath } from "./loop-stop.js";
import { git } from "./worktree.js";
import { ledgerPath } from "./paths.js";
import { loadStatus } from "./status.js";
import { tryPoolRun } from "./run.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});

const provider: WorkerProvider = { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "m1" }, env: {} };
const config = (): WorkersConfig => ({
  ...defaultWorkersConfig(),
  caveman: false,
  pool: { enabled: true, maxSlots: 1, idleSecs: 0, port: 0, native: true, spares: 1, idleKillSec: 1800, continuation: false },
  providers: { fakeprov: provider },
});

/** A spare the loop guard kills as soon as it gets the task; optionally after a commit in its worktree. */
class StoppedSpare implements SlotProcess {
  readonly pid = process.pid;
  private lineCb: ((l: string) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  constructor(private readonly dir: string, private readonly logDir: string, private readonly commit: boolean) {
    queueMicrotask(() => this.lineCb?.(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stop", model: "m1" })));
  }
  write(): boolean {
    if (this.commit) {
      writeFileSync(join(this.dir, "work.txt"), "work\n", "utf8");
      git(this.dir, ["add", "."]);
      git(this.dir, ["commit", "-q", "-m", "work"]);
    }
    const id = "w-loop";
    writeFileSync(loopStopMarkerPath(this.logDir, id), JSON.stringify({ ts: "", reason: "Bash repeated 7 times without a change" }));
    queueMicrotask(() => this.exitCb?.(143));
    return true;
  }
  kill(): boolean {
    return true;
  }
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb;
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-loopstop-repo-"));
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

async function stoppedRun(commit: boolean) {
  const repo = makeRepo();
  const logDir = mkdtempSync(join(tmpdir(), "pai-loopstop-host-"));
  const host = createPoolHost({
    config: config(),
    logDir,
    usageLogFile: join(logDir, "none.jsonl"),
    spawner: (_argv, cwd) => new StoppedSpare(cwd, logDir, commit),
    envFor: () => ({}),
    cmdHead: () => ["fake-claude"],
    warmKeys: [{ provider: "fakeprov", model: "m1", cwd: repo }],
    noReaper: true,
  });
  live.push(host);
  await host.settle();
  const req: PoolTaskRequest = {
    id: "w-loop", label: "loopy", prompt: "SPEC", provider: "fakeprov", model: "m1", cwd: repo,
    reportFormat: "ag2", outputFormat: "text", maxMinutes: null, trailer: "", worktree: true, spare: true,
  };
  const r = await host.runTask(req);
  return { r, logDir };
}

describe("a pooled run stopped by the loop guard", () => {
  it("without commits ends with the loop-stop report", async () => {
    const { r } = await stoppedRun(false);
    expect(r.pooled).toBe(true);
    expect(r.rc).toBe(1);
    expect(r.report).toMatchObject({ result: "-", why: "loop-stopped: Bash repeated 7 times without a change" });
    expect(r.status).toMatchObject({ state: "failed", loopStopped: true, endReason: "loop-stopped" });
    expect(r.status?.last).toMatch(/^loop-stopped:/);
  });

  it("with commits ends with r=~ and the commit list", async () => {
    const { r } = await stoppedRun(true);
    expect(r.report?.result).toBe("~");
    expect(r.report?.notes).toMatch(/loop-stopped after committing[\s\S]*commits: .*work/);
    expect(r.status?.loopStopped).toBe(true);
  });
});

describe("the pool client after a stopped pooled run (prefer-local)", () => {
  const servers: Server[] = [];
  beforeEach(() => {
    for (const k of ["PAI_WORKER", "PAI_WORKER_PROVIDER", "PAI_SESSION_PROVIDER", "PAI_WORKER_AUTOPANE", "PAI_WORKER_ALLOW_HIDDEN"]) vi.stubEnv(k, undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const s of servers.splice(0)) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  const run = async (reply: object) => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const logDir = mkdtempSync(join(tmpdir(), "pai-loopstop-client-"));
    const runner = vi.fn().mockResolvedValue(0);
    const a = {
      config: { pool: { enabled: true, maxSlots: 1, idleSecs: 0, port, continuation: true }, capacity: { enabled: true }, pane: { enabled: true } },
      logDir, quiet: true, id: "w-loop", label: "x", model: "m", cwd: tmpdir(), noPane: true, worktreeFlag: false, reportFormat: "ag2", noBrowser: true, noStagger: true,
      route: { policy: "prefer-local", reason: "local", local: true },
      runner,
      target: { providerName: "loc", provider: { models: { default: "m" }, maxConcurrent: 1 } },
      parsed: { headless: true, prompt: "hi", callerSystemPrompt: false, callerMcpConfig: false, mcp: [], allowedTools: [], outputFormat: "json" },
    };
    const rc = await tryPoolRun(a as never);
    return { rc, runner, logDir };
  };

  const failed = { id: "w-loop", state: "failed", rc: 1, loopStopped: true, last: "loop-stopped: x", label: "x" };

  it("no commits: re-runs fresh on the cloud, not as another pooled run", async () => {
    const { rc, runner, logDir } = await run({
      pooled: true, rc: 1, resultEvent: null, report: { result: "-", why: "loop-stopped: x", notes: "loop-stopped: x" }, status: failed,
    });
    expect(rc).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toMatchObject({ providerFlag: "anthropic", _fallThroughOf: "w-loop", _route: { local: false } });
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-FALLTHROUGH id=w-loop reason=r=-/);
  });

  it("with commits: kept for review as r=~, no re-run", async () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "work.txt"), "w\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "work"]);
    const { rc, runner, logDir } = await run({
      pooled: true, rc: 1, resultEvent: null, report: { result: "-", why: "loop-stopped: x" },
      status: { ...failed, worktreeDir: repo, worktreeBase: base },
    });
    expect(rc).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-FALLTHROUGH-REVIEW id=w-loop/);
    void loadStatus;
  });
});
