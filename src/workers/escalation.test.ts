import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ESCALATE,
  decideEscalation,
  detectTrigger,
  parseEscalate,
  planEscalation,
  type PlanInput,
  tierOf,
  type TierDef,
} from "./escalation.js";
import { runEscalation, type EscalateRunDeps } from "./escalate-run.js";
import { classifyRoute } from "./route-classifier.js";
import { parseTiersValue } from "./route-lists.js";
import { effectiveWorkersYamlRaw, shippedWorkersDefaults } from "../config/shipped-defaults.js";
import { tryEscalate, type ExecuteArgs } from "./run.js";
import { parseRunnerArgs } from "./args.js";
import { loadStatus, saveStatus, type WorkerStatus } from "./status.js";
import { ledgerPath } from "./paths.js";
import { defaultWorkersConfig, parseWorkersConfig } from "./config.js";

const tiers: TierDef[] = [
  { id: "t0", name: "Session", models: ["glm/glm-5.3"], classes: [], session: true },
  { id: "t1", name: "Orchestrator", models: ["anthropic/opus"], classes: ["orchestrate", "plan"] },
  { id: "t2", name: "Worker", models: ["glm"], classes: ["implement"], default: true },
];
const base = { tiers, cfg: DEFAULT_ESCALATE, className: "implement", state: { from: [] as string[] }, id: "w1", label: "job", done: "did half", commits: ["abc fix part"], branch: "worker/w1" };

describe("tiers from config", () => {
  it("maps classes, default tier, none without tiers", () => {
    expect(tierOf(tiers, "plan")).toBe("t1");
    expect(tierOf(tiers, "review")).toBe("t2");
    expect(tierOf([], "plan")).toBeNull();
  });
  it("the shipped defaults carry t0/t1/t2 and the escalate block", () => {
    const d = defaultWorkersConfig();
    const shipped = shippedWorkersDefaults();
    expect(parseTiersValue((shipped as { tiers?: unknown }).tiers).map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(parseTiersValue((shipped as { tiers?: unknown }).tiers)[0].session).toBe(true);
    expect(d.escalate).toMatchObject({ enabled: true, contextFraction: 0.7, failures: 2 });
    expect(d.escalate.triggers).toEqual(["context", "missing-tool", "repeated-failure", "loop-stop", "deadline"]);
  });
  it("parses and rejects bad config", () => {
    expect(parseTiersValue([{ id: "a", models: ["glm"] }])[0].classes).toBeUndefined();
    expect(() => parseTiersValue([{ id: "a", models: ["glm"] }, { id: "a", models: ["glm"] }])).toThrow(/duplicate/);
    const bad = (p: string, m: string): never => {
      throw new Error(p + m);
    };
    expect(parseEscalate({ contextFraction: 0.5 }, bad)).toMatchObject({ enabled: true, contextFraction: 0.5, failures: 2 });
    expect(() => parseEscalate({ contextFraction: 2 }, bad)).toThrow();
  });
});

describe("triggers", () => {
  it("context over the fraction or a too-long prompt", () => {
    expect(detectTrigger({ contextTokens: 74, contextWindow: 100 })?.reason).toBe("context 74%");
    expect(detectTrigger({ contextTokens: 60, contextWindow: 100 })).toBeNull();
    expect(detectTrigger({ resultText: "Prompt is too long" })?.kind).toBe("context");
  });
  it("missing tool from a tool error or needs-tool", () => {
    expect(detectTrigger({ toolErrors: ["No such tool available: mcp__x__y"] })?.kind).toBe("missing-tool");
    expect(detectTrigger({ reportText: "needs-tool: browser" })?.reason).toBe("missing tool browser");
  });
  it("repeated failure at the configured count", () => {
    expect(detectTrigger({ failures: 1, reportValid: false })).toBeNull();
    expect(detectTrigger({ failures: 2, reportValid: false })?.reason).toContain("invalid report");
    expect(detectTrigger({ failures: 2, cfg: { ...DEFAULT_ESCALATE, triggers: ["context"] } })).toBeNull();
  });
  it("old 2-local-failures rule is this rule", () => {
    expect(classifyRoute({ failures: 2 }).where).toBe("cloud");
    expect(classifyRoute({ failures: 1 }).where).toBe("local");
  });
});

describe("decision", () => {
  it("t2 -> t1 rerun, t1 -> session, once per tier, disabled", () => {
    const t = { kind: "context" as const, reason: "context 74%" };
    expect(decideEscalation(tiers, "t2", t, { from: [] })).toMatchObject({ action: "rerun" });
    expect(decideEscalation(tiers, "t2", t, { from: ["t2"] }).action).toBe("none");
    expect(decideEscalation(tiers, "t1", t, { from: [] })).toMatchObject({ action: "session" });
    expect(decideEscalation(tiers, "t2", t, { from: [] }, { ...DEFAULT_ESCALATE, enabled: false }).action).toBe("none");
  });
});

function deps(over: Partial<EscalateRunDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "esc-"));
  const calls = { reruns: [] as Array<Parameters<EscalateRunDeps["rerun"]>[0]>, notes: [] as string[], marks: [] as string[] };
  const d: EscalateRunDeps = {
    ledger: join(dir, "ledger.log"),
    id: "w1",
    label: "job",
    spec: "ORIGINAL TASK",
    markEscalated: (l) => void calls.marks.push(l),
    rerun: async (o) => (calls.reruns.push(o), o.onStarted("w2"), 0),
    notifySession: async (t) => void calls.notes.push(t),
    ...over,
  };
  return { d, calls };
}

