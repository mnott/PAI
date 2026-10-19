/**
 * plan-runner.ts — the scheduler behind `pai plan run`. No model involved.
 *
 * Keeps up to N parts running, starts a part once its dependencies are merged
 * and none of its files is in use by a running part, merges each finished part
 * with the plan gate, and walks the failure ladder: one local retry with the
 * failure tail, then needs-decision (or one Sonnet worker with --escalate).
 * Everything that touches workers, git or the clock goes through RunnerDeps.
 */

import { withRunLock, type LockDeps } from "./run-lock.js";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { gatePhaseName } from "./plan-status.js";
import { composeSpec, filesOverlap, type Plan, type PlanPart } from "./plan.js";

export interface WorkerOutcome {
  id: string;
  /** Worker ended with a valid report whose result is "+". */
  ok: boolean;
  /** Failure text (report why, open items, or the run's last output) when !ok. */
  failure?: string;
  tokens?: number | null;
  /** The part must not be retried (e.g. the worker had no worktree); it goes straight to needs-decision. */
  fatal?: boolean;
  /** `pai worker run` refused or failed before any worker existed (pane/gate/config): an environment error, never retried. */
  spawnRefused?: boolean;
  /** The loop guard stopped the worker: a failed attempt (retry ladder), never a pass. */
  loopStopped?: boolean;
  /** The worker's worktree, when it has one. */
  worktreeDir?: string;
  /** The worker's final message (its R report). */
  report?: string;
}

export interface StartRequest {
  part: PlanPart;
  label: string;
  spec: string;
  provider: string;
  /** "local" runs on plan.provider; "sonnet" is the escalation. */
  tier: "local" | "sonnet";
  attempt: number;
  /** Model for a local-tier worker (`pai worker run --model`); the sonnet tier names its own. */
  model?: string;
  /** "front": the worker goes ahead of the provider's waiting runs (`--now`). */
  priority?: "front";
}

export interface MergeOutcome {
  ok: boolean;
  commit?: string;
  /** HEAD before the merge; a merge that leaves HEAD here changed nothing. */
  before?: string;
  /** The worker branch carried no commit, so nothing was merged. */
  noCommit?: boolean;
  output: string;
}

/** What the gate reports while `worker merge --verify` runs it, one command at a time. */
export type GateEvent =
  | { ev: "gate-start"; commands: string[] }
  | { ev: "cmd-start"; i: number; cmd: string }
  | { ev: "cmd-end"; i: number; cmd: string; ms: number; ok: boolean; tail?: string }
  | { ev: "gate-end"; ok: boolean; ms: number }
  /** Refinement of the current phase, e.g. "gate: tests 214/2600". */
  | { ev: "progress"; text: string };

export interface RunnerDeps {
  startWorker(req: StartRequest): Promise<WorkerOutcome>;
  merge(workerId: string, gate: string, onGate?: (e: GateEvent) => void): Promise<MergeOutcome>;
  unitCheck(cmd: string): Promise<{ ok: boolean; output: string }>;
  now(): number;
  /** The provider a plan/queue value names: `local` becomes the running local server, any other name is returned unchanged. */
  resolveLocal(provider: string): Promise<string>;
  log(entry: RunLogEntry): void;
  /** The runner's current phase ("merging p1", "gate: tsc"), shown by ps, the cockpit and plan_status. */
  phase?(text: string, refine?: boolean): void;
  /** Parts merged so far / workers running now, for the status entry. */
  progress?(merged: number, running: string[]): void;
  /** A line for the plan pane's live log. */
  note?(line: string): void;
  /** Stop the workers this runner has started (SIGTERM/SIGINT path); resolves once they are told to end. */
  stopActive?(): Promise<void>;
}

