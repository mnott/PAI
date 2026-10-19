/**
 * `pai plan`: the scripted runner. Behaviour lives in src/workers/plan*.ts;
 * this file declares names, flags and help.
 */

import { existsSync } from "node:fs";
import { CliError, type CommandDef, type RunContext } from "../define.js";
import { getProviderOrNative, readWorkersSection } from "../../workers/config.js";
import { workersLogDir } from "../../workers/paths.js";
import { dirtyConflicts, loadPlan, PlanError, runLogPath, type Plan } from "../../workers/plan.js";
import { dirtyPaths, pai, realRunnerDeps } from "../../workers/plan-deps.js";
import { PlanReporter } from "../../workers/run-events.js";
import { finishDetached, reportOrigin, runMessenger, startDetached } from "../../workers/run-report-wiring.js";
import { resolve } from "node:path";
import type { RunLogEntry } from "../../workers/plan-runner.js";
import { blockedMessage, planStatus, runExitCode, readRunLog, renderSchedule, renderStatus, resumeState, runPlan } from "../../workers/plan-runner.js";
import { resolveCap } from "../../workers/capacity.js";
import { isLocalProvider } from "../../workers/policy.js";

const out = (s: string) => process.stdout.write(s + "\n");

function load(path: string): Plan {
  if (!existsSync(path)) throw new CliError(`no such plan file: ${path}`, "pai plan validate PLAN.yaml");
  try {
    return loadPlan(path);
  } catch (e) {
    if (e instanceof PlanError) throw new CliError(`${path} is not a valid plan:\n  ${e.problems.join("\n  ")}`, "docs/plan-runner.md describes the plan file");
    throw e;
  }
}

function parallelOf(plan: Plan, flag: unknown): number {
  if (typeof flag === "number") return Math.max(1, Math.floor(flag));
  if (plan.maxParallel) return plan.maxParallel;
  try {
    const p = getProviderOrNative(readWorkersSection().workers, plan.provider);
    return resolveCap(p?.maxConcurrent, p ? isLocalProvider(p.baseUrl) : true) ?? 3;
  } catch {
    return 3;
  }
}

const planArg = [{ name: "PLAN", summary: "Plan file (YAML)", required: true }];

