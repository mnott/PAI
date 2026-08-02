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
import { detectAiBroker, detectProber } from "../../tasks/transport/aibroker.js";
import { tick } from "../../tasks/poller.js";
import { installSchedule, uninstallSchedule, scheduleStatus, DEFAULT_INTERVAL_SECS } from "../../tasks/schedule-install.js";
import type { DispatchResult, Task, TaskProvider } from "../../tasks/types.js";
import { writeArchive } from "../../tasks/archive.js";
import {
  readSessionManifest,
  reconcile,
  normalizeName,
  type MappingRow,
} from "../../tasks/projects.js";

/**
 * Render the session/project mapping.
 *
 * The three states are printed with different weight on purpose. "Cannot be
 * addressed" is the only one that needs action, and it is the one that is
 * otherwise invisible — filing a task for a session with no project looks
 * exactly like filing one that works.
 */
function printProjectMapping(rows: MappingRow[], noBroker: boolean): void {
  const mapped = rows.filter((r) => r.state === "mapped");
  const unmapped = rows.filter((r) => r.state === "session-only");
  const orphan = rows.filter((r) => r.state === "project-only");

  console.log();
  console.log(chalk.bold(`  Can receive work (${mapped.length})`));
  for (const r of mapped) console.log(chalk.green("    ✓ ") + r.name);
  if (mapped.length === 0) console.log(dim("    none"));

  if (unmapped.length > 0) {
    console.log();
    console.log(chalk.bold(`  No project — cannot be addressed (${unmapped.length})`));
    for (const r of unmapped) console.log(chalk.yellow("    · ") + r.name);
    console.log();
    console.log(dim("    pai task projects --create <name>...   or --create-all"));
  }

  if (orphan.length > 0) {
    console.log();
    console.log(chalk.bold(`  Project with no session (${orphan.length})`));
    for (const r of orphan) console.log(dim("    · " + r.name));
    console.log(dim("    Tasks filed here queue until that session launches — not a fault."));
  }

  if (noBroker) {
    console.log();
    console.log(dim("  AIBroker not reachable — showing tracker projects only."));
  }
  console.log();
}