export interface RunLogEntry {
  ts?: string;
  event: "run-start" | "run-end" | "unit-done" | "part-start" | "part-end" | "merge" | "gate-start" | "gate-end" | "escalate" | "needs-decision" | "unit-check" | "worker-start" | "worker-end" | "model-idle" | "overlap-continue";
  part?: string;
  unit?: string;
  worker?: string;
  attempt?: number;
  tier?: string;
  ok?: boolean;
  /** "no-commit" when the worker branch held no commit; the merge counts as not done. */
  status?: string;
  gate?: string;
  commit?: string;
  tokens?: number | null;
  note?: string;
  /** gate-start: the gate's commands; gate-end: each command's duration. */
  commands?: Array<{ cmd: string; ms?: number; ok?: boolean }>;
  /** gate-end: whole gate duration in ms; worker-end: the worker's run; model-idle: the gap. */
  ms?: number;
  /** worker-start/worker-end/model-idle: the provider the worker runs on. */
  provider?: string;
  /** model-idle: what the runner did meanwhile (gate, merge, unit-check, waiting-for-dependency); part-end: "loop". */
  reason?: string;
  /** part-start: the part started while an earlier part was still being gated. */
  overlap?: boolean;
  /** run-end: local model idle time, wall time and overlapped starts of the run. */
  idleMs?: number;
  wallMs?: number;
  overlaps?: number;
}

export type PartState = "waiting" | "running" | "merged" | "needs-decision";

export interface RunSummary {
  merged: string[];
  needsDecision: string[];
  /** Waiting parts that can never start because a dependency needs a decision. */
  blocked: string[];
  unitFailures: string[];
  /** Parts are waiting, nothing runs and nothing can start: `blockedOn` lists the needs-decision parts and failed units. */
  stuck: boolean;
  blockedOn: string[];
  escalations: number;
  /** The refusal that stopped scheduling (repeated identically), printed once. */
  spawnRefusal?: string;
  /** The run ended on a stop request (marker or signal); `interrupted` lists parts that were in flight. */
  stopped?: boolean;
  interrupted?: string[];
}

export interface RunOptions {
  parallel: number;
  escalate?: boolean;
  /** Model every local-tier worker of the run gets (default: the provider's). */
  model?: string;
  /** "front": every worker of the run goes ahead of the provider's waiting runs. */
  priority?: "front";
  /** Part ids already merged (from the log). */
  merged?: ReadonlySet<string>;
  /** Unit ids whose unit_check already passed. */
  unitsChecked?: ReadonlySet<string>;
  /** Lock file held for the duration of the run (one run per plan). */
  lockPath?: string;
  /** Stop marker (`pai plan stop`): checked before each new part; the run ends "stopped" once in-flight parts finish. */
  stopPath?: string;
  /** Lock/signal hooks, replaced by tests. */
  lockDeps?: LockDeps;
}

export const planStopPath = (planPath: string): string => `${planPath}.stop`;

export function requestPlanStop(planPath: string): void {
  writeFileSync(planStopPath(planPath), new Date().toISOString(), "utf8");
}

const TAIL_LINES = 40;
export const tail = (text: string, n = TAIL_LINES): string => text.trim().split("\n").slice(-n).join("\n");

/** Parts startable now: waiting, dependencies merged, no file clash with `busy` or each other, up to `slots`. */
export function pickStartable(
  parts: PlanPart[],
  state: ReadonlyMap<string, PartState>,
  busy: PlanPart[],
  slots: number,
): PlanPart[] {
  const picked: PlanPart[] = [];
  const active = [...busy];
  for (const p of parts) {
    if (picked.length >= slots) break;
    if (state.get(p.id) !== "waiting") continue;
    if (!p.dependsOn.every((d) => state.get(d) === "merged")) continue;
    if (active.some((a) => filesOverlap(a.files, p.files))) continue;
    picked.push(p);
    active.push(p);
  }
  return picked;
}

export function runPlan(plan: Plan, opts: RunOptions, deps: RunnerDeps): Promise<RunSummary> {
  const running = new Map<string, PlanPart>();
  let aborted = false;
  // once a signal arrived the killed workers' failures must not be logged, retried or merged: the parts restart on the next run
  const guarded: RunnerDeps = {
    ...deps,
    log: (e) => {
      if (!aborted) deps.log(e);
    },
    startWorker: (req) => (aborted ? new Promise<WorkerOutcome>(() => undefined) : deps.startWorker(req).then((o) => (aborted ? new Promise<WorkerOutcome>(() => undefined) : o))),
  };
  const onSignal = async (): Promise<void> => {
    aborted = true;
    const interrupted = [...running.keys()];
    await deps.stopActive?.();
    deps.log({ event: "run-end", ok: false, status: "stopped", note: `interrupted=${interrupted.join(",") || "none"}` });
  };
  return withRunLock(opts.lockPath, `plan ${plan.job}`, () => runPlanLocked(plan, opts, guarded, running), { ...opts.lockDeps, onSignal });
}

