import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan, type Plan } from "./plan.js";
import { realCommitsAhead, workerArgs, worktreeProblem } from "./plan-deps.js";
import {
  appendRunLog,
  dryRunSchedule,
  planStatus,
  readRunLog,
  renderStatus,
  resumeState,
  runPlan,
  blockedMessage,
  runExitCode,
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

describe("blocked runs", () => {
  it("failing unit_check with all dependents: exit 3, blocked message, run-end blocked, independent parts ran first", async () => {
    const p = parsePlan(
      `job: j\nrepo: /r\ngate: gate\nprovider: local\nunits:
  - id: u1
    unit_check: check1
    parts:
      - {id: a, spec: A, files: [f1]}
  - id: u2
    parts:
      - {id: i, spec: I, files: [f9]}
      - {id: b, spec: B, files: [f2], depends_on: [a]}
      - {id: c, spec: C, files: [f3], depends_on: [b]}
`,
      "/x",
    );
    const h = harness(p, () => true, undefined, false);
    const s = await runPlan(p, { parallel: 2 }, h.deps);
    expect(s.merged.sort()).toEqual(["a", "i"]);
    expect(s.blocked).toEqual(["b", "c"]);
    expect(s.stuck).toBe(true);
    expect(runExitCode(s)).toBe(3);
    expect(blockedMessage(s, "plan.yaml")).toBe("blocked: 2 parts wait on needs-decision items: unit u1; fix and re-run `pai plan run plan.yaml` (merged parts are skipped)");
    const end = h.log.filter((e) => e.event === "run-end");
    expect(end).toHaveLength(1);
    expect(end[0].status).toBe("blocked");
    expect(h.log.at(-1)?.event).toBe("run-end");
  });
  it("failures with nothing waiting exit 1, all merged exit 0", async () => {
    const p = plan();
    const bad = await runPlan(p, { parallel: 2 }, harness(p, (r) => r.part.id !== "d").deps);
    expect(bad.stuck).toBe(false);
    expect(runExitCode(bad)).toBe(1);
    const ok = await runPlan(p, { parallel: 2 }, harness(p).deps);
    expect(runExitCode(ok)).toBe(0);
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

describe("part isolation", () => {
  it("spawn args always carry --worktree and never --no-worktree", () => {
    const args = workerArgs({ part: { id: "a" }, label: "l", spec: "", provider: "anthropic", tier: "local", attempt: 1 } as unknown as StartRequest, "/tmp/s.txt", "/repo");
    expect(args).toContain("--worktree");
    expect(args).not.toContain("--no-worktree");
    expect(args).not.toContain("--no-pane");
  });

  it("a spawn refusal goes to needs-decision without retry and stops scheduling after the second identical refusal", async () => {
    const p = plan();
    const h = harness(p);
    const starts: string[] = [];
    h.deps.startWorker = async (r) => {
      starts.push(r.part.id);
      return { id: "", ok: false, spawnRefused: true, failure: "pai: --no-pane refused" };
    };
    const s = await runPlan(p, { parallel: 1 }, h.deps);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(s.needsDecision).toHaveLength(2);
    expect(s.spawnRefusal).toBe("pai: --no-pane refused");
  });

  it("a loop-stopped part is a failed attempt: retried, logged with reason loop, then needs-decision", async () => {
    const p = plan();
    const h = harness(p);
    const starts: string[] = [];
    h.deps.startWorker = async (r) => {
      starts.push(`${r.part.id}:${r.attempt}`);
      return { id: `w-${starts.length}`, ok: false, loopStopped: true, failure: "loop-stopped: Bash vitest repeated 7 times" };
    };
    const s = await runPlan(p, { parallel: 1 }, h.deps);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts[0].endsWith(":1") && starts[1].startsWith(starts[0].split(":")[0])).toBe(true);
    expect(s.merged).toHaveLength(0);
    expect(s.needsDecision.length).toBeGreaterThan(0);
    expect(h.log.some((e) => e.event === "part-end" && (e as { reason?: string }).reason === "loop")).toBe(true);
  });

  it("a status without a worktree is a problem", () => {
    expect(worktreeProblem({ id: "w1", worktreeDir: null })).toMatch(/no worktree/);
    expect(worktreeProblem({ id: "w1", worktreeDir: "/x" })).toBeNull();
  });

  it("a fatal worker outcome sends the part to needs-decision without a retry", async () => {
    const p = plan();
    const h = harness(p);
    const orig = h.deps.startWorker;
    h.deps.startWorker = async (r) => (r.part.id === "d" ? { id: "w-d", ok: false, fatal: true, failure: "no worktree" } : orig(r));
    await runPlan(p, { parallel: 2 }, h.deps);
    expect(h.log.filter((e) => e.event === "part-start" && e.part === "d")).toHaveLength(1);
    expect(h.log.some((e) => e.event === "needs-decision" && e.part === "d")).toBe(true);
    expect(h.merges).not.toContain("w-d");
  });

  it("a branch with only an empty commit counts no real commit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "pai-iso-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "1");
    git("add", "f");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    git("checkout", "-qb", "worker/w1");
    git("commit", "-q", "--allow-empty", "-m", "empty");
    expect(await realCommitsAhead(repo, base, "w1")).toBe(0);
    writeFileSync(join(repo, "f"), "2");
    git("commit", "-qam", "real");
    expect(await realCommitsAhead(repo, base, "w1")).toBe(1);
  });
});