const dim = chalk.dim;
const bold = chalk.bold;
const warn = chalk.yellow;
const ok = chalk.green;

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
    .command("projects")
    .description("Show which sessions can be given work from the tracker, and create the missing projects")
    .option("--create <names...>", "Create tracker projects for these session names")
    .option("--create-all", "Create a project for every session that has none")
    .action(async (opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      if (!provider.listSubProjects || !provider.findOrCreateSubProject) {
        console.log();
        console.log(
          chalk.yellow(`  ${provider.providerId} does not address work by sub-project.`)
        );
        console.log(dim("  Session-scoped inboxes need a tracker with nested projects."));
        console.log();
        return;
      }

      const [sessions, projects] = await Promise.all([
        readSessionManifest(),
        provider.listSubProjects(),
      ]);

      const rows = reconcile(sessions, projects);

      const wanted = opts.createAll
        ? rows.filter((r) => r.state === "session-only").map((r) => r.name)
        : ((opts.create as string[] | undefined) ?? []);

      if (wanted.length > 0) {
        const addressable = new Set(
          rows.filter((r) => r.state === "session-only").map((r) => normalizeName(r.name))
        );
        console.log();
        for (const name of wanted) {
          // Refuse to create a project for a session nobody has: it would look
          // addressable and never be picked up, which is the failure this
          // command exists to surface.
          if (!addressable.has(normalizeName(name))) {
            console.log(chalk.yellow(`  skipped  ${name}`) + dim(" — no such session, or it already has a project"));
            continue;
          }
          const { id, created } = await provider.findOrCreateSubProject(name);
          console.log(
            (created ? chalk.green("  created  ") : dim("  exists   ")) + name + dim(`  ${id}`)
          );
        }
        console.log();
        return;
      }

      printProjectMapping(rows, sessions.length === 0);
    });

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
    .option("--due <when>", "Due date: ISO, natural language, or a recurrence (\"every monday at 9\")")
    .option("--priority <p>", "p1 (highest) … p4 (default)")
    .option("--url <url>", "Reference — prefer a hook:// URL over a file path")
    .option("--into <sub-project>", "File into this sub-project under the bus root, creating it if absent")
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
        into: opts.into,
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
        dryRun: Boolean(opts.dryRun),
      });

      printResults(results);
    });

  taskCmd
    .command("poll")
    .description("One scheduler tick: dispatch what is due, check what is running, report")
    .option("--dry-run", "Show what would happen without touching anything")
    .action(async (opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      const config = loadConfig();
      const transport = opts.dryRun ? null : await detectAiBroker(undefined, config.tasks?.dispatchTimeoutSecs);
      const prober = opts.dryRun ? null : await detectProber();

      const report = await tick({
        provider: provider as TodoistProvider,
        transport,
        prober,
        autoDispatch: config.tasks?.autoDispatch ?? false,
        dryRun: Boolean(opts.dryRun),
      });

      if (report.decisions.length === 0) {
        console.log(dim("  Nothing due, nothing running."));
        return;
      }

      const mark: Record<string, string> = {
        dispatch: chalk.green("→"),
        triggered: chalk.green("▶"),
        complete: chalk.green("✓"),
        running: dim("·"),
        probe: chalk.yellow("?"),
        orphaned: chalk.yellow("!"),
        abandoned: chalk.red("\u2a2f"),
        skip: dim("–"),
        wait: dim(" "),
      };

      console.log();
      for (const { decision, note } of report.decisions) {
        console.log(`  ${mark[decision.action] ?? " "} ${decision.task.title}`);
        if (note) console.log(`      ${dim(note)}`);
      }
      console.log();
      console.log(
        dim(
          `  ${report.dispatched} dispatched, ${report.completed} completed, ` +
          `${report.probed} probed, ${report.stuck} stuck`
        )
      );
      console.log();
    });

  const scheduleCmd = taskCmd
    .command("schedule")
    .description("Install, remove or inspect the launchd agent that ticks the scheduler");

  scheduleCmd
    .command("install")
    .description("Install the scheduler tick (default: every 15 minutes)")
    .option("--interval <secs>", "Seconds between ticks", (v) => Number.parseInt(v, 10))
    .action((opts) => {
      const r = installSchedule(opts.interval || DEFAULT_INTERVAL_SECS);
      console.log(r.loaded ? chalk.green(`  ${r.message}`) : chalk.yellow(`  ${r.message}`));
      console.log(dim(`  ${r.plistPath}`));
      console.log(dim(`  The schedule itself lives in Todoist — this only sets how often PAI looks.`));
    });

  scheduleCmd
    .command("uninstall")
    .description("Remove the scheduler agent")
    .action(() => console.log(chalk.green(`  ${uninstallSchedule()}`)));

  scheduleCmd
    .command("status")
    .description("Show whether the scheduler agent is installed and loaded")
    .action(() => {
      const s = scheduleStatus();
      console.log();
      console.log(`  ${s.installed ? chalk.green("installed") : dim("not installed")}` +
        `  ${s.installed ? (s.running ? chalk.green("· loaded") : chalk.yellow("· not loaded")) : ""}`);
      console.log(dim(`  ${s.detail}`));
      console.log();
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
    .command("archive <id>")
    .description("Save a task's discussion into the owning project's notes, without completing it")
    .option("--quiet", "Print nothing (for hook and webhook callers)")
    .option("--no-notify", "Do not tell the owning session where the file landed")
    .action(async (id, opts: { quiet?: boolean; notify?: boolean }) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();
      // Notifies by default: this command is the path something OUTSIDE the
      // session took — a checkbox ticked in the tracker — so the session has no
      // idea it happened. `task done` deliberately does not notify, because
      // there the session is the one that just did it.
      const saved = await cmdArchiveTask(provider, id, {
        quiet: opts.quiet,
        notify: opts.notify !== false,
      });
      // Non-zero on failure so a webhook caller can tell nothing was saved
      // rather than assuming success — the whole point is not losing content.
      if (!saved) process.exitCode = 1;
    });

  taskCmd
    .command("done <id>")
    .description("Mark a task complete on the tracker, keeping its discussion")
    .option("--no-archive", "Complete without saving the comment thread")
    .action(async (id, opts) => {
      const provider = buildProvider();
      if (!provider) return reportUnconfigured();

      // Archive BEFORE completing. A completed task is harder to read back on
      // some providers, and losing the thread is the failure this exists to
      // prevent — so the copy is taken while the task is unambiguously there.
      let archived: { path: string; written: boolean; commentCount: number } | null = null;
      if (opts.archive !== false) {
        archived = await archiveTaskThread(provider, id);
      }

      await provider.complete(id);
      console.log(chalk.green(`  Completed ${id}.`));

      if (archived) {
        const what = `${archived.commentCount} comment${archived.commentCount === 1 ? "" : "s"}`;
        console.log(
          archived.written
            ? dim(`  Discussion saved (${what}) → ${archived.path}`)
            : dim(`  Discussion already saved (${what}), unchanged.`)
        );
      }
    });
}

/**
 * `pai task archive <id>` — save a task's discussion without completing it.
 *
 * Split out from `done` so the webhook has something to call. Ticking the
 * checkbox in the tracker is the completion path people actually use, and it
 * never runs `pai task done` — so an archive wired only into that command
 * fires on the route nobody takes and not on the route everybody does.
 *
 * Safe to call repeatedly: the archive rewrites one file per task from the full
 * thread, so a duplicate webhook or a poller backstop covering the same
 * completion costs one no-op.
 */