async function runPlanLocked(plan: Plan, opts: RunOptions, deps: RunnerDeps, active: Map<string, PlanPart>): Promise<RunSummary> {
  // `provider: local` in a plan means resolveLocalProvider() at run start —
  // the loopback server that answers, never a provider picked by name.
  plan = { ...plan, provider: await deps.resolveLocal(plan.provider) };
  const parts = plan.units.flatMap((u) => u.parts);
  const state = new Map<string, PartState>(parts.map((p) => [p.id, opts.merged?.has(p.id) ? "merged" : "waiting"]));
  const checked = new Set(opts.unitsChecked ?? []);
  const unitFailures: string[] = [];
  const failedParts = new Set<string>();
  let escalations = 0;
  const refusals = new Map<string, number>();
  let haltedBy: string | undefined;
  const running = new Map<string, { part: PlanPart; done: Promise<void> }>();
  let stopping = false;
  const stopRequested = (): boolean => !!opts.stopPath && existsSync(opts.stopPath);
  if (opts.stopPath) {
    try {
      unlinkSync(opts.stopPath); // a marker left from before this run is stale
    } catch {
      /* none */
    }
  }
  // merges and unit checks touch the checkout: one at a time
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = lock.then(fn, fn);
    lock = r.catch(() => undefined);
    return r;
  };

  // one worker at a time per provider slot count: `parallel` workers on a provider, never more
  const cap = opts.parallel;
  const activeWorkers = new Map<string, number>();
  const waiters: Array<{ provider: string; grant: () => void }> = [];
  const lastEnd = new Map<string, number>();
  const causes = new Map<string, string[]>();
  let idleTotal = 0;
  let overlaps = 0;
  const startedAt = deps.now();
  let wake: () => void = () => undefined;
  // parts whose worker ended but whose gate, merge or unit check is still going
  const postWorker = new Set<string>();
  // overlapped part -> the parts it overlapped (merge waits for them)
  const overlapOn = new Map<string, string[]>();
  const noteCause = (c: string): void => {
    for (const [prov, list] of causes) if ((activeWorkers.get(prov) ?? 0) === 0 && !list.includes(c)) list.push(c);
  };
  const workerBegin = (p: PlanPart, provider: string, tier: string, attempt: number): void => {
    const t = deps.now();
    if ((activeWorkers.get(provider) ?? 0) === 0 && lastEnd.has(provider)) {
      const ms = t - lastEnd.get(provider)!;
      const list = causes.get(provider) ?? [];
      const why = list.includes("gate") ? list.filter((c) => c !== "merge") : list;
      if (tier === "local") idleTotal += ms;
      deps.log({ event: "model-idle", part: p.id, unit: p.unit, provider, tier, ms, reason: why.join("+") || "waiting-for-dependency" });
    }
    causes.set(provider, []);
    activeWorkers.set(provider, (activeWorkers.get(provider) ?? 0) + 1);
    postWorker.delete(p.id);
    deps.log({ event: "worker-start", part: p.id, unit: p.unit, provider, tier, attempt });
  };
  const acquire = (p: PlanPart, provider: string, tier: string, attempt: number): Promise<void> => {
    if ((activeWorkers.get(provider) ?? 0) < cap) {
      workerBegin(p, provider, tier, attempt);
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push({ provider, grant: () => (workerBegin(p, provider, tier, attempt), resolve()) }));
  };
  const release = (p: PlanPart, provider: string): void => {
    activeWorkers.set(provider, (activeWorkers.get(provider) ?? 1) - 1);
    lastEnd.set(provider, deps.now());
    causes.set(provider, []);
    postWorker.add(p.id);
    const i = waiters.findIndex((w) => w.provider === provider);
    if (i >= 0 && (activeWorkers.get(provider) ?? 0) < cap) waiters.splice(i, 1)[0].grant();
    wake();
  };

  const progress = (): void => deps.progress?.([...state.values()].filter((v) => v === "merged").length, [...running.keys()]);

  const label = (p: PlanPart) => `${plan.job}: ${p.unit} ${p.id}`;

  const checkUnit = async (unitId: string): Promise<void> => {
    const unit = plan.units.find((u) => u.id === unitId)!;
    if (checked.has(unitId) || !unit.parts.every((p) => state.get(p.id) === "merged")) return;
    checked.add(unitId);
    if (!unit.unitCheck) {
      deps.log({ event: "unit-done", unit: unitId });
      return;
    }
    const r = await exclusive(() => {
      noteCause("unit-check");
      deps.phase?.(`unit check ${unitId}`);
      return deps.unitCheck(unit.unitCheck!);
    });
    deps.log({ event: "unit-check", unit: unitId, ok: r.ok, note: r.ok ? undefined : tail(r.output, 10) });
    if (r.ok) deps.log({ event: "unit-done", unit: unitId });
    if (!r.ok) {
      unitFailures.push(unitId);
      // parts that depend on a unit whose check failed wait for a decision
      for (const up of unit.parts) failedParts.add(up.id);
      deps.log({ event: "needs-decision", unit: unitId, note: `unit_check failed: ${tail(r.output, 10)}` });
    }
  };

  const attemptPart = async (p: PlanPart): Promise<void> => {
    const ladder: Array<{ tier: "local" | "sonnet"; provider: string }> = [
      { tier: "local", provider: plan.provider },
      { tier: "local", provider: plan.provider },
      ...(opts.escalate ? [{ tier: "sonnet" as const, provider: "anthropic" }] : []),
    ];
    let failure: string | undefined;
    for (let i = 0; i < ladder.length; i++) {
      const { tier, provider } = ladder[i];
      if (tier === "sonnet") {
        escalations++;
        deps.log({ event: "escalate", part: p.id, unit: p.unit, attempt: i + 1, tier, note: tail(failure ?? "", 10) });
      }
      deps.log({ event: "part-start", part: p.id, unit: p.unit, attempt: i + 1, tier, ...(overlapOn.has(p.id) && i === 0 ? { overlap: true } : {}) });
      deps.phase?.(`starting ${p.id}`);
      const granted = acquire(p, provider, tier, i + 1);
      const wstart = deps.now();
      await granted;
      let out: WorkerOutcome;
      try {
        out = await deps.startWorker({ part: p, label: label(p), spec: composeSpec(p, failure, plan.job, plan.repo), provider, tier, attempt: i + 1, ...(tier === "local" && opts.model ? { model: opts.model } : {}), ...(opts.priority ? { priority: opts.priority } : {}) });
      } finally {
        release(p, provider);
      }
      deps.log({ event: "worker-end", part: p.id, unit: p.unit, worker: out.id, provider, tier, attempt: i + 1, ok: out.ok, ms: deps.now() - wstart });
      deps.note?.(`${p.id} worker ${out.id || "-"} ${out.ok ? "finished ok" : "failed"}${out.ok ? "" : `: ${tail(out.failure ?? "", 4)}`}`);
      deps.log({ event: "part-end", part: p.id, unit: p.unit, worker: out.id, attempt: i + 1, tier, ok: out.ok, ...(out.loopStopped ? { reason: "loop" } : {}), tokens: out.tokens ?? null, note: out.ok ? undefined : tail(out.failure ?? "", 10) });
      if (!out.ok && out.spawnRefused) {
        failure = out.failure || "worker spawn refused";
        const n = (refusals.get(failure) ?? 0) + 1;
        refusals.set(failure, n);
        if (n >= 2) haltedBy = failure;
        break;
      }
      if (!out.ok && out.fatal) {
        failure = out.failure || "the worker could not be isolated";
        break;
      }
      if (!out.ok) {
        failure = out.failure || "the worker ended without a valid passing report";
        continue;
      }
      const gateObserver = (): ((e: GateEvent) => void) => {
        let cmds: Array<{ cmd: string; ms?: number; ok?: boolean }> = [];
        return (e) => {
          if (e.ev === "gate-start") {
            cmds = e.commands.map((cmd) => ({ cmd }));
            noteCause("gate");
            deps.log({ event: "gate-start", part: p.id, unit: p.unit, worker: out.id, gate: plan.gate, commands: cmds });
          } else if (e.ev === "cmd-start") {
            deps.phase?.(`gate: ${gatePhaseName(e.cmd)}`);
            deps.note?.(`gate command ${e.i + 1}/${cmds.length || "?"}: ${e.cmd}`);
          } else if (e.ev === "cmd-end") {
            cmds[e.i] = { cmd: e.cmd, ms: e.ms, ok: e.ok };
            deps.note?.(`gate command ${e.i + 1} ${e.ok ? "ok" : "FAILED"} in ${(e.ms / 1000).toFixed(1)}s${e.tail ? `\n${e.tail}` : ""}`);
          } else if (e.ev === "gate-end") {
            deps.log({ event: "gate-end", part: p.id, unit: p.unit, worker: out.id, ok: e.ok, ms: e.ms, commands: cmds });
          } else deps.phase?.(e.text, true);
        };
      };
      // an overlapped part merges only after the parts it overlapped are through (merged, or out with a decision)
      const gated = (overlapOn.get(p.id) ?? []).map((id) => running.get(id)?.done).filter((d): d is Promise<void> => !!d);
      if (gated.length) await Promise.all(gated);
      let m = await exclusive(() => {
        noteCause("merge");
        deps.phase?.(`merging ${p.id}`);
        return deps.merge(out.id, plan.gate, gateObserver());
      });
      // a "merge" that moved nothing is not a merge: the worker never committed
      if (m.ok && (m.noCommit || !m.commit || m.commit === m.before)) m = { ...m, ok: false, noCommit: true };
      deps.log({ event: "merge", part: p.id, unit: p.unit, worker: out.id, attempt: i + 1, ok: m.ok, ...(m.noCommit ? { status: "no-commit" } : {}), gate: plan.gate, ...(m.noCommit ? {} : { commit: m.commit }), note: m.ok ? undefined : tail(m.output, 10) });
      deps.note?.(`${p.id} ${m.ok ? "merged" : "merge failed"}${m.commit ? ` ${m.commit.slice(0, 7)}` : ""}${m.ok ? "" : `\n${tail(m.output, 8)}`}`);
      if (m.ok) {
        state.set(p.id, "merged");
        progress();
        await checkUnit(p.unit);
        return;
      }
      failure = m.noCommit
        ? `no-commit: the worker branch has no commit, nothing was merged. Git add the files you changed, then commit on the current branch (message "${label(p)}") and edit files only by relative path inside your worktree.${m.output.trim() ? `\n${tail(m.output, 10)}` : ""}`
        : `gate failed (${plan.gate}):\n${tail(m.output)}`;
    }
    state.set(p.id, "needs-decision");
    deps.log({ event: "needs-decision", part: p.id, unit: p.unit, note: tail(failure ?? "", 10) });
    for (const [q, over] of overlapOn) {
      if (over.includes(p.id) && running.has(q)) deps.log({ event: "overlap-continue", part: q, unit: p.unit, note: `${p.id} failed its gate; ${q} is independent of it and keeps running` });
    }
  };

  const idleFields = (): Pick<RunLogEntry, "idleMs" | "wallMs" | "overlaps"> => ({ idleMs: idleTotal, wallMs: deps.now() - startedAt, overlaps });
  deps.log({ event: "run-start", note: `parallel=${opts.parallel}${opts.escalate ? " escalate=sonnet" : ""}` });
  // a resumed run may have units complete but unchecked (killed between merge and check)
  for (const u of plan.units) await checkUnit(u.id);
  for (;;) {
    if (!stopping && stopRequested()) stopping = true;
    const launch = (p: PlanPart): void => {
      state.set(p.id, "running");
      // started while earlier parts are past their worker (gate, merge, unit check): an overlap
      const over = [...postWorker].filter((id) => running.has(id));
      if (p.overlap && over.length) {
        overlapOn.set(p.id, over);
        overlaps++;
      }
      const done = attemptPart(p).finally(() => {
        running.delete(p.id);
        active.delete(p.id);
        postWorker.delete(p.id);
        overlapOn.delete(p.id);
        progress();
      });
      running.set(p.id, { part: p, done });
      active.set(p.id, p);
      progress();
    };
    if (!haltedBy && !stopping) {
      const eligible = parts.filter((p) => !p.dependsOn.some((d) => failedParts.has(d)));
      for (const p of pickStartable(eligible, state, [...running.values()].map((r) => r.part), opts.parallel - running.size)) launch(p);
      // an orchestrator-marked part, once every part before it has started, may start once the workers of the running parts have ended, though their gate is still going
      const workers = [...activeWorkers.values()].reduce((a, b) => a + b, 0);
      const free = opts.parallel - workers;
      if (free > 0) {
        for (const p of pickStartable(eligible.filter((q) => q.overlap && parts.slice(0, parts.indexOf(q)).every((e) => state.get(e.id) !== "waiting")), state, [...running.values()].map((r) => r.part), free)) launch(p);
      }
    }
    if (running.size === 0) break;
    const woken = new Promise<void>((r) => (wake = r));
    await Promise.race([woken, ...[...running.values()].map((r) => r.done)]);
  }
  if (stopping && opts.stopPath) {
    try {
      unlinkSync(opts.stopPath);
    } catch {
      /* already gone */
    }
  }
  const waiting = parts.filter((p) => state.get(p.id) === "waiting").map((p) => p.id);
  const summary: RunSummary = {
    merged: parts.filter((p) => state.get(p.id) === "merged").map((p) => p.id),
    needsDecision: parts.filter((p) => state.get(p.id) === "needs-decision").map((p) => p.id),
    blocked: waiting,
    unitFailures,
    stuck: !haltedBy && !stopping && waiting.length > 0,
    blockedOn: [...parts.filter((p) => state.get(p.id) === "needs-decision").map((p) => p.id), ...unitFailures.map((u) => `unit ${u}`)],
    escalations,
    ...(haltedBy ? { spawnRefusal: haltedBy } : {}),
    ...(stopping ? { stopped: true } : {}),
  };
  if (stopping) {
    deps.log({ event: "run-end", ok: false, status: "stopped", note: `stop requested; merged=${summary.merged.length} waiting=${waiting.length}`, ...idleFields() });
    return summary;
  }
  deps.log({ event: "run-end", ok: !summary.needsDecision.length && !waiting.length && !unitFailures.length, ...(summary.stuck ? { status: "blocked" } : {}), note: `merged=${summary.merged.length} needs-decision=${summary.needsDecision.length} blocked=${waiting.length}`, ...idleFields() });
  return summary;
}

