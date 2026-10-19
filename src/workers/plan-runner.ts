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

export interface RunnerDeps {
  startWorker(req: StartRequest): Promise<WorkerOutcome>;
  merge(workerId: string, gate: string): Promise<MergeOutcome>;
  unitCheck(cmd: string): Promise<{ ok: boolean; output: string }>;
  now(): number;
  /** The provider a plan/queue value names: `local` becomes the running local server, any other name is returned unchanged. */
  resolveLocal(provider: string): Promise<string>;
  log(entry: RunLogEntry): void;
  /** Stop the workers this runner has started (SIGTERM/SIGINT path); resolves once they are told to end. */
  stopActive?(): Promise<void>;
}

export interface RunLogEntry {
  ts?: string;
  event: "run-start" | "run-end" | "unit-done" | "part-start" | "part-end" | "merge" | "escalate" | "needs-decision" | "unit-check";
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

  const label = (p: PlanPart) => `${plan.job}: ${p.unit} ${p.id}`;

  const checkUnit = async (unitId: string): Promise<void> => {
    const unit = plan.units.find((u) => u.id === unitId)!;
    if (checked.has(unitId) || !unit.parts.every((p) => state.get(p.id) === "merged")) return;
    checked.add(unitId);
    if (!unit.unitCheck) {
      deps.log({ event: "unit-done", unit: unitId });
      return;
    }
    const r = await exclusive(() => deps.unitCheck(unit.unitCheck!));
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
      deps.log({ event: "part-start", part: p.id, unit: p.unit, attempt: i + 1, tier });
      const out = await deps.startWorker({ part: p, label: label(p), spec: composeSpec(p, failure, plan.job, plan.repo), provider, tier, attempt: i + 1 });
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
      let m = await exclusive(() => deps.merge(out.id, plan.gate));
      // a "merge" that moved nothing is not a merge: the worker never committed
      if (m.ok && (m.noCommit || !m.commit || m.commit === m.before)) m = { ...m, ok: false, noCommit: true };
      deps.log({ event: "merge", part: p.id, unit: p.unit, worker: out.id, attempt: i + 1, ok: m.ok, ...(m.noCommit ? { status: "no-commit" } : {}), gate: plan.gate, ...(m.noCommit ? {} : { commit: m.commit }), note: m.ok ? undefined : tail(m.output, 10) });
      if (m.ok) {
        state.set(p.id, "merged");
        await checkUnit(p.unit);
        return;
      }
      failure = m.noCommit
        ? `no-commit: the worker branch has no commit, nothing was merged. Git add the files you changed, then commit on the current branch (message "${label(p)}") and edit files only by relative path inside your worktree.${m.output.trim() ? `\n${tail(m.output, 10)}` : ""}`
        : `gate failed (${plan.gate}):\n${tail(m.output)}`;
    }
    state.set(p.id, "needs-decision");
    deps.log({ event: "needs-decision", part: p.id, unit: p.unit, note: tail(failure ?? "", 10) });
  };

  deps.log({ event: "run-start", note: `parallel=${opts.parallel}${opts.escalate ? " escalate=sonnet" : ""}` });
  // a resumed run may have units complete but unchecked (killed between merge and check)
  for (const u of plan.units) await checkUnit(u.id);
  for (;;) {
    const busy = [...running.values()].map((r) => r.part);
    if (!stopping && stopRequested()) stopping = true;
    for (const p of haltedBy || stopping ? [] : pickStartable(parts.filter((p) => !p.dependsOn.some((d) => failedParts.has(d))), state, busy, opts.parallel - running.size)) {
      state.set(p.id, "running");
      const done = attemptPart(p).finally(() => {
        running.delete(p.id);
        active.delete(p.id);
      });
      running.set(p.id, { part: p, done });
      active.set(p.id, p);
    }
    if (running.size === 0) break;
    await Promise.race([...running.values()].map((r) => r.done));
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
    deps.log({ event: "run-end", ok: false, status: "stopped", note: `stop requested; merged=${summary.merged.length} waiting=${waiting.length}` });
    return summary;
  }
  deps.log({ event: "run-end", ok: !summary.needsDecision.length && !waiting.length && !unitFailures.length, ...(summary.stuck ? { status: "blocked" } : {}), note: `merged=${summary.merged.length} needs-decision=${summary.needsDecision.length} blocked=${waiting.length}` });
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
}

/** Summarise the log against the plan's parts. `now` closes an unfinished run segment. */
export function planStatus(plan: Plan, log: RunLogEntry[], now: number): PlanStatus {
  const last = new Map<string, RunLogEntry>();
  let tokens = 0;
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
    if (e.event === "part-end" && typeof e.tokens === "number") tokens += e.tokens;
  }
  // an open segment is a run in progress when the log is fresh, else a run that died: count up to its last entry
  if (segStart !== null) wallMs += (now - lastTs < 120_000 ? now : lastTs) - segStart;
  const s: PlanStatus = { done: [], running: [], waiting: [], needsDecision: [], tokens, wallMs };
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
  ].join("\n");
}
