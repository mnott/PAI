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
import { saveStatus, type WorkerStatus } from "./status.js";
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
    expect(d.escalate.triggers).toEqual(["context", "missing-tool", "repeated-failure", "loop-stop"]);
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
    expect(detectTrigger({ failures: 1, loopStopped: true })).toBeNull();
    expect(detectTrigger({ failures: 2, loopStopped: true })?.reason).toContain("loop-guard stop");
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

  it("a loop stop without saved work has no loop-stop trigger and follows the failures rule", () => {
    expect(detectTrigger({ loopStopped: true, commits: [], failures: 1 })).toBeNull();
    expect(planEscalation({ ...stopped, commits: [] })).toBeNull();
    expect(detectTrigger({ loopStopped: true, commits: [], failures: 2 })?.kind).toBe("repeated-failure");
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
});
