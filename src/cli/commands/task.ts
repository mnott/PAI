/**
 * task.ts — `pai task` CLI
 *
 * Surface for the task bus: list what is open, file new work, dispatch tasks to
 * the sessions that own them, and close them out.
 *
 * See Notes/docs/task-bus.md.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig, CONFIG_FILE } from "../../daemon/config.js";
import { readConfigRaw, writeConfigRaw } from "./setup/utils.js";
import { openRegistry } from "../../registry/db.js";
import { loadAliasMap } from "../../tasks/resolver.js";
import { TodoistProvider } from "../../tasks/providers/todoist.js";
import { dispatchAll } from "../../tasks/dispatch.js";
import { detectAiBroker } from "../../tasks/transport/aibroker.js";
import type { DispatchResult, Task, TaskProvider } from "../../tasks/types.js";

const dim = chalk.dim;
const bold = chalk.bold;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildProvider(): TaskProvider | null {
  const config = loadConfig();
  const tasks = config.tasks;
  if (!tasks?.enabled) return null;

  const aliases = loadAliasMap(openRegistry());
  const provider = new TodoistProvider(tasks.providers.todoist, aliases);
  return provider.isConfigured() ? provider : null;
}

/** Print the one message that actually helps when nothing is configured. */
function reportUnconfigured(): void {
  console.error(chalk.yellow("  Task bus is not configured."));
  console.error(dim("  Run `pai setup` and complete the Task Bus step."));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Prompt for a secret without echoing it.
 *
 * Never accept a token as a command-line argument: argv is visible in `ps` to
 * every user on the machine and lands in shell history verbatim.
 */
function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
    // Swap in a writer that swallows echoed keystrokes but still lets the
    // prompt itself through.
    const write = out.write.bind(out);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!out.muted) write(s);
    };
    write(question);
    out.muted = true;
    rl.question("", (answer) => {
      out.muted = false;
      write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Show enough of a token to recognise it, never enough to use it. */
function redact(token: string | undefined): string {
  if (!token) return dim("(not set)");
  return token.length <= 8 ? "********" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

type RawTasks = {
  enabled?: boolean;
  autoDispatch?: boolean;
  dispatchTimeoutSecs?: number;
  providers?: { todoist?: { enabled?: boolean; apiKey?: string; rootProjectId?: string; findingsSectionId?: string } };
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderOwner(task: Task): string {
  if (task.owner.project) {
    const via = task.owner.source === "label" ? "label" : "container";
    return chalk.cyan(task.owner.project) + dim(` (${via})`);
  }
  return task.owner.rawHint
    ? chalk.yellow("unrouted") + dim(` (${task.owner.rawHint} matches no project)`)
    : chalk.yellow("unrouted");
}

function printTasks(tasks: Task[]): void {
  if (tasks.length === 0) {
    console.log(dim("  Nothing open."));
    return;
  }
  console.log();
  for (const t of tasks) {
    const due = t.due ? dim(` due ${t.due.slice(0, 10)}`) : "";
    const prio = t.priority !== "p4" ? dim(` ${t.priority}`) : "";
    console.log(`  ${bold(t.title)}${prio}${due}`);
    console.log(`    ${renderOwner(t)} ${dim("· " + t.id)}`);
  }
  console.log();
}

function printResults(results: DispatchResult[]): void {
  const symbol: Record<string, string> = {
    delivered: chalk.green("→"),
    spawned: chalk.green("+"),
    unrouted: chalk.yellow("?"),
    unlaunchable: chalk.red("!"),
    unreachable: chalk.red("✗"),
    skipped: dim("·"),
  };

  console.log();
  for (const r of results) {
    console.log(`  ${symbol[r.outcome]} ${r.task.title}`);
    const detail = [r.session, r.reason].filter(Boolean).join(" — ");
    if (detail) console.log(`      ${dim(detail)}`);
  }
  console.log();

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log(dim("  " + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")));
  console.log();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerTaskCommands(taskCmd: Command): void {
  taskCmd
    .command("list")
    .description("List open tasks on the bus")
    .option("--owner <project>", "Only tasks owned by this PAI project")
    .option("--due <date>", "Only tasks due on or before this ISO date")
    .option("--today", "Shorthand for --due <today>")
    .option("--routed", "Hide tasks with no resolved owner")
    .option("--limit <n>", "Maximum tasks to show", (v) => Number.parseInt(v, 10))
    .action(async (opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      const tasks = await provider.listOpen({
        owner: opts.owner,
        dueBefore: opts.today ? todayIso() : opts.due,
        includeUnrouted: !opts.routed,
        limit: opts.limit,
      });
      printTasks(tasks);
    });

  taskCmd
    .command("add <title>")
    .description("File a task onto the bus")
    .option("--owner <project>", "PAI project that owns this (adds a pai: label)")
    .option("--body <text>", "Full procedure and reasoning — not just a restatement of the title")
    .option("--due <date>", "Due date (ISO or natural language)")
    .option("--priority <p>", "p1 (highest) … p4 (default)")
    .option("--url <url>", "Reference — prefer a hook:// URL over a file path")
    .action(async (title, opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      // A title alone is not actionable months later. Warn rather than block:
      // refusing the write would just push people to file nothing at all.
      if (!opts.body) {
        console.log(dim("  No --body given. Add the procedure and reasoning so this"));
        console.log(dim("  is still actionable months from now, by you alone."));
      }

      const created = await provider.add({
        title,
        body: opts.body ?? "",
        owner: opts.owner ?? null,
        due: opts.due,
        priority: opts.priority,
        sourceUrl: opts.url,
      });

      console.log(chalk.green(`  Filed: ${created.title}`));
      console.log(`    ${renderOwner(created)} ${dim("· " + created.id)}`);
    });

  taskCmd
    .command("dispatch")
    .description("Hand open tasks to the PAI sessions that own them")
    .option("--owner <project>", "Only dispatch tasks for this project")
    .option("--today", "Only tasks due today or overdue")
    .option("--dry-run", "Report what would happen without contacting any session")
    .option("--no-spawn", "Never launch a session; skip owners that are not running")
    .action(async (opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      const config = loadConfig();
      const tasks = await provider.listOpen({
        owner: opts.owner,
        dueBefore: opts.today ? todayIso() : undefined,
        includeUnrouted: true,
      });

      if (tasks.length === 0) {
        console.log(dim("  Nothing to dispatch."));
        return;
      }

      // A dry run must never contact a session, so skip detection entirely
      // rather than detecting and then declining to use it.
      const transport = opts.dryRun
        ? null
        : await detectAiBroker(undefined, config.tasks?.dispatchTimeoutSecs);

      if (!opts.dryRun && !transport) {
        console.log(dim("  No aibroker CLI with `dispatch` found — reporting ownership only."));
      }

      const results = await dispatchAll(tasks, {
        transport,
        autoDispatch: opts.dryRun ? false : (config.tasks?.autoDispatch ?? false),
        spawnIfAbsent: opts.spawn !== false,
      });

      printResults(results);
    });

  taskCmd
    .command("config")
    .description("View or change task bus settings without running the full setup wizard")
    .option("--token", "Prompt for the Todoist API token (input is hidden)")
    .option("--from-env", "Adopt the token from TODOIST_API_KEY in the environment")
    .option("--project <id>", "Tracker project ID that roots the bus (an ID, never a name)")
    .option("--findings <id>", "Section ID for the findings inbox")
    .option("--timeout <secs>", "Seconds a single dispatch may take", (v) => Number.parseInt(v, 10))
    .option("--auto-dispatch <bool>", "Hand tasks to owning sessions automatically (true/false)")
    .option("--disable", "Turn the task bus off without discarding its settings")
    .action(async (opts) => {
      const raw = readConfigRaw();
      const tasks = (raw.tasks ?? {}) as RawTasks;
      tasks.providers ??= {};
      tasks.providers.todoist ??= {};
      const todoist = tasks.providers.todoist;

      const noChanges =
        !opts.token && !opts.fromEnv && !opts.project && !opts.findings &&
        opts.timeout === undefined && opts.autoDispatch === undefined && !opts.disable;

      if (noChanges) {
        console.log();
        console.log(`  ${bold("Task bus")}      ${tasks.enabled ? chalk.green("enabled") : dim("disabled")}`);
        console.log(`  ${bold("Token")}         ${redact(todoist.apiKey)}${
          !todoist.apiKey && process.env.TODOIST_API_KEY ? dim("  (TODOIST_API_KEY is set in this shell)") : ""
        }`);
        console.log(`  ${bold("Root project")}  ${todoist.rootProjectId ?? dim("(not set)")}`);
        console.log(`  ${bold("Findings")}      ${todoist.findingsSectionId ?? dim("(not set)")}`);
        console.log(`  ${bold("Auto-dispatch")} ${tasks.autoDispatch ? chalk.green("on") : dim("off")}`);
        console.log(`  ${bold("Timeout")}       ${tasks.dispatchTimeoutSecs ?? dim("default (180s)")}`);
        console.log();
        console.log(dim(`  ${CONFIG_FILE}`));
        console.log();
        return;
      }

      if (opts.token && opts.fromEnv) {
        console.error(chalk.yellow("  Use either --token or --from-env, not both."));
        process.exitCode = 1;
        return;
      }

      if (opts.fromEnv) {
        const envToken = process.env.TODOIST_API_KEY?.trim();
        if (!envToken) {
          console.error(chalk.yellow("  TODOIST_API_KEY is not set in this environment."));
          process.exitCode = 1;
          return;
        }
        todoist.apiKey = envToken;
        todoist.enabled = true;
        tasks.enabled = true;
      }

      if (opts.token) {
        const entered = await promptSecret("  Todoist API token (hidden): ");
        if (!entered) {
          console.error(chalk.yellow("  No token entered. Nothing changed."));
          process.exitCode = 1;
          return;
        }
        todoist.apiKey = entered;
        todoist.enabled = true;
        tasks.enabled = true;
      }

      if (opts.project) { todoist.rootProjectId = opts.project; tasks.enabled = true; }
      if (opts.findings) todoist.findingsSectionId = opts.findings;
      if (opts.timeout !== undefined) tasks.dispatchTimeoutSecs = opts.timeout;
      if (opts.autoDispatch !== undefined) tasks.autoDispatch = opts.autoDispatch === "true";
      if (opts.disable) tasks.enabled = false;

      raw.tasks = tasks;
      writeConfigRaw(raw);

      // The file now holds a credential. Narrow it before saying anything else,
      // so a crash between write and chmod cannot leave it world-readable.
      try {
        chmodSync(CONFIG_FILE, 0o600);
      } catch {
        console.log(chalk.yellow(`  Could not restrict permissions on ${CONFIG_FILE} — check them by hand.`));
      }

      console.log(chalk.green("  Saved."));
      if (todoist.apiKey && !todoist.rootProjectId) {
        console.log(dim("  No root project set yet — run `pai task config --project <id>`."));
      }
    });

  taskCmd
    .command("done <id>")
    .description("Mark a task complete on the tracker")
    .action(async (id) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();
      await provider.complete(id);
      console.log(chalk.green(`  Completed ${id}.`));
    });
}
