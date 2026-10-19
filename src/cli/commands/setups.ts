/** `pai setups` and `pai setups save NAME`, plus `pai more`. */

import { readWorkersSection, ANTHROPIC_NATIVE, type WorkersConfig } from "../../workers/config.js";
import { CliError, type CommandDef } from "../define.js";
import { colorEnabled, makeStyle, renderMore, renderTable } from "../help.js";
import { readRoutingState } from "../../workers/routing.js";
import { workersLogDir } from "../../workers/paths.js";
import { allSetups, downLocalProviders, loadSaved, saveSetup, setupsPath } from "../lib/setups.js";
import { GROUPS } from "../registry.js";
import { lastSetup, setupsTable } from "./root.js";
import { collectView } from "./session.js";

function load(): WorkersConfig {
  try {
    return readWorkersSection().workers;
  } catch (e) {
    throw new CliError(`cannot read the provider configuration: ${e instanceof Error ? e.message : String(e)}`, "pai providers");
  }
}

const saveCommand: CommandDef = {
  name: "save",
  summary: "Save the current combination under a name",
  description:
    "Saves how your most recent session ran (its orchestrator) together with the provider workers run on now. " +
    "Name them explicitly with --orchestrator and --workers.",
  args: [{ name: "NAME", required: true, summary: "Name for the setup, e.g. \"opus + glm\"" }],
  options: [
    { name: "orchestrator", type: "string", value: "PROVIDER", summary: "Provider that runs the main conversation (default: your latest session's)" },
    { name: "workers", type: "string", value: "PROVIDER", summary: "Provider the worker classes run on (default: the active provider)" },
  ],
  examples: ['pai setups save "my mix"', 'pai setups save "kimi + glm" --orchestrator kimi --workers glm'],
  seeAlso: ["pai setups"],
  async run(ctx) {
    const workers = load();
    const { rows } = await collectView({});
    const last = lastSetup(rows[0] ?? null, workers);
    const orchestrator = (ctx.opts.orchestrator as string | undefined) ?? last.orchestrator.provider;
    const wk = (ctx.opts.workers as string | undefined) ?? last.workers;
    const known = [ANTHROPIC_NATIVE, ...Object.keys(workers.providers)];
    for (const p of [orchestrator, wk]) {
      if (!known.includes(p)) throw new CliError(`provider "${p}" is not configured`, "pai providers");
    }
    const name = (ctx.args.NAME as string).trim();
    if (ctx.dryRun) return void process.stdout.write(`would save "${name}": orchestrator ${orchestrator}, workers ${wk} → ${setupsPath()}\n`);
    saveSetup({ name, orchestrator: { provider: orchestrator, model: ctx.opts.orchestrator ? undefined : last.orchestrator.model }, workers: wk });
    process.stdout.write(`Saved setup "${name}": orchestrator ${orchestrator}, workers ${wk}\nUse it: pai <name> --with "${name}"\n`);
  },
};

export const setupsCommand: CommandDef = {
  name: "setups",
  summary: "Orchestrator + worker combinations (save your own)",
  description:
    "A setup says which model runs the main conversation and which provider the workers run on. " +
    "\"Last time\" is how your latest session ran; the rest are built from your configured providers and anything you saved. " +
    "Every enabled local provider (loopback, e.g. a model on this machine) whose server answers right now gets \"anthropic + <provider> workers\": Anthropic orchestrates, the local model does the work, for that session only. " +
    "Local providers that are not running are left out (\"Last time\" stays, marked down). " +
    "The list reads your configuration and cooldowns and tries one local TCP connect per local provider; nothing remote is contacted.",
  daily: true,
  subcommands: [saveCommand],
  examples: ["pai setups", 'pai setups save "my mix"', 'pai webseiten --with "anthropic + glm workers"', 'pai new ~/code/app --with "anthropic + flashnext-iq3 workers"'],
  seeAlso: ["pai", "pai providers"],
  async run() {
    const st = makeStyle(colorEnabled());
    const workers = load();
    // Status comes from config and the routing state file: no provider is probed, no budget fetched.
    const { rows } = await collectView({ limit: 1, offline: true });
    const down = await downLocalProviders(workers);
    const setups = allSetups(workers, lastSetup(rows[0] ?? null, workers), loadSaved(), down);
    const o = setupsTable(setups, workers, {}, st, readRoutingState(workersLogDir(workers)), down);
    process.stdout.write(renderTable(o.headers, setups.map(o.cells), st) + "\n\n");
    process.stdout.write(st.dim('Use one: pai <session> --with "<setup>"   ·   keep the current mix: pai setups save "<name>"') + "\n");
  },
};

export const moreCommand: CommandDef = {
  name: "more",
  summary: "Every other command, by group",
  description: "Lists the commands that are not on the first screen: scripting forms, providers, workers, projects, daemon and setup.",
  examples: ["pai more", "pai help worker"],
  seeAlso: ["pai help"],
  daily: false,
  run() {
    process.stdout.write(renderMore(GROUPS, makeStyle(colorEnabled())) + "\n");
  },
};
