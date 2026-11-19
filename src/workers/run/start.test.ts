/**
 * run/start.test.ts — a worker start through the REAL fold path (executeRun →
 * prepareRun → foldRun) against a mocked claude stream: every start-time line
 * runs for real — status seed, spawn, tool fold, the progress-budget snapshot
 * and armBudget. A temporal-dead-zone or any other throw at startup fails this
 * test; unit tests over the budget helpers alone never caught the
 * "Cannot access 'toolFold' before initialization" crash that broke every
 * worker start (2026-11-19, merge 2d9a628d).
 */
import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as childProcess from "node:child_process";
import { loadStatus, nowStamp, saveStatus, type WorkerStatus } from "../status.js";
import { parseRunnerArgs } from "../args.js";
import { DEFAULT_TIME_BUDGET } from "../time-budget.js";

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "start-fold-"));
  savedHome = process.env.PAI_HOME;
  process.env.PAI_HOME = join(dir, "home");
});
afterEach(() => {
  vi.doUnmock("node:child_process");
  if (savedHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

type FakeClaude = childProcess.ChildProcess & { stdinText: () => string };

// the mocked claude is a real node child (fake-claude.mjs): the run's own
// stdin/stdout/stderr pipes stay real, so the fold reads the scripted events
// and the end-of-run process reap behaves like production.
const FAKE = join(__dirname, "fake-claude.mjs");
function fakeClaude(events: unknown[], code = 0): FakeClaude {
  const child = realSpawn(process.execPath, [FAKE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_EVENTS: JSON.stringify(events), FAKE_EXIT: String(code) },
  }) as FakeClaude;
  let written = "";
  child.stdin!.on("data", (d: Buffer) => (written += d.toString())); // never consumed: a record of what the run wrote
  Object.assign(child, { stdinText: () => written });
  return child;
}

// a real claude model id: an unknown one trips the unrecognized-model detector and ends the run failed
const provider = { enabled: true, protocol: "anthropic", native: true, baseUrl: "", models: { default: "claude-sonnet-4-5" }, maxConcurrent: 4 };
// the gate reads these sections of the workers config; values mirror src/config/defaults/workers.yaml
const runConfig = {
  timeBudget: DEFAULT_TIME_BUDGET,
  panes: { required: false },
  stagger: { enabled: false, localDefaultSec: 0, remoteDefaultSec: 0, minSec: 0, maxSec: 0 },
  capacity: { enabled: false },
} as never;
const initEvent = { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5", cwd: "/tmp" };
const resultEvent = (text: string): Record<string, unknown> => ({ type: "result", result: text, is_error: false, num_turns: 1, duration_ms: 50 });

/** One headless run through the real executeRun with a mocked child process; returns its rc and the fake claude. */
async function startWorker(wid: string, events: unknown[], over: Record<string, unknown> = {}): Promise<{ rc: number; child: FakeClaude }> {
  const child = fakeClaude(events);
  vi.doMock("node:child_process", async (importOriginal) => {
    const orig = await importOriginal<typeof import("node:child_process")>();
    return { ...orig, spawn: vi.fn(() => child) };
  });
  vi.resetModules();
  const { executeRun } = await import("./execute.js");
  const claudeArgs = ["-p", "reply ok", "--output-format", "json"];
  const a = {
    config: runConfig,
    logDir: dir,
    target: { providerName: "testp", provider, modelAlias: null, classMcp: null, via: "flag" },
    model: "claude-sonnet-4-5",
    label: "start-test",
    parsed: parseRunnerArgs(claudeArgs),
    claudeArgs,
    reroutes: 0,
    reportFormat: "json",
    limit: null,
    budgetMin: 20, // the progress-based budget armed: snapBudget + armBudget run at start (the TDZ path)
    noBrowser: true,
    quiet: true,
    id: wid,
    opts: { claudeArgs },
    // no terminal in a test run: the pane gate takes its documented waiver path
    systemWaiver: "test" as never,
    ...over,
  } as never;
  const rc = await executeRun(a);
  return { rc, child };
}

describe("a worker start through the real fold path", () => {
  it("starts with the time budget armed and finishes done/rc 0 — no TDZ, no startup throw", async () => {
    const wid = "startok1";
    // a stale placeholder like gateStart writes: foldRun keeps its `started` stamp
    saveStatus(dir, { id: wid, pid: process.pid, runPid: process.pid, label: "start-test", cwd: dir, term: "", provider: "testp", model: "claude-sonnet-4-5", state: "running", started: nowStamp(), updated: nowStamp(), turns: 0, tools: 0, last: "starting", rc: null, secs: null, outputFormat: "json" } as WorkerStatus);
    const { rc, child } = await startWorker(wid, [initEvent, resultEvent("ok")]);
    void child;
    expect(rc).toBe(0);
    // the budget block ran before the fold was ever read: armBudget's snapshot saw the opening counters
    const st = loadStatus(dir, wid)!;
    expect(st.state).toBe("done");
    expect(st.rc).toBe(0);
    expect(st.budgetMin).toBe(20); // WORKER-BUDGET-START armed the checkpoint timer at start
  }, 60_000);

  it("a start whose spawn throws fails, marked on the status — a startup throw never passes as rc 0", async () => {
    // guards the guard above: if executeRun ever started swallowing startup
    // errors, a broken start (the incident's TDZ was one) would pass as done.
    vi.doMock("node:child_process", async (importOriginal) => {
      const orig = await importOriginal<typeof import("node:child_process")>();
      return { ...orig, spawn: vi.fn(() => { throw new TypeError("Cannot access 'toolFold' before initialization"); }) };
    });
    vi.resetModules();
    const { executeRun } = await import("./execute.js");
    const claudeArgs = ["-p", "reply ok", "--output-format", "json"];
    await expect(
      executeRun({
        config: runConfig,
        logDir: dir,
        target: { providerName: "testp", provider, modelAlias: null, classMcp: null, via: "flag" },
        model: "claude-sonnet-4-5",
        label: "start-throws",
        parsed: parseRunnerArgs(claudeArgs),
        claudeArgs,
        reroutes: 0,
        reportFormat: "json",
        limit: null,
        budgetMin: 20,
        noBrowser: true,
        quiet: true,
        id: "startthr1",
        opts: { claudeArgs },
        systemWaiver: "test" as never,
      } as never)
    ).rejects.toThrow(/toolFold/);
    expect(loadStatus(dir, "startthr1")!.state).toBe("failed");
  }, 60_000);

  it("the run's transcript and ledger record the budget start", async () => {
    const wid = "startlog1";
    await startWorker(wid, [initEvent, resultEvent("ok")]);
    const events = readFileSync(join(dir, `${wid}.events.jsonl`), "utf8");
    expect(events).toContain('"type":"result"');
    if (!readdirSync(dir).includes("ledger.log")) throw new Error("no ledger.log written");
    expect(readFileSync(join(dir, "ledger.log"), "utf8")).toContain("WORKER-BUDGET-START");
  }, 60_000);
});
