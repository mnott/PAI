/**
 * plan-deps.ts — the real RunnerDeps of `pai plan run`: workers, merges and
 * checks are the existing `pai worker run` / `pai worker merge` verbs, run as
 * child processes of this same binary (PAI_BIN, else `pai`).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerReport } from "./report.js";
import { eventsPath } from "./paths.js";
import { loadStatuses } from "./status.js";
import { killTree } from "./kill-tree.js";
import { sumRunUsage } from "./usage.js";
import { headlessAllowed, openVerifiedPane, realPaneOps, resolveHostSession } from "./pane.js";
import { readWorkersSection } from "./config.js";
import { GATE_MARK } from "./worktree.js";
import { PlanTracker, gatePhaseName } from "./plan-status.js";
import { appendRunLog, tail, type GateEvent, type MergeOutcome, type RunnerDeps, type StartRequest, type WorkerOutcome } from "./plan-runner.js";
import type { Plan } from "./plan.js";
import { resolveRunnerProvider } from "./local-provider.js";

export interface Captured {
  code: number | null;
  out: string;
  err: string;
}

export function capture(cmd: string, args: string[], cwd: string, shell = false, onData?: (chunk: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env, shell });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      onData?.(String(d));
    });
    child.stderr.on("data", (d) => {
      err += d;
      onData?.(String(d));
    });
    child.on("error", (e) => resolve({ code: 1, out, err: err + e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

export const pai = (): string => process.env.PAI_BIN || "pai";

/** Tokens a finished worker used, from its run log; null when unavailable. */
function workerTokens(logDir: string, id: string): number | null {
  try {
    const sum = sumRunUsage(readFileSync(eventsPath(logDir, id), "utf8"));
    let n = 0;
    for (const t of sum.byModel.values()) n += t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.output;
    return n || null;
  } catch {
    return null;
  }
}

/** Paths with uncommitted changes in the plan's repo (`git status --porcelain`). */
export async function dirtyPaths(repo: string): Promise<string[]> {
  const r = await capture("git", ["status", "--porcelain"], repo);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
}

/** Args of the part worker: `--worktree` is explicit so the caller's own mode is never inherited. */
export function workerArgs(req: Pick<StartRequest, "label" | "provider" | "tier" | "model" | "priority">, specFile: string, repo: string): string[] {
  const model = req.tier === "sonnet" ? "sonnet" : req.model;
  return ["worker", "run", "--provider", req.provider, "--class", "implement", ...(model ? ["--model", model] : []), ...(req.priority ? ["--now"] : []), "--label", req.label, "--spec", specFile, "--cwd", repo, "--worktree", "--output-format", "json"];
}

/** State of the plan checkout: HEAD and the dirty-path listing. */
export interface CheckoutState {
  head: string;
  dirty: string;
}

export async function checkoutState(repo: string): Promise<CheckoutState> {
  const head = (await capture("git", ["rev-parse", "HEAD"], repo)).out.trim();
  const dirty = (await capture("git", ["status", "--porcelain"], repo)).out;
  return { head, dirty };
}

/** Tests the last successful gate counted, per repo: the denominator of the next run's progress. */
export const lastTests = new Map<string, number>();

/** HEADs the runner's own merges produced, per repo: a moved HEAD that is one of them is not a worker edit. */
const mergedHeads = new Map<string, Set<string>>();

/** Error text when the plan checkout changed during a part other than by the runner's merges; null when untouched. */
export function checkoutProblem(id: string, before: CheckoutState, after: CheckoutState, merged: ReadonlySet<string> = new Set()): string | null {
  const headMoved = after.head !== before.head && !merged.has(after.head);
  if (!headMoved && after.dirty === before.dirty) return null;
  return `worker ${id} changed the plan's checkout (${headMoved ? `HEAD ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}` : "working tree"})`;
}