/** Exit code of `pai plan run`: 0 all merged, 4 stopped by `pai plan stop`, 1 failures with everything else done, 3 blocked (parts left that cannot start). */
export function runExitCode(s: RunSummary): number {
  if (s.stopped) return 4;
  if (s.stuck) return 3;
  return s.needsDecision.length || s.blocked.length || s.unitFailures.length ? 1 : 0;
}

export function blockedMessage(s: RunSummary, planPath: string): string {
  return `blocked: ${s.blocked.length} parts wait on needs-decision items: ${s.blockedOn.join(", ") || "none"}; fix and re-run \`pai plan run ${planPath}\` (merged parts are skipped)`;
}

/** The schedule a run would execute, assuming every part succeeds: waves of at most `parallel` parts. */
export function dryRunSchedule(plan: Plan, opts: RunOptions): PlanPart[][] {
  const parts = plan.units.flatMap((u) => u.parts);
  const state = new Map<string, PartState>(parts.map((p) => [p.id, opts.merged?.has(p.id) ? "merged" : "waiting"]));
  const waves: PlanPart[][] = [];
  for (;;) {
    const wave = pickStartable(parts, state, [], opts.parallel);
    if (!wave.length) break;
    waves.push(wave);
    for (const p of wave) state.set(p.id, "merged");
  }
  return waves;
}