describe("escalation run", () => {
  for (const [name, input] of [
    ["context", { contextTokens: 74, contextWindow: 100 }],
    ["missing tool", { toolErrors: ["No such tool available: foo"] }],
    ["repeated failure", { failures: 2, reportValid: false }],
  ] as Array<[string, Partial<PlanInput>]>) {
    it(`${name}: t2 -> t1 once, salvage merge + summary prepended, commits kept in summary`, async () => {
      const plan = planEscalation({ ...base, ...input })!;
      const { d, calls } = deps();
      const out = await runEscalation(plan, [], d);
      expect(out).toEqual({ kind: "rerun", rc: 0 });
      expect(calls.reruns).toHaveLength(1);
      const r = calls.reruns[0];
      expect(r).toMatchObject({ providerFlag: "anthropic", modelFlag: "opus", escalatedFrom: ["t2"] });
      expect(r.prompt.startsWith("[escalated t2→t1")).toBe(true);
      // escalation starts from the salvaged branch (the manual escalations' wording)
      expect(r.prompt).toContain("Continue, do not restart: first git merge worker/w1");
      expect(r.prompt).toContain("abc fix part");
      expect(r.prompt.endsWith("ORIGINAL TASK")).toBe(true);
      expect(calls.marks[0]).toMatch(/^escalated t2→t1: /);
      expect(readFileSync(d.ledger, "utf8")).toMatch(/WORKER-ESCALATE id=w1 from=t2 to=t1\/anthropic\/opus reason=.* toId=w2/);
      // the escalated run does not escalate again from t2 (no ping-pong)
      expect(planEscalation({ ...base, ...input, state: { from: r.escalatedFrom } })).toBeNull();
    });
  }

  it("a benchmark-labelled run is never escalated; the same run unlabelled is", () => {
    const bad = { ...base, failures: 2, reportValid: false };
    expect(planEscalation({ ...bad, label: "hold probe3 bench" })).toBeNull();
    expect(planEscalation({ ...bad, label: "refactor the parser" })).not.toBeNull();
  });

  it("a run kept for review is not escalated", () => {
    expect(planEscalation({ ...base, contextTokens: 90, contextWindow: 100, keptForReview: true })).toBeNull();
    expect(planEscalation({ ...base, failures: 2, reportValid: false, keptForReview: true })).toBeNull();
  });

  it("a loop-stopped run that committed escalates with the salvage merge instruction in the new spec", async () => {
    const plan = planEscalation({
      ...base,
      loopStopped: true,
      failures: 2,
      failureWhy: "loop-stopped after committing: repeated identical tool call",
      commits: ["abc fix part", "def more work"],
    })!;
    const { d, calls } = deps();
    const out = await runEscalation(plan, [], d);
    expect(out).toEqual({ kind: "rerun", rc: 0 });
    const r = calls.reruns[0];
    expect(r.prompt).toContain("Continue, do not restart: first git merge worker/w1");
    expect(r.prompt).toContain("loop-stopped after committing");
    expect(r.prompt).toContain("abc fix part");
    expect(r.prompt.endsWith("ORIGINAL TASK")).toBe(true);
  });

  it("t1 trigger messages the session and ends ~", async () => {
    const plan = planEscalation({ ...base, className: "plan", contextTokens: 80, contextWindow: 100 })!;
    const { d, calls } = deps();
    const out = await runEscalation(plan, [], d);
    expect(calls.reruns).toHaveLength(0);
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]).toContain("context 80%");
    expect(out).toMatchObject({ kind: "session", report: { result: "~", why: "escalated to session" } });
    expect(readFileSync(d.ledger, "utf8")).toContain("WORKER-ESCALATE id=w1 from=t1 to=t0");
  });

  it("an escalated-to-t1 task is not escalated again for t1 -> t0 by the t2 rule, nothing at t0", () => {
    expect(planEscalation({ ...base, className: "plan", state: { from: ["t1"] }, failures: 2 })).toBeNull();
  });
});