/** Commits on worker/<id> beyond `base` that change something (empty commits do not count). */
export async function realCommitsAhead(repo: string, base: string, id: string): Promise<number> {
  const revs = (await capture("git", ["rev-list", "--no-merges", `${base}..worker/${id}`], repo)).out.split("\n").filter(Boolean);
  let n = 0;
  for (const sha of revs) if ((await capture("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repo)).out.trim()) n++;
  return n;
}

/** Workers this process launched and is waiting on. */
const launched = new Set<{ label: string; t0: number }>();

/** Stop every worker this process launched and still waits on, the way `pai worker kill` does (kill-tree). */
export async function stopLaunchedWorkers(logDir: string, kill: typeof killTree = killTree): Promise<string[]> {
  const stopped: string[] = [];
  for (const l of launched) {
    for (const s of loadStatuses(logDir)) {
      if (s.label !== l.label || (s.state !== "running" && s.state !== "queued") || Date.parse(s.started) < l.t0) continue;
      try {
        await kill(logDir, s.id);
        stopped.push(s.id);
      } catch {
        /* already gone */
      }
    }
  }
  return stopped;
}

/** Run one worker as `pai worker run` and read its outcome: spawn refusal, plan-checkout and report checks included. */
export async function launchWorker(req: Pick<StartRequest, "label" | "provider" | "tier" | "model" | "priority">, specFile: string, repo: string, logDir: string, planPane?: string, planPart?: string): Promise<WorkerOutcome> {
  const t0 = Date.now() - 1000;
  const before = await checkoutState(repo);
  const mark = { label: req.label, t0 };
  launched.add(mark);
  const r = await capture(pai(), workerArgs(req, specFile, repo), repo, false, undefined, planPane ? { ...process.env, PAI_PLAN_PANE: planPane, ...(planPart ? { PAI_PLAN_PART: planPart } : {}) } : process.env).finally(() => launched.delete(mark));
  const st = loadStatuses(logDir)
    .filter((s) => s.label === req.label && Date.parse(s.started) >= t0)
    .sort((a, b) => b.started.localeCompare(a.started))[0];
  if (!st) return { id: "", ok: false, spawnRefused: true, failure: tail(r.err || r.out) || `worker did not start (exit ${r.code})` };
  const problem = checkoutProblem(st.id, before, await checkoutState(repo), mergedHeads.get(repo));
  if (problem) return { id: st.id, ok: false, fatal: true, failure: problem };
  let text = "";
  try {
    text = (JSON.parse(r.out) as { result?: string }).result ?? "";
  } catch {
    text = r.out;
  }
  const report = parseWorkerReport(text);
  const passed = !!report && (report.result ? report.result === "+" : (report.checks ?? []).every((c) => c.ok !== false));
  const ok = st.state === "done" && (st.rc ?? 0) === 0 && passed;
  const failure = ok ? undefined : !report ? `worker ended without a valid report (${st.state}): ${tail(text || r.err, 15)}` : [report.why, ...(report.open ?? []), report.notes].filter(Boolean).join("\n") || `report result ${report.result ?? "?"}`;
  return { id: st.id, ok, failure, ...(st.loopStopped ? { loopStopped: true } : {}), tokens: workerTokens(logDir, st.id), worktreeDir: st.worktreeDir ?? undefined, report: text };
}

/**
 * Reads the merge child's output as it arrives: gate marker lines become GateEvents (and leave the
 * output), the rest is kept as a per-command tail; vitest's "(N tests)" lines turn into a
 * "gate: tests 214/2600" progress when the denominator is known.
 */
export class GateParser {
  private buf = "";
  private lines: string[] = [];
  private tests = 0;
  private name = "";
  /** Output of the merge without the marker lines. */
  clean = "";
  /** Tests counted over the whole gate. */
  total = 0;

  constructor(private on: (e: GateEvent) => void, private testTotal?: number, private phaseName: (cmd: string) => string = gatePhaseName) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let at: number;
    while ((at = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, at));
      this.buf = this.buf.slice(at + 1);
    }
  }

  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }

  private line(l: string): void {
    const m = l.indexOf(GATE_MARK);
    if (m >= 0) {
      try {
        let e = JSON.parse(l.slice(m + GATE_MARK.length)) as GateEvent;
        if (e.ev === "cmd-start") {
          this.lines = [];
          this.tests = 0;
          this.name = this.phaseName(e.cmd);
        }
        if (e.ev === "cmd-end") {
          this.total += this.tests;
          e = { ...e, tail: tail(this.lines.join("\n"), e.ok ? 6 : 25) };
        }
        this.on(e);
        return;
      } catch {
        /* not ours: keep as output */
      }
    }
    this.clean += l + "\n";
    this.lines.push(l);
    if (this.lines.length > 200) this.lines.shift();
    const t = /\((\d+) tests?\b/.exec(l);
    if (t && this.name === "tests") {
      this.tests += Number(t[1]);
      this.on({ ev: "progress", text: `gate: tests ${this.tests}${this.testTotal ? `/${this.testTotal}` : ""}` });
    }
  }
}

/** Merge worker/<id> into `repo`'s checkout with `pai worker merge` (--verify when a gate is given); an empty branch is refused. */
export async function mergeBranch(repo: string, id: string, gate: string, onGate?: (e: GateEvent) => void, testTotal?: number): Promise<MergeOutcome> {
  const rev = async (...a: string[]) => (await capture("git", a, repo)).out.trim();
  const before = await rev("rev-parse", "HEAD");
  const ahead = await realCommitsAhead(repo, before, id);
  if (!(ahead > 0)) return { ok: false, noCommit: true, before, output: `branch worker/${id} has no non-empty commit beyond ${before.slice(0, 7)}` };
  const parser = onGate ? new GateParser(onGate, testTotal) : null;
  const r = await capture(pai(), ["worker", "merge", id, ...(gate ? ["--verify", gate] : [])], repo, false, parser ? (c) => parser.feed(c) : undefined, parser ? { ...process.env, PAI_GATE_EVENTS: "1" } : process.env);
  parser?.end();
  if (parser?.total) lastTests.set(repo, parser.total);
  const output = parser ? parser.clean : r.out + r.err;
  if (r.code !== 0) return { ok: false, before, output };
  const head = await rev("rev-parse", "HEAD");
  if (head) mergedHeads.set(repo, (mergedHeads.get(repo) ?? new Set()).add(head));
  return { ok: true, commit: head || undefined, before, output };
}

/**
 * The plan's one pane for its whole life (split, else tab; never a window): its workers open none, `follow` shows
 * their live transcripts in it: `pai worker follow plan-<job>` streams the live log. A pane that cannot open is
 * logged and the run goes on; its workers' own fail-closed gate still applies.
 */
export async function openPlanPane(logDir: string, tracker: PlanTracker, open: typeof openVerifiedPane = openVerifiedPane, host: () => Promise<{ term: string }> = resolveHostSession): Promise<boolean> {
  if (headlessAllowed()) return false;
  try {
    const term = (await host()).term;
    tracker.log(`plan pane: ${await open(logDir, readWorkersSection().workers, tracker.id, term, process.env, realPaneOps, { noWindow: true })}`);
    tracker.hasPane = true;
    return true;
  } catch (e) {
    tracker.log(`plan pane not opened: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export function realRunnerDeps(plan: Plan, logDir: string, logPath: string, tracker?: PlanTracker): RunnerDeps {
  const dir = mkdtempSync(join(tmpdir(), "pai-plan-"));
  return {
    now: Date.now,
    log: (e) => appendRunLog(logPath, e),
    ...(tracker
      ? {
          phase: (t: string, refine?: boolean) => (refine ? tracker.progress(t) : tracker.phase(t)),
          progress: (merged: number, running: string[]) => {
            tracker.merged(merged);
            tracker.setRunning(running);
          },
          note: (l: string) => tracker.log(l),
        }
      : {}),
    async startWorker(req: StartRequest): Promise<WorkerOutcome> {
      const specFile = join(dir, `${req.part.id}-${req.attempt}.txt`);
      writeFileSync(specFile, req.spec, "utf8");
      const t0 = Date.now() - 1000;
      const watch = tracker
        ? setInterval(() => {
            const st = loadStatuses(logDir).find((s) => s.label === req.label && Date.parse(s.started) >= t0);
            if (!st) return;
            tracker.setWorker(req.part.id, st.id);
            tracker.phase(`running ${req.part.id} (${st.id})`);
            clearInterval(watch);
          }, 1500)
        : undefined;
      try {
        return await launchWorker(req, specFile, plan.repo, logDir, tracker?.hasPane ? tracker.id : undefined, req.part.id);
      } finally {
        if (watch) clearInterval(watch);
      }
    },
    merge: async (id: string, gate: string, onGate?: (e: GateEvent) => void) => {
      const r = await mergeBranch(plan.repo, id, gate, onGate, tracker?.testTotal);
      if (r.ok) tracker?.setTestTotal(lastTests.get(plan.repo) ?? 0);
      return r;
    },
    resolveLocal: resolveRunnerProvider,
    stopActive: async () => {
      tracker?.end("stopped");
      void (await stopLaunchedWorkers(logDir));
    },
    async unitCheck(cmd: string) {
      const r = await capture(cmd, [], plan.repo, true);
      return { ok: r.code === 0, output: r.out + r.err };
    },
  };
}
