/**
 * `pai bench`: local-model quality check. Behaviour lives in src/bench; the harness scripts and task data in bench/.
 */

import { join } from "node:path";
import { CliError, OPT, type CommandDef } from "../define.js";
import { benchRun, defaultBenchDir, SET_NAMES } from "../../bench/run.js";
import { parseRow, renderTable } from "../../bench/table.js";

const num = (v: unknown, name: string, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`--${name} must be a number >= 0`, "pai bench run --help");
  return n;
};

const DIR_OPT = { name: "results", type: "string", value: "DIR", summary: "Results root (default: $PAI_BENCH_DIR or ~/.cache/pai/bench); never inside the repo" } as const;

export const benchCommand: CommandDef = {
  name: "bench",
  summary: "Local-model quality check: run the eval sets and real tasks, print the comparison table",
  description:
    "Runs the model-eval harness in bench/ against one provider and tabulates the results. Short, easy and hard are sets of small tasks graded by the harness; real tasks are PAI fixes done in throwaway clones and judged by hidden tests. Results and worker logs go under the results root, never into the repo.",
  examples: ["pai bench run --provider gyro-m --reps 3 --real 2", "pai bench table --keys gyro-m,gyro-l:gyro-coder-l --ref sonnet:anthropic"],
  subcommands: [
    {
      name: "run",
      summary: "Run the sets for one provider under a watchdog",
      description:
        "Runs the sets one after another (local models serve one run at a time) through bench/evalset.sh and bench/realset.sh. Routing is pinned to the provider, escalation and quota retry are off, so a run never falls back to a cloud model. A watchdog watches the worker transcripts and stops the series, logging why, on REWRITE (an answer file written 15 times, see --max-writes), RUNAWAY (more than 60 distinct answer files in one run) or IDLE (no worker activity for --idle seconds, not counting the `pai power wait` between runs). Real tasks are capped per task. Between runs `pai power wait` is called when that command exists. The series log is <results>/series-<key>.log. At the end the series prints the rule summary for the provider's model: firings per anti-pattern in this run, and a suggested `pai antipatterns set ... --model` line per behaviour pattern that fired 5 or more times (stop_at = the observed 90th percentile per run, never below the shipped default). Nothing is applied automatically.",
      options: [
        { ...OPT.provider, summary: "Provider under test (required)" },
        { name: "sets", type: "string", value: "LIST", default: SET_NAMES.join(","), summary: "Comma list of short, easy, hard" },
        { name: "reps", type: "number", value: "N", default: 1, summary: "Reps per set" },
        { name: "real", type: "number", value: "N", default: 0, summary: "Reps of the 5 real PAI tasks (0 = skip)" },
        { name: "key", type: "string", value: "K", summary: "Results key (default: the provider)" },
        { name: "tools", type: "string", value: "LIST", default: "Read,Write", summary: "Tools of the eval-set runs (comma list, or 'real' = the tools a production worker gets, so the model can run code and check answers); real tasks always get the production tools" },
        { name: "real-cap", type: "number", value: "MIN", default: 30, summary: "Minutes one real task may run" },
        { name: "idle", type: "number", value: "SEC", default: 900, summary: "Stop the series after this many seconds without worker activity" },
        { name: "max-writes", type: "number", value: "N", default: 15, summary: "Stop the series when one answer file is written this many times" },
        DIR_OPT,
      ],
      examples: ["pai bench run --provider gyro-m", "pai bench run --provider gyro-m --sets easy,hard --reps 3 --real 2 --key gyro-m-night"],
      run: async (ctx) => {
        const provider = ctx.opts.provider;
        if (typeof provider !== "string" || !provider) throw new CliError("--provider is required", "pai bench run --provider NAME");
        const sets = String(ctx.opts.sets ?? SET_NAMES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
        const bad = sets.filter((s) => !(SET_NAMES as readonly string[]).includes(s));
        if (bad.length || !sets.length) throw new CliError(`unknown set: ${bad.join(",") || "(none)"}; use ${SET_NAMES.join(", ")}`, "pai bench run --help");
        const opts = {
          provider,
          sets,
          reps: num(ctx.opts.reps, "reps", 1),
          real: num(ctx.opts.real, "real", 0),
          tools: typeof ctx.opts.tools === "string" && ctx.opts.tools ? ctx.opts.tools : undefined,
          key: typeof ctx.opts.key === "string" && ctx.opts.key ? ctx.opts.key : provider,
          dir: typeof ctx.opts.results === "string" ? ctx.opts.results : defaultBenchDir(),
          realCapMin: num(ctx.opts["real-cap"], "real-cap", 30),
          idleSec: num(ctx.opts.idle, "idle", 900),
          maxWrites: num(ctx.opts["max-writes"], "max-writes", 15),
          out: (l: string) => void process.stdout.write(l + "\n"),
        };
        if (ctx.dryRun) {
          const { planRuns } = await import("../../bench/run.js");
          for (const r of planRuns(opts)) opts.out(`${join("bench", r.script)} ${r.args.join(" ")}`);
          return 0;
        }
        return benchRun(opts);
      },
    },
    {
      name: "table",
      summary: "Print the comparison table (markdown) from the results",
      description:
        "Counts a run only if its route line, its ending provider and its single worker id all name the model. Loop-stopped and killed runs count for pass % but not for time; real tasks over 900 s are left out of s/task. Each entry is KEY, KEY:PROVIDER or NAME=KEY:PROVIDER (provider defaults to the key). --ref adds cloud reference rows from results of the same layout.",
      options: [
        { name: "keys", type: "string", value: "LIST", summary: "Comma list of local results keys (default: every key found)" },
        { name: "ref", type: "string", value: "LIST", summary: "Comma list of cloud reference keys" },
        DIR_OPT,
      ],
      examples: ["pai bench table", "pai bench table --keys gyro-m,gyro-l:gyro-coder-l --ref sonnet:anthropic,opus:anthropic"],
      run: async (ctx) => {
        const dir = typeof ctx.opts.results === "string" ? ctx.opts.results : defaultBenchDir();
        const list = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
        let keys = list(ctx.opts.keys);
        if (!keys.length) {
          const { readdirSync, existsSync } = await import("node:fs");
          const found = new Set<string>();
          for (const s of [...SET_NAMES, "real"]) {
            const d = join(dir, "results", s);
            if (existsSync(d)) readdirSync(d, { withFileTypes: true }).forEach((e) => e.isDirectory() && found.add(e.name));
          }
          keys = [...found].sort();
        }
        const rows = [...keys.map((k) => parseRow(k, "local")), ...list(ctx.opts.ref).map((k) => parseRow(k, "cloud"))];
        if (!rows.length) throw new CliError(`no results under ${dir}`, "pai bench run --help");
        process.stdout.write(renderTable(dir, rows));
        return 0;
      },
    },
  ],
};
