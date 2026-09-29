/**
 * planner.ts — the plan class: plan, spawn, integrate.
 *
 * `pai worker run --class plan -p "<goal>"` does not run one worker but a
 * small orchestration:
 *
 *   1. a planner worker (the plan class's provider) reads the repository and
 *      writes `<logDir>/plans/<planner id>.json` — 5–50 sub-tasks, fewer only
 *      when the goal itself names a smaller count, each with title, brief,
 *      class, files and acceptance;
 *   2. the runner validates the plan and spawns the sub-tasks as children of
 *      the planner worker (`parent` = the planner id, so `ps` shows the
 *      tree), at most `workers.tree.maxChildren` at a time;
 *   3. each child that finishes delivers its structured report to the
 *      planner's inbox as a `kind: "result"` handoff (see handoff.ts);
 *   4. the run finishes with a summary report and the branches to merge.
 *
 * The planner's prompt carries the prompt rules from the self-driving
 * codebases write-up: domain-specific instructions only, constraints over
 * step lists, explicit quantity ranges, no checkbox style.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkersSection } from "./config.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath, workersLogDir } from "./paths.js";
import { loadStatus, newWorkerId } from "./status.js";
import { parseRunnerArgs, shortText } from "./args.js";
import { swapPromptArg } from "./chain.js";
import { runWorker, printResult, type RunOptions, type StreamEvent } from "./run.js";
import { git, mergeWorker } from "./worktree.js";
import type { WorkerReport } from "./report.js";

/** Where a planner run's plan file lives: <logDir>/plans/<planner id>.json. */
export function planPathFor(logDir: string, plannerId: string): string {
  return join(logDir, "plans", `${plannerId}.json`);
}

export interface PlannerTask {
  title: string;
  brief: string;
  /** Task class of the child (implement, research, …); default implement. */
  class?: string;
  /** Files the sub-task likely touches. */
  files?: string[];
  /** How to tell the sub-task is done. */
  acceptance?: string[];
}

export const MIN_TASKS = 5;
export const MAX_TASKS = 50;

/**
 * Validate a raw plan file into its tasks. Accepts 1–MAX_TASKS tasks: the
 * prompt asks for MIN_TASKS–MAX_TASKS, but a goal may itself name a smaller
 * explicit count ("one sub-task per file" with three files), and that
 * explicit range wins. Everything else — missing file, damaged JSON, tasks
 * without a title or brief — throws with a message the operator can act on.
 */
export function validatePlan(raw: unknown): PlannerTask[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("plan file must be a JSON object");
  }
  const tasksRaw = (raw as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksRaw)) throw new Error('plan file needs a "tasks" array');
  if (tasksRaw.length < 1) throw new Error("plan file has no tasks");
  if (tasksRaw.length > MAX_TASKS) {
    throw new Error(`plan file has ${tasksRaw.length} tasks; the maximum is ${MAX_TASKS}`);
  }
  const tasks: PlannerTask[] = [];
  for (let i = 0; i < tasksRaw.length; i++) {
    const t = tasksRaw[i];
    if (typeof t !== "object" || t === null || Array.isArray(t)) {
      throw new Error(`task ${i + 1} must be an object`);
    }
    const o = t as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const brief = typeof o.brief === "string" ? o.brief.trim() : "";
    if (!title) throw new Error(`task ${i + 1} needs a non-empty "title"`);
    if (!brief) throw new Error(`task ${i + 1} needs a non-empty "brief"`);
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    const files = strArr(o.files);
    const acceptance = strArr(o.acceptance);
    tasks.push({
      title,
      brief,
      ...(typeof o.class === "string" && o.class.trim() ? { class: o.class.trim() } : {}),
      ...(files?.length ? { files } : {}),
      ...(acceptance?.length ? { acceptance } : {}),
    });
  }
  return tasks;
}

