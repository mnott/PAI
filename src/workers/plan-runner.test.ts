import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, type Plan } from "./plan.js";
import {
  appendRunLog,
  dryRunSchedule,
  planStatus,
  readRunLog,
  renderStatus,
  resumeState,
  runPlan,
  type MergeOutcome,
  type RunLogEntry,
  type RunnerDeps,
  type StartRequest,
  type WorkerOutcome,
} from "./plan-runner.js";

function plan(extra = ""): Plan {
  return parsePlan(
    `job: j\nrepo: /r\ngate: gate\nprovider: local\n${extra}units:
  - id: u1
    unit_check: check1
    parts:
      - {id: a, spec: A, files: [f1]}
      - {id: b, spec: B, files: [f2], depends_on: [a]}
      - {id: c, spec: C, files: [f1]}
      - {id: d, spec: D, files: [f3]}
  - id: u2
    parts:
      - {id: e, spec: E, files: [f4], depends_on: [b]}
`,
    "/x",
  );
}

interface Harness {
  deps: RunnerDeps;
  log: RunLogEntry[];
  starts: string[];
  maxRunning: () => number;
  overlaps: string[];
  merges: string[];
}

/** Fake deps: workers finish after `ticks` microtask rounds; `outcome` decides success per part/attempt. */
function harness(p: Plan, outcome: (r: StartRequest) => boolean = () => true, mergeOk: (id: string, n: number) => boolean = () => true, checkOk = true): Harness {
  const log: RunLogEntry[] = [];
  const starts: string[] = [];
  const merges: string[] = [];
  const overlaps: string[] = [];
  const live = new Set<StartRequest>();
  let max = 0;
  let counter = 0;
  const mergeCount = new Map<string, number>();
  const deps: RunnerDeps = {
    now: () => 0,
    log: (e) => log.push(e),
    async startWorker(r): Promise<WorkerOutcome> {
      for (const o of live) if (o.part.files.some((f) => r.part.files.includes(f))) overlaps.push(`${o.part.id}/${r.part.id}`);
      live.add(r);
      max = Math.max(max, live.size);
      starts.push(`${r.part.id}#${r.attempt}${r.tier === "sonnet" ? "S" : ""}`);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((res) => setTimeout(res, r.part.id === "a" ? 5 : 1));
      live.delete(r);
      const ok = outcome(r);
      return { id: `w-${r.part.id}-${r.attempt}`, ok, failure: ok ? undefined : `fail ${r.part.id}`, tokens: 10 };
    },
    async merge(id): Promise<MergeOutcome> {
      const n = (mergeCount.get(id) ?? 0) + 1;
      mergeCount.set(id, n);
      merges.push(id);
      const ok = mergeOk(id, n);
      return { ok, commit: ok ? `sha-${id}` : undefined, output: ok ? "" : "gate output line" };
    },
    async unitCheck() {
      return { ok: checkOk, output: "parity broke" };
    },
  };
  return { deps, log, starts, maxRunning: () => max, overlaps, merges };
}

