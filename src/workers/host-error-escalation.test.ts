/**
 * host-error-escalation.test.ts — a local run the pool host could not finish
 * (host-error: the slot died mid-task, the host refused, the answer never
 * arrived) escalates one tier up whenever escalation is enabled — with or
 * without commits and with or without a result event (2026-10-23: a
 * loop-stopped spare with no commits ended as a silent rc-1 failure and never
 * went up a tier). The claim also carries the run's own resolved provider: a
 * spare claimed on another provider ran the task on the wrong model.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWorkersConfig, type WorkerProvider, type WorkersConfig } from "./config.js";
import { ledgerPath } from "./paths.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { escalateAfterHostError, resolveClaimProvider, type ExecuteArgs } from "./run.js";
import * as executeMod from "./run/execute.js";
import { tryEscalate } from "./run/escalate.js";
import { NoLocalServerError } from "./local-provider.js";

vi.mock("./pane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pane.js")>();
  return { ...actual, openVerifiedPane: vi.fn().mockResolvedValue("here"), openPaneForWorker: vi.fn(), resolveHostSession: vi.fn().mockResolvedValue({ term: "t" }) };
});
import { DEFAULT_ESCALATE } from "./escalation.js";
import { parseRunnerArgs } from "./args.js";
import type { TierDef } from "./route-lists.js";

const tiers: TierDef[] = [
  { id: "t0", name: "Session", models: ["glm/glm-5.3"], classes: [], session: true },
  { id: "t1", name: "Orchestrator", models: ["anthropic/opus"], classes: ["orchestrate", "plan"] },
  { id: "t2", name: "Worker", models: ["gyro-m"], classes: ["implement"], default: true },
];
const localProvider: WorkerProvider = { enabled: true, protocol: "anthropic", baseUrl: "http://127.0.0.1:8477", keyFile: null, models: { default: "qwen-local" }, env: {} };
const cloudProvider: WorkerProvider = { enabled: true, protocol: "anthropic", baseUrl: "https://example.invalid", keyFile: null, models: { default: "sonnet" }, env: {} };

const config = (): WorkersConfig => ({
  ...defaultWorkersConfig(),
  tiers,
  escalate: DEFAULT_ESCALATE,
  providers: { "gyro-m": localProvider, anthropic: cloudProvider },
});

type Seen = { providerFlag?: string; modelFlag?: string; label?: string; claudeArgs: string[]; _escalatedFrom?: string[]; _fallThroughOf?: string };

function baseArgs(logDir: string, runner: (o: Seen & { onWorkerStart?: (id: string) => void }) => Promise<number>, over: Partial<ExecuteArgs> = {}): ExecuteArgs {
  return {
    config: config(),
    logDir,
    target: { providerName: "gyro-m", provider: localProvider, modelAlias: null, classMcp: null, via: "flag" },
    model: "qwen-local",
    label: "job",
    parsed: parseRunnerArgs(["-p", "ORIGINAL TASK"]),
    claudeArgs: ["-p", "ORIGINAL TASK"],
    className: "implement",
    reroutes: 0,
    route: { policy: "prefer-local", reason: "route: gyro-m", local: true },
    reportFormat: "ag2",
    limit: null,
    noBrowser: true,
    quiet: true,
    opts: { claudeArgs: ["-p", "ORIGINAL TASK"], localFlag: true, localName: "gyro-m", providerFlag: "gyro-m" },
    runner,
    ...over,
  } as unknown as ExecuteArgs;
}

const failedStatus = (logDir: string, over: Partial<WorkerStatus> = {}): WorkerStatus => {
  const st = {
    id: "w1", pid: -1, label: "job", cwd: logDir, term: "", provider: "gyro-m", model: "qwen-local", state: "failed",
    started: "2026-10-23 01:00:00", updated: "2026-10-23 01:00:00", turns: 0, tools: 0, last: "loop-stopped: x", rc: 1, secs: 5,
    loopStopped: true, ...over,
  } as WorkerStatus;
  saveStatus(logDir, st);
  return st;
};

beforeEach(() => {
  for (const k of ["PAI_SESSION_NAME", "PAI_SESSION_PROVIDER", "PAI_SESSION_WORKER_PROVIDER", "PAI_WORKER_BATCH"]) vi.stubEnv(k, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("a pooled local run the host could not finish escalates", () => {
  it("no result event + loop-stopped + no commits: rerunOn one tier up", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-"));
    failedStatus(logDir);
    const seen: Seen[] = [];
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), o.onWorkerStart?.("w2"), 0));
    const rc = await escalateAfterHostError(a, "w1", "host-error");
    expect(rc).toBe(0);
    expect(seen).toHaveLength(1);
    // t1's own route, never the local provider
    expect(seen[0].providerFlag).toBe("anthropic");
    expect(seen[0].modelFlag).toBe("opus");
    const spec = seen[0].claudeArgs[1];
    expect(spec.startsWith("[escalated t2→t1")).toBe(true);
    expect(spec).toContain("pool host ended the run (host-error)");
    expect(spec.endsWith("ORIGINAL TASK")).toBe(true);
    const after = loadStatus(logDir, "w1")!;
    expect(after.escalated).toMatch(/^escalated t2→t1: /);
    expect(after.escalatedTo).toBe("w2");
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-ESCALATE id=w1 from=t2\/qwen-local to=t1\/anthropic\/opus reason=pool host ended the run \(host-error\) toId=w2/);
  });

  it("escalation enabled but no tier above: the cloud fall-through re-run stands", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-ft-"));
    failedStatus(logDir);
    const seen: Seen[] = [];
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), o.onWorkerStart?.("w2"), 0), {
      config: { ...config(), tiers: [{ id: "t2", name: "Worker", models: ["gyro-m"], classes: ["implement"], default: true }] },
    });
    const rc = await escalateAfterHostError(a, "w1", "host-error");
    expect(rc).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].providerFlag).toBe("anthropic");
    expect(seen[0]._fallThroughOf).toBe("w1");
    expect(seen[0].label).toContain("fall-through");
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-FALLTHROUGH id=w1 reason=pool host ended the run \(host-error\)/);
  });

  it("escalation off by config: no escalation, the task runs fresh on the same target", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-off-"));
    failedStatus(logDir);
    const seen: Seen[] = [];
    const executeRun = vi.fn().mockResolvedValue(7);
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), 0), {
      config: { ...config(), escalate: { ...DEFAULT_ESCALATE, enabled: false } },
      route: undefined,
    });
    // the fresh-spawn path is executeRun; stub the binding the gate imported
    vi.spyOn(executeMod, "executeRun").mockImplementation(executeRun as never);
    const rc = await escalateAfterHostError(a, "w1", "host-error");
    expect(seen).toHaveLength(0);
    expect(rc).toBe(7);
    expect(executeRun).toHaveBeenCalledTimes(1);
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-POOL-SKIP id=w1 provider=gyro-m reason=host-error/);
  });

  it("a run the operator killed (rc 143) is not restarted", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-kill-"));
    failedStatus(logDir, { rc: 143, state: "killed" });
    const seen: Seen[] = [];
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), 0));
    expect(await escalateAfterHostError(a, "w1", "host-error")).toBe(143);
    expect(seen).toHaveLength(0);
  });

  it("a run still marked running is recorded as ended before the escalation", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-live-"));
    const st = failedStatus(logDir, { state: "running", rc: null, loopStopped: undefined, last: "running" });
    void st;
    const a = baseArgs(logDir, async (o) => (o.onWorkerStart?.("w2"), 0));
    await escalateAfterHostError(a, "w1", "host-error");
    const after = loadStatus(logDir, "w1")!;
    expect(after.state).toBe("failed");
    expect(after.last).toMatch(/^escalated t2→t1: /);
    expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-END id=w1 .*mode=pooled .*note=pool slot died mid-task: host-error/);
  });

  it("a cloud run that died in the host re-runs fresh on its own target, not once more on the cloud", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-hosterr-cloud-"));
    failedStatus(logDir, { provider: "anthropic", model: "sonnet", loopStopped: undefined });
    const seen: Seen[] = [];
    const executeRun = vi.fn().mockResolvedValue(3);
    vi.spyOn(executeMod, "executeRun").mockImplementation(executeRun as never);
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), 0), {
      route: undefined,
      target: { providerName: "anthropic", provider: cloudProvider, modelAlias: null, classMcp: null, via: "flag" },
      model: "sonnet",
    });
    const rc = await escalateAfterHostError(a, "w1", "host-error");
    expect(seen).toHaveLength(0);
    expect(rc).toBe(3);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });
});

describe("the pool claim names the run's own provider", () => {
  it("an escalated cloud run claims on the cloud provider, not the session's local one", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-claim-cloud-"));
    vi.stubEnv("PAI_SESSION_WORKER_PROVIDER", "gyro-m");
    const a = baseArgs(logDir, async () => 0, {
      opts: { claudeArgs: ["-p", "ORIGINAL TASK"], providerFlag: "anthropic", modelFlag: "opus" },
      target: { providerName: "anthropic", provider: cloudProvider, modelAlias: "opus", classMcp: null, via: "flag" },
      model: "opus",
    });
    expect(await resolveClaimProvider(a)).toBe("anthropic");
  });

  it("a routed run claims on the provider its target resolved to, not a second resolution (session said gyro-m, target is the route's)", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-claim-route-"));
    vi.stubEnv("PAI_SESSION_WORKER_PROVIDER", "gyro-m");
    const a = baseArgs(logDir, async () => 0, {
      opts: { claudeArgs: ["-p", "ORIGINAL TASK"] },
      route: { policy: "prefer-local", reason: "policy prefer-local", local: true },
      target: { providerName: "anthropic", provider: cloudProvider, modelAlias: null, classMcp: null, via: "class" },
    });
    expect(await resolveClaimProvider(a)).toBe("anthropic");
  });

  it("a session-profile run claims on its profile's provider", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-claim-profile-"));
    vi.stubEnv("PAI_SESSION_WORKER_PROVIDER", "gyro-m");
    const a = baseArgs(logDir, async () => 0, { opts: { claudeArgs: ["-p", "ORIGINAL TASK"] } });
    expect(await resolveClaimProvider(a)).toBe("gyro-m");
  });
});

describe("an unpooled local run stopped by the loop guard escalates (tryEscalate, no result event)", () => {
  for (const rc of [143, 1]) {
    it(`rc ${rc}, no commits: rerunOn-side re-run once with the escalated prompt`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), "pai-unpooled-"));
      const st = failedStatus(logDir, { rc });
      const seen: Seen[] = [];
      const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), o.onWorkerStart?.("w2"), 0));
      const out = await tryEscalate(a, "w1", st, { result: "-", why: "loop-stopped: x" } as never, undefined, [], "loop-guard stop");
      expect(out).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].providerFlag).toBe("anthropic");
      expect(seen[0].claudeArgs[1].startsWith("[escalated t2→t1")).toBe(true);
      expect(seen[0]._escalatedFrom).toEqual(["t2"]);
    });
  }

  it("a deadline-stopped run with nothing saved escalates too", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-unpooled-dl-"));
    const st = failedStatus(logDir, { rc: 143, loopStopped: undefined, timedOut: true });
    const seen: Seen[] = [];
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), 0));
    expect(await tryEscalate(a, "w1", st, null, undefined, [], "max-minutes")).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("a cloud run is not escalated", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-unpooled-cloud-"));
    const st = failedStatus(logDir, { provider: "anthropic", rc: 143 });
    const seen: Seen[] = [];
    const a = baseArgs(logDir, async (o) => (seen.push(o as Seen), 0), { className: "orchestrate" });
    // t1 has a tier above only through the session: no re-run
    await tryEscalate(a, "w1", st, null, undefined, [], "loop-guard stop");
    expect(seen).toHaveLength(0);
  });

  it("disabled by config, or already escalated out of the tier: no re-run", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-unpooled-off-"));
    const st = failedStatus(logDir, { rc: 143 });
    const seen: Seen[] = [];
    const run = async (o: Seen) => (seen.push(o), 0);
    await tryEscalate(baseArgs(logDir, run, { config: { ...config(), escalate: { ...DEFAULT_ESCALATE, enabled: false } } }), "w1", st, null, undefined, [], "loop-guard stop");
    await tryEscalate(baseArgs(logDir, run, { escalatedFrom: ["t2"] }), "w1", st, null, undefined, [], "loop-guard stop");
    expect(seen).toHaveLength(0);
  });
});

describe("the pool claim is the resolved route, never a second resolution", () => {
  it("a profile-routed run (target coder-l) claims coder-l even when the session itself runs on anthropic", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-claim-target-"));
    vi.stubEnv("PAI_SESSION_PROVIDER", "anthropic");
    const a = baseArgs(logDir, async () => 0, {
      opts: { claudeArgs: ["-p", "ORIGINAL TASK"] },
      route: undefined,
      target: { providerName: "gyro-m", provider: localProvider, modelAlias: null, classMcp: null, via: "session" },
    });
    expect(await resolveClaimProvider(a)).toBe("gyro-m");
  });
});