/** The planner worker's instructions, goal and prompt rules included. */
export function plannerPrompt(goal: string, planFile: string, maxChildren: number): string {
  return [
    "You are a PLANNER worker. Turn the goal below into a plan file and stop —",
    "you do not implement anything, and you do not spawn workers yourself:",
    "the runner executes your plan on your behalf (the sub-tasks run as your",
    "children and report back to you).",
    "",
    `Write the plan with the Write tool to ${planFile} as one JSON object:`,
    '{"tasks":[{"title":"…","brief":"…","class":"implement","files":["…"],"acceptance":["…"]}]}',
    "",
    "Prompt rules for the plan itself (they are yours too):",
    "- Domain-specific instructions only: name real files, commands and",
    "  constraints of this repository, never generic advice.",
    "- Constraints over step lists: state what must hold (and what must not",
    "  change), not a numbered procedure to follow.",
    "- Explicit quantity ranges: how many, how much, how long — never",
    '  "several", "some", "as needed".',
    "- No checkbox style: no `[ ]` items, no step numbering theatre.",
    "",
    `Emit between ${MIN_TASKS} and ${MAX_TASKS} sub-tasks — unless the goal itself`,
    'names a smaller explicit count ("one sub-task per file" with three files',
    "means three); an explicit count in the goal always wins.",
    `At most ${maxChildren} of them run at a time, so independent tasks are better`,
    "than long chains. Each task's class picks its provider: implement, draft,",
    "review, research, spotcheck, simple, complex, image.",
    "",
    "Read the repository first (Glob/Grep/Read) so tasks name real files.",
    "Every sub-task runs in its own worktree of the same repository: name files",
    "relative to the repository root and never an absolute path or a worktree",
    "directory in a title, brief, files or acceptance entry.",
    "",
    "## Goal",
    "",
    goal,
  ].join("\n");
}

/** The child's prompt for one planned sub-task. */
export function taskPrompt(goal: string, task: PlannerTask, index: number, of: number): string {
  return [
    `You are sub-task ${index + 1} of ${of} of a planned goal. Do exactly this sub-task;`,
    "the other sub-tasks are other workers' business.",
    "",
    `# ${task.title}`,
    "",
    task.brief,
    ...(task.files?.length ? ["", "Files likely touched: " + task.files.join(", ")] : []),
    ...(task.acceptance?.length
      ? ["", "Done means:", ...task.acceptance.map((a) => `- ${a}`)]
      : []),
    "",
    "## The overall goal (context only — your scope is the sub-task above)",
    "",
    goal,
  ].join("\n");
}

export interface PlannerDeps {
  /** Stage runner; tests inject a mock, production uses runWorker. */
  runStage?: (opts: RunOptions) => Promise<number>;
  /** logDir override for tests. */
  logDir?: string;
  /** maxChildren override for tests. */
  maxChildren?: number;
}

/**
 * The planner orchestration; returns the process exit code. The planner id is
 * minted here and preset on the phase-1 run, so the plan file's name is known
 * before the worker starts and the prompt can name its exact path.
 */