export async function cmdArchiveTask(
  provider: TaskProvider,
  id: string,
  opts: { quiet?: boolean; notify?: boolean } = {}
): Promise<boolean> {
  if (!provider.getTask || !provider.listComments) {
    if (!opts.quiet) console.log(warn(`  ${provider.providerId} cannot read a task's discussion.`));
    return false;
  }

  const task = await provider.getTask(id);
  if (!task) {
    if (!opts.quiet) console.log(warn(`  No task ${id}.`));
    return false;
  }

  const root = task.owner.rootPath;
  if (!task.owner.project || !root) {
    if (!opts.quiet) {
      console.log(
        warn("  No owning project — nothing archived. ") +
          dim("Label it `pai:<project>` to give it a home.")
      );
    }
    return false;
  }

  const comments = await provider.listComments(id);
  const r = writeArchive(root, task, comments, new Date().toISOString());

  if (r.written && opts.notify) {
    await tellOwningSession(task, r.path, r.commentCount, opts.quiet);
  }

  if (!opts.quiet) {
    const what = `${r.commentCount} comment${r.commentCount === 1 ? "" : "s"}`;
    if (r.skipped === "no-discussion") {
      console.log(dim("  No discussion on this task — nothing to archive."));
    } else {
      console.log(
        r.written
          ? ok(`  Saved (${what}) → `) + r.path
          : dim(`  Already saved (${what}), unchanged.`)
      );
    }
  }
  return true;
}

/**
 * Tell the owning session that a discussion was filed, if it is running.
 *
 * `Notes/tasks/` is a default, not a decision. The session that owns a project
 * knows where things actually belong there — a dated triage folder, a ledger
 * row, an existing note the discussion continues. It can move or link the file;
 * this side cannot, because the convention lives in that project's head and not
 * in PAI.
 *
 * **Never spawns.** Launching a session to tell it a file exists inverts the
 * cost: the archive is already safely on disk, and a terminal opening by itself
 * because someone ticked a checkbox is worse than a note filed one directory
 * away from ideal. If nothing is running, the file simply waits.
 *
 * Best-effort throughout. The archive has already succeeded by the time this
 * runs, and a notification that cannot be delivered must never turn a saved
 * discussion into a reported failure.
 */
async function tellOwningSession(
  task: Task,
  path: string,
  comments: number,
  quiet?: boolean
): Promise<void> {
  const project = task.owner.project;
  if (!project) return;

  try {
    const transport = await detectAiBroker();
    if (!transport) return;

    const message = [
      `A discussion was archived from the tracker — ${comments} comment${comments === 1 ? "" : "s"} on "${task.title}".`,
      "",
      `Filed provisionally at: ${path}`,
      `Tracker id: ${task.id}`,
      "",
      "This is a notification, not a work order. Nothing is waiting on you and the",
      "content is already safe on disk.",
      "",
      "Notes/tasks/ is PAI's default, chosen without knowing this project's",
      "conventions. If it belongs somewhere else here — a dated folder, a ledger",
      "row, an existing note the discussion continues — move or link it, then say",
      "nothing. If the default is fine, leave it.",
    ].join("\n");

    // spawnIfAbsent: false is the whole point — see the note above.
    const result = await transport.dispatch(project, message, { spawnIfAbsent: false });

    if (!quiet && result.outcome === "delivered") {
      console.log(dim(`  Told the ${project} session where it landed.`));
    }
  } catch {
    // Deliberately silent: the discussion is saved, which is what mattered.
  }
}

/**
 * Copy a task's thread into the notes of the project that owns it.
 *
 * Best-effort by design: this runs as a side effect of completing a task, and
 * a failure to archive must never stop the task being completed. It reports
 * what went wrong rather than throwing, because a silent skip here would lose
 * exactly the content it exists to keep.
 */
async function archiveTaskThread(
  provider: TaskProvider,
  id: string
): Promise<{ path: string; written: boolean; commentCount: number } | null> {
  try {
    if (!provider.listComments) return null;

    const tasks = await provider.listOpen({ includeUnrouted: true });
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      console.log(dim(`  Not on the open list — nothing archived.`));
      return null;
    }

    const project = task.owner.project;
    const root = task.owner.rootPath;
    if (!project || !root) {
      console.log(
        warn(`  No owning project — discussion not archived. `) +
          dim(`Label it \`pai:<project>\` to give it a home.`)
      );
      return null;
    }

    const comments = await provider.listComments(id);
    return writeArchive(root, task, comments, new Date().toISOString());
  } catch (e) {
    console.log(
      warn(`  Could not archive the discussion: `) +
        (e instanceof Error ? e.message : String(e))
    );
    return null;
  }
}