describe("thresholds come from config", () => {
  const dir = mkdtempSync(join(tmpdir(), "esc-cfg-"));
  const workersPath = join(dir, "workers.yaml");
  writeFileSync(workersPath, "workers:\n  escalate:\n    contextFraction: 0.9\n", "utf8");
  const merged = effectiveWorkersYamlRaw(workersPath);
  const parsed = parseWorkersConfig((merged as { workers?: unknown }).workers, undefined);
  it("a temp config override changes the parsed threshold", () => {
    expect(parsed.escalate.contextFraction).toBe(0.9);
    expect(parsed.escalate.failures).toBe(2);
  });
  it("the override changes the trigger's behaviour", () => {
    expect(detectTrigger({ contextTokens: 74, contextWindow: 100, cfg: parsed.escalate })).toBeNull();
    expect(detectTrigger({ contextTokens: 95, contextWindow: 100, cfg: parsed.escalate })?.reason).toBe("context 95%");
  });
});

describe("loop-stop trigger", () => {
  const stopped = { ...base, loopStopped: true, failures: 1, failureWhy: "loop-guard stop" };

  it("a loop-stopped run with a salvage commit escalates t2 -> t1 at once with the salvage merge instruction", async () => {
    const plan = planEscalation({ ...stopped, commits: ["abc salvage: uncommitted edits"] })!;
    expect(plan.trigger.kind).toBe("loop-stop");
    expect(plan.line).toMatch(/^escalated t2→t1: /);
    const { d, calls } = deps();
    expect(await runEscalation(plan, [], d)).toEqual({ kind: "rerun", rc: 0 });
    expect(calls.reruns[0].prompt).toContain("Continue, do not restart: first git merge worker/w1");
  });

  it("salvaged edits alone count as saved work", () => {
    expect(detectTrigger({ loopStopped: true, salvaged: true })?.kind).toBe("loop-stop");
  });

  it("a loop stop without saved work escalates at once too", () => {
    expect(detectTrigger({ loopStopped: true, commits: [], failures: 1 })?.kind).toBe("loop-stop");
    expect(planEscalation({ ...stopped, commits: [] })?.trigger.kind).toBe("loop-stop");
    expect(detectTrigger({ loopStopped: true, commits: [], failures: 2 })?.kind).toBe("loop-stop");
  });

  it("no loop-stop trigger in config -> no escalation at failures 1", () => {
    const cfg = { ...DEFAULT_ESCALATE, triggers: DEFAULT_ESCALATE.triggers.filter((t) => t !== "loop-stop") };
    expect(planEscalation({ ...stopped, cfg, commits: ["abc x"] })).toBeNull();
  });

  it("the loop-stop exit path calls the escalation: tryEscalate re-runs one tier up through the injected runner", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "esc-run-"));
    const st = {
      id: "w1", pid: -1, label: "job", cwd: logDir, term: "", provider: "p", model: "m", state: "failed",
      started: "2026-10-21 01:00:00", updated: "2026-10-21 01:00:00", turns: 0, tools: 0, last: "", rc: 143, secs: 5,
      loopStopped: true, branch: "worker/w1",
    } as WorkerStatus;
    saveStatus(logDir, st);
    const seen: Array<{ providerFlag?: string; modelFlag?: string; claudeArgs: string[] }> = [];
    const a = {
      logDir,
      config: { tiers, escalate: DEFAULT_ESCALATE },
      className: "implement",
      label: "job",
      parsed: parseRunnerArgs(["-p", "ORIGINAL TASK"]),
      opts: { claudeArgs: ["-p", "ORIGINAL TASK"] },
      runner: async (o: { providerFlag?: string; modelFlag?: string; claudeArgs: string[]; onWorkerStart?: (id: string) => void }) => (seen.push(o), o.onWorkerStart?.("w2"), 0),
    } as unknown as ExecuteArgs;
    const rc = await tryEscalate(a, "w1", st, { result: "~" }, undefined, ["abc salvage"], "loop-guard stop");
    expect(rc).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].providerFlag).toBe("anthropic");
    expect(seen[0].claudeArgs[1]).toContain("Continue, do not restart: first git merge worker/w1");
    expect(st.escalatedTo).toBe("w2");
  });

  describe("budget of the escalated re-run", () => {
    const mk = (limit: { deadlineAt: number; minutes: number; absolute?: true } | null, extra: Record<string, unknown> = {}) => {
      const logDir = mkdtempSync(join(tmpdir(), "esc-budget-"));
      const st = {
        id: "w1", pid: -1, label: "job", cwd: logDir, term: "", provider: "p", model: "m", state: "failed",
        started: "2026-10-21 01:00:00", updated: "2026-10-21 01:00:00", turns: 0, tools: 0, last: "", rc: 143, secs: 5,
        loopStopped: true, branch: "worker/w1",
      } as WorkerStatus;
      saveStatus(logDir, st);
      const seen: Array<{ maxMinutes?: number; deadline?: string }> = [];
      const a = {
        logDir, config: { tiers, escalate: DEFAULT_ESCALATE }, className: "implement", label: "job", limit,
        parsed: parseRunnerArgs(["-p", "ORIGINAL TASK"]),
        opts: { claudeArgs: ["-p", "ORIGINAL TASK"], ...extra },
        runner: async (o: { onWorkerStart?: (id: string) => void }) => (seen.push(o as never), o.onWorkerStart?.("w2"), 0),
      } as unknown as ExecuteArgs;
      return { a, st, seen };
    };
    it("a passed absolute --deadline starts no escalation", async () => {
      const { a, st, seen } = mk({ deadlineAt: Date.now() - 1000, minutes: 60, absolute: true }, { deadline: "03:00" });
      expect(await tryEscalate(a, "w1", st, { result: "~" }, undefined, ["abc salvage"], "deadline")).toBeNull();
      expect(seen).toHaveLength(0);
    });
    it("an absolute --deadline still ahead is carried over", async () => {
      const { a, st, seen } = mk({ deadlineAt: Date.now() + 600_000, minutes: 10, absolute: true }, { deadline: "03:00" });
      await tryEscalate(a, "w1", st, { result: "~" }, undefined, ["abc salvage"], "deadline");
      expect(seen[0].deadline).toBe("03:00");
    });
    it("--max-minutes: the re-run gets the remaining minutes, no escalation when spent", async () => {
      const left = mk({ deadlineAt: Date.now() + 20 * 60_000, minutes: 60 }, { maxMinutes: 60 });
      await tryEscalate(left.a, "w1", left.st, { result: "~" }, undefined, ["abc salvage"], "deadline");
      expect(left.seen[0].maxMinutes).toBeGreaterThanOrEqual(19);
      expect(left.seen[0].maxMinutes).toBeLessThanOrEqual(20);
      const spent = mk({ deadlineAt: Date.now() - 1000, minutes: 60 }, { maxMinutes: 60 });
      await tryEscalate(spent.a, "w1", spent.st, { result: "~" }, undefined, ["abc salvage"], "deadline");
      expect(spent.seen).toHaveLength(0);
    });
  });

  it("a --local run escalates to the next tier's own route: the local flag is not carried over", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "esc-local-"));
    const st = {
      id: "w1", pid: -1, label: "job", cwd: logDir, term: "", provider: "gyro-m", model: "m", state: "failed",
      started: "2026-10-21 01:00:00", updated: "2026-10-21 01:00:00", turns: 0, tools: 0, last: "", rc: 143, secs: 5,
      loopStopped: true, branch: "worker/w1",
    } as WorkerStatus;
    saveStatus(logDir, st);
    const seen: Array<{ providerFlag?: string; modelFlag?: string; localFlag?: boolean; localName?: string; label?: string }> = [];
    const a = {
      logDir,
      config: { tiers, escalate: DEFAULT_ESCALATE },
      className: "implement",
      label: "job",
      parsed: parseRunnerArgs(["-p", "ORIGINAL TASK"]),
      opts: { claudeArgs: ["-p", "ORIGINAL TASK"], localFlag: true, localName: "gyro-m", providerFlag: "gyro-m" },
      runner: async (o: { onWorkerStart?: (id: string) => void }) => (seen.push(o as never), o.onWorkerStart?.("w2"), 0),
    } as unknown as ExecuteArgs;
    await tryEscalate(a, "w1", st, { result: "~" }, undefined, ["abc salvage"], "loop-guard stop");
    expect(seen).toHaveLength(1);
    expect(seen[0].localFlag).toBeUndefined();
    expect(seen[0].localName).toBeUndefined();
    expect(seen[0].providerFlag).toBe("anthropic");
    expect(seen[0].label).toContain("escalated");
  });
});

