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
import { appendRunLog, tail, type MergeOutcome, type RunnerDeps, type StartRequest, type WorkerOutcome } from "./plan-runner.js";
import type { Plan } from "./plan.js";
import { resolveRunnerProvider } from "./local-provider.js";

export interface Captured {
  code: number | null;
  out: string;
  err: string;
}

export function capture(cmd: string, args: string[], cwd: string, shell = false): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, shell });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
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
      if (s.label !== l.label || s.state !== "running" || Date.parse(s.started) < l.t0) continue;
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
export async function launchWorker(req: Pick<StartRequest, "label" | "provider" | "tier" | "model" | "priority">, specFile: string, repo: string, logDir: string): Promise<WorkerOutcome> {
  const t0 = Date.now() - 1000;
  const before = await checkoutState(repo);
  const mark = { label: req.label, t0 };
  launched.add(mark);
  const r = await capture(pai(), workerArgs(req, specFile, repo), repo).finally(() => launched.delete(mark));
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

/** Merge worker/<id> into `repo`'s checkout with `pai worker merge` (--verify when a gate is given); an empty branch is refused. */
export async function mergeBranch(repo: string, id: string, gate: string): Promise<MergeOutcome> {
  const rev = async (...a: string[]) => (await capture("git", a, repo)).out.trim();
  const before = await rev("rev-parse", "HEAD");
  const ahead = await realCommitsAhead(repo, before, id);
  if (!(ahead > 0)) return { ok: false, noCommit: true, before, output: `branch worker/${id} has no non-empty commit beyond ${before.slice(0, 7)}` };
  const r = await capture(pai(), ["worker", "merge", id, ...(gate ? ["--verify", gate] : [])], repo);
  const output = r.out + r.err;
  if (r.code !== 0) return { ok: false, before, output };
  const head = await rev("rev-parse", "HEAD");
  if (head) mergedHeads.set(repo, (mergedHeads.get(repo) ?? new Set()).add(head));
  return { ok: true, commit: head || undefined, before, output };
}

export function realRunnerDeps(plan: Plan, logDir: string, logPath: string): RunnerDeps {
  const dir = mkdtempSync(join(tmpdir(), "pai-plan-"));
  return {
    now: Date.now,
    log: (e) => appendRunLog(logPath, e),
    async startWorker(req: StartRequest): Promise<WorkerOutcome> {
      const specFile = join(dir, `${req.part.id}-${req.attempt}.txt`);
      writeFileSync(specFile, req.spec, "utf8");
      return launchWorker(req, specFile, plan.repo, logDir);
    },
    merge: (id: string, gate: string) => mergeBranch(plan.repo, id, gate),
    resolveLocal: resolveRunnerProvider,
    stopActive: async () => void (await stopLaunchedWorkers(logDir)),
    async unitCheck(cmd: string) {
      const r = await capture(cmd, [], plan.repo, true);
      return { ok: r.code === 0, output: r.out + r.err };
    },
  };
}
