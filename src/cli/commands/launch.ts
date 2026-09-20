/**
 * `pai launch` — start the Claude Code harness on any provider/model
 * configured in workers.yaml, in the current terminal.
 *
 * Claude Code's own `/model` picker only ever shows the models of whatever
 * endpoint the CURRENT process was started against (base URL + auth are
 * fixed for the life of the process) — started plainly it lists Anthropic
 * models, started through a provider's base URL it lists that provider's.
 * This command is the one place that turns "start on <provider>[/<model>]"
 * into a fresh `claude` process: pick from `pai launch` (interactive table)
 * or name one directly (`--provider`), then exec. Switching provider always
 * means starting a NEW session — a running process cannot do it.
 */

import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readWorkersSection,
  WorkersConfigError,
  type WorkersConfig,
} from "../../workers/config.js";
import { workersLogDir, ledgerPath } from "../../workers/paths.js";
import { appendLedger } from "../../workers/ledger.js";
import {
  buildLaunchPlan,
  buildLaunchRows,
  detectCurrentModel,
  detectCurrentProviderName,
  launchableProviderNames,
  maskLaunchEnv,
  type LaunchPlan,
  type LaunchRow,
} from "../../workers/launch.js";
import { renderTable, err, dim, bold, ok } from "../utils.js";

interface LaunchCliOpts {
  provider?: string;
  model?: string;
  list?: boolean;
  current?: boolean;
  dryRun?: boolean;
}

/** Table rows for `--list`, optionally marking the row matching a detected
 *  current-session provider/model (the /providers skill's `--current`). */
function tableLines(workers: WorkersConfig, opts: { current?: boolean }): string[] {
  const rows = buildLaunchRows(workers);
  const curProvider = opts.current ? detectCurrentProviderName(workers, process.env) : null;
  const curModel = opts.current ? detectCurrentModel(process.env) : null;

  const body = rows.map((r) => {
    const flags: string[] = [r.capability];
    if (r.configActive) flags.push("active");
    if (curProvider && r.provider === curProvider && curModel && r.model === curModel) {
      flags.push("this session");
    }
    return [String(r.index), r.provider, r.model, flags.join(", ")];
  });
  const lines = renderTable(["#", "provider", "model", ""], body).split("\n");

  if (opts.current) {
    lines.push("");
    lines.push(
      `  current session: ${bold(curProvider ?? "?")}  model: ${curModel ?? "(session default)"}`
    );
    lines.push(
      dim("  Switching provider starts a new session: pai launch --provider <name> --model <model>")
    );
  }
  return lines;
}

function printTable(workers: WorkersConfig, opts: { current?: boolean }): void {
  console.log();
  for (const line of tableLines(workers, opts)) console.log(line);
  console.log();
}

/** Answer text ("3", "glm", "glm/glm-5.3-flash") -> provider + optional model. */
function parseChoice(answer: string, rows: LaunchRow[]): { provider: string; model?: string } | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const row = rows.find((r) => r.index === Number(trimmed));
    return row ? { provider: row.provider, model: row.model } : null;
  }
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: trimmed };
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

function printDryRun(plan: LaunchPlan): void {
  console.log();
  console.log(bold("Dry run — would exec:"));
  console.log();
  console.log(`  cwd:  ${process.cwd()}`);
  console.log(`  argv: claude ${plan.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  console.log(`  env:`);
  const masked = maskLaunchEnv(plan.env);
  for (const k of Object.keys(masked).sort()) {
    if (!/^(ANTHROPIC_|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|ENABLE_TOOL_SEARCH|PAI_WORKER)/.test(k)) continue;
    console.log(`    ${k}=${masked[k]}`);
  }
  console.log();
}

export function registerLaunchCommand(program: Command): void {
  program
    .command("launch")
    .description(
      "Start the Claude Code harness on any provider/model from workers.yaml.\n" +
        "No args, in a terminal: pick from a numbered table. --list (or piped/non-\n" +
        "interactive output): print the table and exit.\n" +
        "--provider <name> [--model <model>]: start directly, no prompt.\n" +
        "A running claude process cannot switch provider — this always starts a NEW\n" +
        "session in the current terminal. Claude Code's own /model command only shows\n" +
        "the CURRENT endpoint's models; `pai launch --list` (or the /providers skill)\n" +
        "shows every provider configured here.\n" +
        "Extra arguments after the options are passed to claude verbatim, e.g.\n" +
        "`pai launch --provider glm -- --resume <id>`.\n" +
        "The `glm`/`kimi` shell shims are thin aliases of `pai launch --provider <name>`."
    )
    .option("--provider <name>", "Provider to start on (default: prompt from the table)")
    .option("--model <model>", "Model id for that provider (default: the provider's default model)")
    .option("--list", "Print the provider/model table and exit")
    .option("--current", "With --list, also detect and mark this session's own provider/model")
    .option("--dry-run", "Print the resolved command and environment (key masked); do not exec")
    .allowUnknownOption(true)
    .argument("[args...]", "extra claude arguments, e.g. --resume <id>")
    .action(async (args: string[], opts: LaunchCliOpts) => {
      let workers: WorkersConfig;
      try {
        ({ workers } = readWorkersSection());
      } catch (e) {
        console.error(err(`pai launch: ${e instanceof Error ? e.message : String(e)}`));
        process.exitCode = 1;
        return;
      }
      const logDir = workersLogDir(workers);
      const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY;

      if (opts.list || (!opts.provider && !interactive)) {
        printTable(workers, { current: opts.current });
        return;
      }

      let providerName = opts.provider;
      let modelName = opts.model;

      if (!providerName) {
        printTable(workers, {});
        const rows = buildLaunchRows(workers);
        const answer = await prompt(dim("  Pick a number or provider/model: "));
        const picked = parseChoice(answer, rows);
        if (!picked) {
          console.error(
            err(
              `pai launch: "${answer.trim()}" is not a number from the table or a provider[/model] — ` +
                `valid providers: ${launchableProviderNames(workers).join(", ")}`
            )
          );
          process.exitCode = 2;
          return;
        }
        providerName = picked.provider;
        modelName = picked.model;
      }

      let plan: LaunchPlan;
      try {
        plan = await buildLaunchPlan(workers, providerName, modelName, args, logDir);
      } catch (e) {
        if (e instanceof WorkersConfigError) {
          console.error(err(`pai launch: ${e.message}`));
          process.exitCode = 2;
          return;
        }
        throw e;
      }

      if (opts.dryRun) {
        printDryRun(plan);
        return;
      }

      appendLedger(ledgerPath(logDir), "LAUNCH-START", {
        kind: "launch",
        provider: plan.providerName,
        model: plan.model,
        cwd: process.cwd(),
      });

      console.log(dim(`  starting claude on ${ok(plan.providerName)} (${plan.model}) …`));
      const result = spawnSync("claude", plan.argv, {
        stdio: "inherit",
        env: plan.env,
        cwd: process.cwd(),
      });
      if (result.error) {
        console.error(err(`pai launch: failed to start claude: ${result.error.message}`));
        process.exitCode = 1;
        return;
      }
      process.exitCode = result.status ?? 0;
    });
}