export function renderSchedule(plan: Plan, opts: RunOptions): string {
  const waves = dryRunSchedule(plan, opts);
  const lines = [`job ${plan.job}: ${plan.units.flatMap((u) => u.parts).length} parts, provider ${plan.provider}, ${opts.parallel} at a time, gate: ${plan.gate}`];
  waves.forEach((w, i) => {
    lines.push(`step ${i + 1}:`);
    for (const p of w) lines.push(`  ${p.unit} ${p.id}${p.risky ? " [risky]" : ""}${p.dependsOn.length ? `  after ${p.dependsOn.join(", ")}` : ""}${p.files.length ? `  files ${p.files.join(", ")}` : ""}`);
  });
  const left = plan.units.flatMap((u) => u.parts).filter((p) => !opts.merged?.has(p.id) && !waves.flat().includes(p));
  if (left.length) lines.push(`never scheduled: ${left.map((p) => p.id).join(", ")}`);
  for (const u of plan.units) if (u.unitCheck && !opts.unitsChecked?.has(u.id)) lines.push(`after unit ${u.id}: ${u.unitCheck}`);
  if (opts.merged?.size) lines.push(`skipped (already merged): ${[...opts.merged].join(", ")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// run log

export function readRunLog(path: string): RunLogEntry[] {
  if (!existsSync(path)) return [];
  const out: RunLogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as RunLogEntry);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export function appendRunLog(path: string, entry: RunLogEntry, now: () => number = Date.now): void {
  appendFileSync(path, JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }) + "\n", "utf8");
}

/** What a resumed run skips: merged parts and units whose check passed. */
export function resumeState(log: RunLogEntry[]): { merged: Set<string>; unitsChecked: Set<string> } {
  const merged = new Set<string>();
  const unitsChecked = new Set<string>();
  for (const e of log) {
    if (e.event === "merge" && e.ok && e.part) merged.add(e.part);
    if (e.event === "unit-check" && e.ok && e.unit) unitsChecked.add(e.unit);
  }
  return { merged, unitsChecked };
}

export interface PlanStatus {
  done: string[];
  running: string[];
  waiting: string[];
  needsDecision: string[];
  tokens: number;
  wallMs: number;
  /** Local model idle time between workers (sum of model-idle events) and parts that started overlapped. */
  idleMs: number;
  overlaps: number;
}

/** Summarise the log against the plan's parts. `now` closes an unfinished run segment. */
export function planStatus(plan: Plan, log: RunLogEntry[], now: number): PlanStatus {
  const last = new Map<string, RunLogEntry>();
  let tokens = 0;
  let idleMs = 0;
  let overlaps = 0;
  let wallMs = 0;
  let segStart: number | null = null;
  let lastTs = 0;
  for (const e of log) {
    const t = e.ts ? Date.parse(e.ts) : 0;
    lastTs = t || lastTs;
    if (e.event === "run-start") segStart = t;
    if (e.event === "run-end" && segStart !== null) {
      wallMs += t - segStart;
      segStart = null;
    }
    if (e.part && ["part-start", "part-end", "merge", "needs-decision"].includes(e.event)) last.set(e.part, e);
    if (e.event === "model-idle" && e.tier === "local" && typeof e.ms === "number") idleMs += e.ms;
    if (e.event === "part-start" && e.overlap) overlaps++;
    if (e.event === "part-end" && typeof e.tokens === "number") tokens += e.tokens;
  }
  // an open segment is a run in progress when the log is fresh, else a run that died: count up to its last entry
  if (segStart !== null) wallMs += (now - lastTs < 120_000 ? now : lastTs) - segStart;
  const s: PlanStatus = { done: [], running: [], waiting: [], needsDecision: [], tokens, wallMs, idleMs, overlaps };
  const runActive = segStart !== null && now - lastTs < 120_000;
  for (const p of plan.units.flatMap((u) => u.parts)) {
    const e = last.get(p.id);
    if (e?.event === "merge" && e.ok) s.done.push(p.id);
    else if (e?.event === "needs-decision") s.needsDecision.push(p.id);
    else if (e?.event === "part-start" && runActive) s.running.push(p.id);
    else s.waiting.push(p.id);
  }
  return s;
}

/** "local model idle 1m02s of 7m24s (14%), 2 overlapped starts". */
export function idleText(idleMs: number, wallMs: number, overlaps: number): string {
  const f = (ms: number): string => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };
  const pct = wallMs > 0 ? Math.round((idleMs / wallMs) * 100) : 0;
  return `local model idle ${f(idleMs)} of ${f(wallMs)} (${pct}%), ${overlaps} overlapped ${overlaps === 1 ? "start" : "starts"}`;
}

export function renderStatus(plan: Plan, st: PlanStatus): string {
  const fmt = (ids: string[]) => (ids.length ? `${ids.length} (${ids.join(", ")})` : "0");
  const secs = Math.round(st.wallMs / 1000);
  return [
    `job ${plan.job}`,
    `done           ${fmt(st.done)}`,
    `running        ${fmt(st.running)}`,
    `waiting        ${fmt(st.waiting)}`,
    `needs-decision ${fmt(st.needsDecision)}`,
    `wall so far    ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s, tokens ${st.tokens}`,
    idleText(st.idleMs, st.wallMs, st.overlaps),
  ].join("\n");
}
