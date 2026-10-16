/**
 * `pai worker bench` — A/B a model on a project's real-task suite. The suite supplies run.sh and grade.sh.
 */

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Command } from "commander";
import { PROMPTS, aggregate, planArms, readSuiteRows, runBench, suiteTasks, writeResults, type Prompt } from "../../../workers/bench.js";
import { err } from "../../utils.js";

interface Opts {
  suite: string;
  providers?: string;
  tasks?: string;
  prompt: string;
  repeat: string;
  maxParallel: string;
  maxLoad: string;
  dryRun?: boolean;
  report?: boolean;
}

export function registerWorkerBenchCommand(workerCmd: Command): void {
  workerCmd
    .command("bench")
    .description(
      "A/B providers on a suite of real tasks: per task × provider × repeat run the suite's run.sh, then grade.sh;\n" +
        "prints pass/total, median wall and turns per provider × prompt and writes <suite>/results.md.\n" +
        "Providers are passed explicitly per arm (a measurement ignores `pai worker policy`)."
    )
    .requiredOption("--suite <dir>", "Suite directory with run.sh, grade.sh and tasks/<name>/")
    .option("--providers <list>", "Comma-separated providers, e.g. anthropic,local30")
    .option("--tasks <list>", "Comma-separated task names (default: all)")
    .option("--prompt <kind>", `Prompt file kind: ${PROMPTS.join("|")}`, "task")
    .option("--repeat <n>", "Runs per task × provider", "1")
    .option("--max-parallel <n>", "Arms running at once", "3")
    .option("--max-load <n>", "Start no arm while the 1-minute load average is above this", "60")
    .option("--dry-run", "Print the arm plan only")
    .option("--report", "Aggregate the suite's existing rows.tsv into results.md; run nothing")
    .action(async (o: Opts) => {
      try {
        const suite = resolve(o.suite);
        if (o.report) {
          const rows = readSuiteRows(suite);
          console.log(aggregate(rows));
          console.log(writeResults(suite, rows));
          return;
        }
        if (!PROMPTS.includes(o.prompt as Prompt)) throw new Error(`--prompt must be one of ${PROMPTS.join(", ")}`);
        if (!o.providers) throw new Error("--providers is required");
        for (const f of ["run.sh", "grade.sh"]) if (!existsSync(join(suite, f))) throw new Error(`${suite}/${f} missing`);
        const all = suiteTasks(suite);
        const tasks = o.tasks ? o.tasks.split(",") : all;
        const unknown = tasks.filter((t) => !all.includes(t));
        if (unknown.length) throw new Error(`unknown task(s): ${unknown.join(", ")}`);
        const arms = planArms(tasks, o.providers.split(","), o.prompt as Prompt, Math.max(1, Number(o.repeat) || 1));
        console.log(`${arms.length} arm(s), prompt ${o.prompt}, max ${o.maxParallel} parallel, load gate ${o.maxLoad}`);
        if (o.dryRun) {
          for (const a of arms) console.log(`${a.task}\t${a.provider}\t${a.prompt}\t#${a.repeat}`);
          return;
        }
        const rows = await runBench({ suite, arms, maxParallel: Number(o.maxParallel), maxLoad: Number(o.maxLoad), log: (s) => console.log(s) });
        console.log(aggregate(rows));
        console.log(writeResults(suite, rows));
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
      }
    });
}
