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
import { loadConfig } from "../../daemon/config.js";
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
    .command("done <id>")
    .description("Mark a task complete on the tracker")
    .action(async (id) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();
      await provider.complete(id);
      console.log(chalk.green(`  Completed ${id}.`));
    });
}