const runCmd: CommandDef = {
  name: "run",
  summary: "Run a plan: local workers in parallel, merged with the plan's gate",
  description:
    "Runs the parts of a plan on the local provider, no model in the loop: up to N parts at once, a part starts when its dependencies are merged and no running part shares a file, each finished part is merged with `pai worker merge --verify GATE`; a part whose worker branch holds no commit counts as no-commit, not merged, and goes down the failure ladder. The run is refused when the repo has uncommitted changes to files a part touches (--allow-dirty overrides). A failed part gets one local retry with the failure output appended, then is marked needs-decision while independent parts continue (with --escalate sonnet, one Sonnet worker runs instead). Progress is appended to PLAN.run.jsonl; running the same plan again skips merged parts. Exit codes: 0 all parts merged, 1 failures (needs-decision parts or failed unit checks) with everything else done, 3 blocked: nothing runs and every remaining part waits on a needs-decision item, so the run ends at once with a `blocked:` summary (run-end status blocked).",
  args: planArg,
  options: [
    { name: "parallel", type: "number", value: "N", summary: "Parts running at once (default: max_parallel of the plan, else the provider's maxConcurrent)" },
    { name: "escalate", type: "string", value: "TIER", summary: "After the local retry, run one worker on TIER (only sonnet) instead of stopping at needs-decision" },
    { name: "detach", type: "boolean", summary: "Hand the run to a detached process that outlives this session and reports its events back to it" },
    { name: "dry-run", type: "boolean", summary: "Print the schedule that would run; start nothing" },
    { name: "allow-dirty", type: "boolean", summary: "Run although the repo has uncommitted changes to files a part touches" },
  ],
  examples: ["pai plan run plan.yaml", "pai plan run plan.yaml --detach", "pai plan run plan.yaml --dry-run", "pai plan run plan.yaml --parallel 2 --escalate sonnet"],
  seeAlso: ["pai plan validate", "pai plan status", "pai worker merge"],
  run: async (ctx: RunContext) => {
    const path = String(ctx.args.PLAN);
    const plan = load(path);
    const esc = ctx.opts.escalate;
    if (esc !== undefined && esc !== "sonnet") throw new CliError(`--escalate takes sonnet, not ${String(esc)}`, "pai plan run PLAN.yaml --escalate sonnet");
    const log = runLogPath(path);
    const { merged, unitsChecked } = resumeState(readRunLog(log));
    const opts = { parallel: parallelOf(plan, ctx.opts.parallel), escalate: esc === "sonnet", merged, unitsChecked };
    if (ctx.opts["dry-run"] === true || ctx.dryRun) {
      out(renderSchedule(plan, opts));
      return 0;
    }
    if (ctx.opts["allow-dirty"] !== true) {
      const clash = dirtyConflicts(plan, await dirtyPaths(plan.repo));
      if (clash.length) throw new CliError(`${plan.repo} has uncommitted changes to files the plan touches: ${clash.join(", ")}. A run would clobber or mix them in.`, "commit or stash them, or pass --allow-dirty");
    }
    const logDir = workersLogDir(readWorkersSection().workers);
    const origin = reportOrigin();
    if (ctx.opts.detach === true) {
      const rec = startDetached(logDir, { kind: "plan", label: plan.job, positional: [resolve(path)], opts: ctx.opts, cwd: process.cwd(), origin });
      out(`detached: ${rec.id} (pid ${rec.pid}); progress in ${log}, output in ${rec.output}; ${origin ? "events go to the starting session" : "no originating session found, events are not delivered"}`);
      return 0;
    }
    const reporter = origin ? new PlanReporter(plan.job, plan.units.flatMap((u) => u.parts).length, runMessenger(logDir), origin) : null;
    const real = realRunnerDeps(plan, logDir, log);
    const deps = reporter ? { ...real, log: (e: RunLogEntry) => { real.log(e); reporter.onLog(e); } } : real;
    const s = await runPlan(plan, opts, deps);
    await reporter?.flush();
    finishDetached(logDir);
    out(`merged ${s.merged.length}/${plan.units.flatMap((u) => u.parts).length}; needs-decision: ${s.needsDecision.join(", ") || "none"}; blocked: ${s.blocked.join(", ") || "none"}; unit checks failed: ${s.unitFailures.join(", ") || "none"}; escalations: ${s.escalations}`);
    if (s.spawnRefusal) out(`spawn refused, scheduling stopped: ${s.spawnRefusal}`);
    if (s.stuck) out(blockedMessage(s, path));
    return runExitCode(s);
  },
};

const validateCmd: CommandDef = {
  name: "validate",
  summary: "Check a plan file and list its parts",
  description: "Parses the plan and checks ids, dependencies (unknown parts, cycles), spec files and required fields. Exit 1 lists every problem.",
  args: planArg,
  examples: ["pai plan validate plan.yaml"],
  seeAlso: ["pai plan run"],
  run: (ctx: RunContext) => {
    const plan = load(String(ctx.args.PLAN));
    const n = plan.units.flatMap((u) => u.parts).length;
    for (const w of plan.warnings) out(`warning: ${w}`);
    out(`ok: job ${plan.job}, ${plan.units.length} units, ${n} parts, provider ${plan.provider}, ${parallelOf(plan, undefined)} at a time`);
    return 0;
  },
};

const statusCmd: CommandDef = {
  name: "status",
  summary: "Summarise a plan's run log: done, running, waiting, needs-decision",
  description: "Reads PLAN.run.jsonl and prints the parts per state, the tokens booked by finished workers and the wall time so far.",
  args: planArg,
  examples: ["pai plan status plan.yaml"],
  seeAlso: ["pai plan run"],
  run: (ctx: RunContext) => {
    const path = String(ctx.args.PLAN);
    const plan = load(path);
    out(renderStatus(plan, planStatus(plan, readRunLog(runLogPath(path)), Date.now())));
    return 0;
  },
};

export const planCommand: CommandDef = {
  name: "plan",
  summary: "Run a planned job on local workers without a model in the loop",
  description: "The scripted runner: a YAML plan of units and parts is executed by a loop that starts local workers, merges them with a gate and retries or flags failures. See docs/plan-runner.md.",
  examples: ["pai plan validate plan.yaml", "pai plan run plan.yaml --dry-run", "pai plan status plan.yaml"],
  subcommands: [runCmd, validateCmd, statusCmd],
};