describe("runPlan", () => {
  it("respects dependency order, slot limit and same-file exclusion", async () => {
    const p = plan();
    const h = harness(p);
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(s.merged.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(h.maxRunning()).toBeLessThanOrEqual(2);
    expect(h.overlaps).toEqual([]);
    // a and c share f1: c cannot start alongside a; b needs a merged
    const order = h.log.filter((e) => e.event === "merge").map((e) => e.part);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("e"));
    expect(h.log.find((e) => e.event === "part-start" && e.part === "b")).toBeDefined();
    expect(h.log.filter((e) => e.event === "unit-check")).toHaveLength(1);
  });
  it("runs one slot at a time when parallel=1", async () => {
    const p = plan();
    const h = harness(p);
    await runPlan(p, { parallel: 1 }, h.deps);
    expect(h.maxRunning()).toBe(1);
  });
  it("retries once locally with the failure tail, then marks needs-decision and goes on", async () => {
    const p = plan();
    const specs: string[] = [];
    const h = harness(p, (r) => {
      specs.push(r.spec);
      return r.part.id !== "a";
    });
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(h.starts.filter((x) => x.startsWith("a#"))).toEqual(["a#1", "a#2"]);
    expect(specs.some((t) => /previous attempt failed[\s\S]*fail a/.test(t))).toBe(true);
    expect(s.needsDecision).toEqual(["a"]);
    expect(s.merged.sort()).toEqual(["c", "d"]);
    expect(s.blocked.sort()).toEqual(["b", "e"]);
    expect(h.log.some((e) => e.event === "needs-decision" && e.part === "a")).toBe(true);
  });
  it("a gate failure retries, and a second merge success finishes the part", async () => {
    const p = plan();
    const h = harness(p, () => true, (id, n) => !(id === "w-a-1" && n === 1));
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(s.needsDecision).toEqual([]);
    expect(h.starts.filter((x) => x.startsWith("a#"))).toEqual(["a#1", "a#2"]);
    const specAfter = h.log.find((e) => e.event === "merge" && e.part === "a" && e.ok === false);
    expect(specAfter?.note).toBe("gate output line");
  });
  it("--escalate runs one sonnet worker after the retry and counts it", async () => {
    const p = plan();
    const h = harness(p, (r) => !(r.part.id === "a" && r.tier === "local"));
    const s = await runPlan(p, { parallel: 2, escalate: true }, h.deps);
    expect(h.starts.filter((x) => x.startsWith("a#"))).toEqual(["a#1", "a#2", "a#3S"]);
    expect(s.escalations).toBe(1);
    expect(s.needsDecision).toEqual([]);
  });
  it("a failing unit_check marks the unit needs-decision", async () => {
    const p = plan();
    const h = harness(p, () => true, () => true, false);
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(s.unitFailures).toEqual(["u1"]);
    expect(h.log.some((e) => e.event === "needs-decision" && e.unit === "u1")).toBe(true);
  });
  it("resumes from the log: merged parts are skipped, the unit check is not repeated", async () => {
    const p = plan();
    const dir = mkdtempSync(join(tmpdir(), "plan-log-"));
    const path = join(dir, "p.yaml.run.jsonl");
    const h1 = harness(p, (r) => r.part.id !== "b");
    await runPlan(p, { parallel: 2 }, { ...h1.deps, log: (e) => appendRunLog(path, e) });
    const { merged, unitsChecked } = resumeState(readRunLog(path));
    expect([...merged].sort()).toEqual(["a", "c", "d"]);
    const h2 = harness(p);
    const s = await runPlan(p, { parallel: 2, merged, unitsChecked }, h2.deps);
    expect(h2.starts.map((x) => x.split("#")[0]).sort()).toEqual(["b", "e"]);
    expect(s.merged.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("no-commit merges", () => {
  it("a merge that moves nothing is logged no-commit, retried with the reason, then needs-decision", async () => {
    const p = plan();
    const specs: string[] = [];
    const h = harness(p, (r) => (specs.push(r.spec), true));
    const orig = h.deps.merge;
    h.deps.merge = async (id, gate) => {
      const m = await orig(id, gate);
      return id.startsWith("w-a-") ? { ...m, ok: true, commit: "head0", before: "head0" } : m;
    };
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(h.starts.filter((x) => x.startsWith("a#"))).toEqual(["a#1", "a#2"]);
    const merges = h.log.filter((e) => e.event === "merge" && e.part === "a");
    expect(merges.map((e) => [e.ok, e.status, e.commit])).toEqual([[false, "no-commit", undefined], [false, "no-commit", undefined]]);
    expect(specs.some((t) => /no-commit: the worker branch has no commit/.test(t))).toBe(true);
    expect(s.needsDecision).toEqual(["a"]);
    expect(s.merged).not.toContain("a");
    expect(resumeState(h.log).merged.has("a")).toBe(false);
  });
  it("a deps-reported noCommit also fails the part", async () => {
    const p = plan();
    const h = harness(p);
    const orig = h.deps.merge;
    h.deps.merge = async (id, gate) => (id === "w-d-1" ? { ok: false, noCommit: true, output: "no commit" } : orig(id, gate));
    await runPlan(p, { parallel: 2 }, h.deps);
    expect(h.log.find((e) => e.event === "merge" && e.part === "d")?.status).toBe("no-commit");
  });
});

describe("dryRunSchedule and status", () => {
  it("waves honour dependencies, slots and files", () => {
    const waves = dryRunSchedule(plan(), { parallel: 2 }).map((w) => w.map((x) => x.id));
    expect(waves).toEqual([["a", "d"], ["b", "c"], ["e"]]);
  });
  it("planStatus summarises the log", () => {
    const p = plan();
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const log: RunLogEntry[] = [
      { ts: t(0), event: "run-start" },
      { ts: t(1), event: "part-start", part: "a", attempt: 1 },
      { ts: t(5), event: "part-end", part: "a", ok: true, tokens: 100 },
      { ts: t(6), event: "merge", part: "a", ok: true },
      { ts: t(7), event: "part-start", part: "b", attempt: 1 },
      { ts: t(8), event: "part-start", part: "c", attempt: 1 },
      { ts: t(9), event: "needs-decision", part: "c" },
    ];
    const st = planStatus(p, log, Date.parse(t(10)));
    expect(st).toMatchObject({ done: ["a"], running: ["b"], needsDecision: ["c"], waiting: ["d", "e"], tokens: 100, wallMs: 10_000 });
    expect(renderStatus(p, st)).toMatch(/done +1 \(a\)[\s\S]*needs-decision 1 \(c\)[\s\S]*0m10s/);
  });
});