describe("escalate.cloud", () => {
  const bad = (p: string, m: string): never => {
    throw new Error(`${p} ${m}`);
  };
  it("defaults to the shipped sonnet/anthropic target and parses overrides", () => {
    expect(parseEscalate(undefined, bad).cloud).toEqual({ tier: "sonnet", provider: "anthropic", model: "sonnet" });
    expect(parseEscalate({ cloud: { tier: "big", model: "m1" } }, bad).cloud).toEqual({ tier: "big", provider: "anthropic", model: "m1" });
    expect(() => parseEscalate({ cloud: { tier: "" } }, bad)).toThrow();
    expect(DEFAULT_ESCALATE.cloud.tier).toBe("sonnet");
  });
  it("the shipped workers.yaml carries the same values", () => {
    const e = (effectiveWorkersYamlRaw(join(tmpdir(), "no-such-workers.yaml")).workers as { escalate: { cloud: unknown } }).escalate;
    expect(e.cloud).toEqual(DEFAULT_ESCALATE.cloud);
  });
});

describe("escalation end to end (fake runner, fake routing table)", () => {
  type Seen = { providerFlag?: string; modelFlag?: string; localFlag?: boolean; claudeArgs: string[]; label?: string; w2State?: string };
  for (const [name, stop, why] of [
    ["loop-stop", { loopStopped: true }, "loop-guard stop"],
    ["deadline", { timedOut: true }, "max-minutes"],
  ] as Array<[string, Partial<WorkerStatus>, string]>) {
    it(`${name}: a local stopped run with saved work is re-run on the t1 route and tracked`, async () => {
      const logDir = mkdtempSync(join(tmpdir(), "esc-e2e-"));
      const st = {
        id: "w1", pid: -1, label: "job", cwd: logDir, term: "", provider: "gyro-m", model: "qwen-local", state: "failed",
        started: "2026-10-21 01:00:00", updated: "2026-10-21 01:00:00", turns: 0, tools: 0, last: "", rc: 143, secs: 5,
        branch: "worker/w1", ...stop,
      } as WorkerStatus;
      saveStatus(logDir, st);
      const seen: Seen[] = [];
      const a = {
        logDir,
        config: { tiers, escalate: DEFAULT_ESCALATE },
        className: "implement",
        label: "job",
        parsed: parseRunnerArgs(["-p", "ORIGINAL TASK"]),
        opts: { claudeArgs: ["-p", "ORIGINAL TASK"], localFlag: true, localName: "gyro-m", providerFlag: "gyro-m" },
        runner: async (o: Seen & { onWorkerStart?: (id: string) => void }) => {
          // the escalated run registers as running before it does anything else
          saveStatus(logDir, { ...st, id: "w2", state: "running", provider: o.providerFlag ?? "", model: o.modelFlag ?? "", escalated: undefined, escalatedTo: undefined } as WorkerStatus);
          o.onWorkerStart?.("w2");
          seen.push({ ...o, w2State: loadStatus(logDir, "w2")?.state });
          return 0;
        },
      } as unknown as ExecuteArgs;
      // the escalation sees the same inputs the exit path passes: commits on the branch, the fall-through reason
      const rc = await tryEscalate(a, "w1", st, { result: "~" }, undefined, ["abc salvage: uncommitted edits"], why);
      expect(rc).toBe(0);
      expect(seen).toHaveLength(1);
      // t1's own route, never the local provider
      expect(seen[0].providerFlag).toBe("anthropic");
      expect(seen[0].modelFlag).toBe("opus");
      expect(seen[0].localFlag).toBeUndefined();
      // the spec opens with the handoff and the merge instruction naming the stopped branch
      const spec = seen[0].claudeArgs[1];
      expect(spec.startsWith("[escalated t2→t1")).toBe(true);
      expect(spec).toContain("Continue, do not restart: first git merge worker/w1");
      expect(spec.endsWith("ORIGINAL TASK")).toBe(true);
      // the stopped run points at the escalated one
      const after = loadStatus(logDir, "w1")!;
      expect(after.escalated).toMatch(/^escalated t2→t1: /);
      expect(after.escalatedTo).toBe("w2");
      // the ledger has the escalation
      expect(readFileSync(ledgerPath(logDir), "utf8")).toMatch(/WORKER-ESCALATE id=w1 from=t2\/qwen-local to=t1\/anthropic\/opus/);
      // the escalated run is queued/running, not lost
      expect(["queued", "running"]).toContain(seen[0].w2State);
    });
  }

  it("deadline with nothing saved escalates at once too", () => {
    expect(detectTrigger({ timedOut: true, commits: [], failures: 1 })?.kind).toBe("deadline");
    expect(detectTrigger({ timedOut: true, commits: [], failures: 2 })?.kind).toBe("deadline");
    expect(detectTrigger({ timedOut: true, salvaged: true })?.kind).toBe("deadline");
  });

  it("a timed-out run kept for review (it committed) still escalates; a loop-stop kept for review does too", () => {
    expect(planEscalation({ ...base, timedOut: true, failures: 1, failureWhy: "max-minutes", keptForReview: true })?.trigger.kind).toBe("deadline");
    expect(planEscalation({ ...base, loopStopped: true, failures: 1, keptForReview: true })?.trigger.kind).toBe("loop-stop");
  });

  it("no deadline trigger in config -> a timed-out run waits for the failures rule", () => {
    const cfg = { ...DEFAULT_ESCALATE, triggers: DEFAULT_ESCALATE.triggers.filter((t) => t !== "deadline") };
    expect(planEscalation({ ...base, cfg, timedOut: true, failures: 1 })).toBeNull();
  });
});