export async function runPlanner(opts: RunOptions, deps: PlannerDeps = {}): Promise<number> {
  const runStage = deps.runStage ?? runWorker;
  const { workers: config } = readWorkersSection();
  const logDir = deps.logDir ?? workersLogDir(config);
  const maxChildren = deps.maxChildren ?? config.tree.maxChildren;
  const parsed = parseRunnerArgs(opts.claudeArgs);
  const goal = parsed.prompt ?? "";
  const plannerId = newWorkerId();
  const planFile = planPathFor(logDir, plannerId);
  mkdirSync(join(logDir, "plans"), { recursive: true });

  // --- phase 1: the planner worker writes the plan file
  process.stderr.write(`planner ${plannerId}: writing plan (${planFile})\n`);
  const rc1 = await runStage({
    ...opts,
    id: plannerId,
    claudeArgs: swapPromptArg(opts.claudeArgs, plannerPrompt(goal, planFile, maxChildren)),
    quiet: true,
    _planner: true,
  });
  if (rc1 !== 0) return rc1;
  if (!existsSync(planFile)) {
    process.stderr.write(
      `planner ${plannerId}: no plan file at ${planFile} — the planner worker did not write one. ` +
        `Re-run, or write the plan yourself and run the tasks with pai worker run.\n`
    );
    appendLedger(ledgerPath(logDir), "WORKER-PLAN-END", { planner: plannerId, rc: 1, failed: "plan" });
    return 1;
  }
  let tasks: PlannerTask[];
  try {
    tasks = validatePlan(JSON.parse(readFileSync(planFile, "utf8")));
  } catch (e) {
    process.stderr.write(`planner ${plannerId}: invalid plan file ${planFile}: ${(e as Error).message}\n`);
    appendLedger(ledgerPath(logDir), "WORKER-PLAN-END", { planner: plannerId, rc: 1, failed: "plan" });
    return 1;
  }
  appendLedger(ledgerPath(logDir), "WORKER-PLAN", {
    planner: plannerId,
    tasks: tasks.length,
    plan: planFile,
  });

  // --- phase 2: run the sub-tasks as children, maxChildren at a time. Each
  // child is spawned in the planner's own worktree (when it got one) rather
  // than the operator's cwd, so its branch is created off the planner's own
  // HEAD and can later be merged straight into it.
  const plannerStatus = loadStatus(logDir, plannerId);
  const plannerWorktreeDir = plannerStatus?.worktreeDir ?? null;
  const results: { task: PlannerTask; rc: number; id: string }[] = [];
  for (let i = 0; i < tasks.length; i += maxChildren) {
    const wave = tasks.slice(i, i + maxChildren);
    process.stderr.write(
      `planner ${plannerId}: sub-tasks ${i + 1}–${i + wave.length} of ${tasks.length}\n`
    );
    const waveIds: string[] = new Array(wave.length).fill("");
    const rcs = await Promise.all(
      wave.map((task, w) =>
        runStage({
          className: task.class ?? "implement",
          providerFlag: opts.providerFlag,
          modelFlag: opts.modelFlag,
          label: shortText(task.title, 40),
          noPane: opts.noPane,
          mcpFlag: opts.mcpFlag,
          claudeArgs: swapPromptArg(opts.claudeArgs, taskPrompt(goal, task, i + w, tasks.length)),
          cwd: plannerWorktreeDir ?? opts.cwd,
          worktreeFlag: opts.worktreeFlag,
          parent: plannerId,
          quiet: true,
          onWorkerStart: (wid) => {
            waveIds[w] = wid;
          },
        })
      )
    );
    for (let w = 0; w < wave.length; w++) results.push({ task: wave[w], rc: rcs[w], id: waveIds[w] });
  }

  // --- phase 3: the planner merges each finished child's branch into its
  // OWN worktree branch, in spawn order — never into the operator's checkout
  // — reusing `pai worker merge`'s own logic (mergeWorker). A conflicting
  // merge is aborted cleanly so the planner's branch stays clean and the
  // next child still gets a try; the child's branch is left intact either way.
  const merged: string[] = [];
  const conflicted: { id: string; branch: string; paths: string[] }[] = [];
  if (plannerWorktreeDir) {
    for (const r of results) {
      if (r.rc !== 0 || !r.id) continue;
      const st = loadStatus(logDir, r.id);
      if (!st?.branch) continue; // ran in place, or no worktree: nothing to merge
      try {
        mergeWorker(logDir, r.id);
        merged.push(r.id);
      } catch {
        let paths: string[] = [];
        try {
          git(plannerWorktreeDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
          paths = git(plannerWorktreeDir, ["diff", "--name-only", "--diff-filter=U"])
            .split("\n")
            .filter(Boolean);
          git(plannerWorktreeDir, ["merge", "--abort"]);
        } catch {
          // no merge was left in progress: the failure was not a conflict
        }
        conflicted.push({ id: r.id, branch: st.branch, paths });
      }
    }
  }

  // --- phase 4: summary from the children's statuses and inbox handoffs
  const failed = results.filter((r) => r.rc !== 0).length;
  appendLedger(ledgerPath(logDir), "WORKER-PLAN-END", {
    planner: plannerId,
    rc: failed || conflicted.length ? 1 : 0,
    failed,
    merged: merged.length,
    conflicted: conflicted.length,
  });
  printPlannerSummary(logDir, plannerId, results, merged, conflicted, parsed.outputFormat, opts.quiet === true);
  return failed || conflicted.length ? 1 : 0;
}

/** Compose and print the planner's summary report (text or json). */
function printPlannerSummary(
  logDir: string,
  plannerId: string,
  results: { task: PlannerTask; rc: number; id: string }[],
  merged: string[],
  conflicted: { id: string; branch: string; paths: string[] }[],
  fmt: "text" | "json" | "stream-json",
  quiet: boolean
): void {
  const ok = results.filter((r) => r.rc === 0).length;
  const attempted = new Set([...merged, ...conflicted.map((c) => c.id)]);
  // a branch never attempted (no planner worktree to merge into) still needs
  // the old "go merge me by hand" hint
  const stillOpen: { id: string; branch: string }[] = [];
  for (const r of results) {
    if (r.rc !== 0 || !r.id || attempted.has(r.id)) continue;
    const st = loadStatus(logDir, r.id);
    if (st?.branch && !st.merged) stillOpen.push({ id: r.id, branch: st.branch });
  }
  const report: WorkerReport = {
    checks: results.map((r) => ({
      name: r.task.title,
      ok: r.rc === 0,
      detail: r.rc === 0 ? shortText(r.id ? loadStatus(logDir, r.id)?.last : "", 80) : `rc=${r.rc}`,
    })),
    ...(merged.length || conflicted.length || stillOpen.length
      ? {
          open: [
            ...merged.map((id) => `merged: ${id}`),
            ...conflicted.map(
              (c) =>
                `conflict: pai worker merge ${c.id} (${c.branch})` +
                (c.paths.length ? ` — ${c.paths.join(", ")}` : "")
            ),
            ...stillOpen.map((c) => `branch to merge: pai worker merge ${c.id} (${c.branch})`),
          ],
        }
      : {}),
    notes:
      `${ok}/${results.length} sub-tasks ok` +
      (merged.length ? `; ${merged.length} merged` : "") +
      (conflicted.length ? `; ${conflicted.length} conflict(s)` : "") +
      (stillOpen.length ? `; ${stillOpen.length} branch(es) to merge` : ""),
  };
  if (quiet || fmt === "stream-json") return;
  const allOk = ok === results.length && conflicted.length === 0;
  const resultEvent: StreamEvent = {
    type: "result",
    result: [
      `planner ${plannerId}: ${report.notes}`,
      ...(conflicted.length ? ["conflicts:"] : []),
      ...conflicted.map(
        (c) =>
          `  pai worker merge ${c.id}   # ${c.branch}, conflicting: ${c.paths.join(", ") || "unknown"}`
      ),
      ...(stillOpen.length ? ["branches to merge:"] : []),
      ...stillOpen.map((c) => `  pai worker merge ${c.id}   # ${c.branch}`),
    ].join("\n"),
    is_error: !allOk,
  };
  printResult(fmt, resultEvent, allOk ? 0 : 1, logDir, plannerId, report, {
    plan: results.length,
    ...(merged.length ? { mergedBranches: merged } : {}),
    ...(conflicted.length ? { conflictedBranches: conflicted.map((c) => c.branch) } : {}),
    ...(stillOpen.length ? { branches: stillOpen.map((c) => c.branch) } : {}),
  });
}
