#!/usr/bin/env node
/**
 * PAI Knowledge OS — CLI entry point (v0.10.0 topic-first redesign)
 *
 * Top-level surface:
 *   pai                    → recent sessions picker
 *   pai <topic>            → history search + candidate picker + launch
 *   pai <uuid-prefix>      → direct session resume via filesystem scan
 *   pai cd <name>          → cd to project directory (no Claude launch)
 *   pai pause [all]        → save state (or mass-pause every live session)
 *   pai end                → finalize session
 *
 * Power-user namespaces (still accessible, hidden from main help):
 *   pai sessions ...       → full session management
 *   pai projects ...       → project management
 *   pai registry ...       → registry maintenance
 *   pai memory ...         → memory engine
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openRegistry } from "../registry/db.js";
import type { Database } from "better-sqlite3";
import { registerProjectsCommands } from "./commands/project/projects-index.js";
import { findMovedPath } from "./commands/project/commands.js";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { registerSessionsCommands } from "./commands/session/sessions-index.js";
import { registerSessionCleanupCommand } from "./commands/session-cleanup.js";
import { registerRegistryCommands } from "./commands/registry.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerRestoreCommands } from "./commands/restore.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerObsidianCommands } from "./commands/obsidian.js";
import { registerZettelCommands } from "./commands/zettel.js";
import { registerObservationCommands } from "./commands/observation.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerNotifyCommands } from "./commands/notify.js";
import { registerTopicCommands } from "./commands/topic.js";
import { registerKgCommands } from "./commands/kg.js";
import { registerDbCommands } from "./commands/db.js";
import { err, warn, ok, dim, shortenPath, encodeDir, now } from "./utils.js";
import { cmdPause } from "./commands/session/pause.js";
import { cmdEnd } from "./commands/session/end.js";
import { cmdGoto } from "./commands/session/goto.js";
import { cmdPauseAll } from "./commands/session/pause-all.js";
import { cmdList as cmdNotesList } from "./commands/session/commands.js";
import { resolveIdentifier } from "./commands/project/helpers.js";
import { cmdFind } from "./commands/find.js";
import { cmdMain } from "./commands/main-resolver.js";

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/cli/ or src/cli/ to find package.json
    const pkgPath = join(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Lazy database singleton — opened on first command that needs it
// ---------------------------------------------------------------------------

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    try {
      _db = openRegistry();
    } catch (e) {
      console.error(err(`Failed to open PAI registry: ${e}`));
      process.exit(1);
    }
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("pai")
  .description("PAI Knowledge OS — Personal AI Infrastructure CLI")
  .version(getVersion(), "-V, --version", "Print version and exit")
  .addHelpText(
    "after",
    `
Usage:
  pai                     Show recent sessions (interactive picker)
  pai <topic>             Find sessions by topic and launch the chosen one
  pai <uuid-prefix>       Resume a specific session by UUID
  pai cd <name>           cd to a project directory (no Claude launch)
  pai pause [all]         Save state (or mass-pause every live session)
  pai end                 Finalize session: save state + mark note Completed

Examples:
  pai mdf                 Find all sessions where you worked on MDF
  pai solar panels        Free-text search across your prompt history
  pai 81c5c3dc            Resume session by UUID prefix
  pai                     See the 20 most recent sessions

Power-user namespaces (run "pai sessions --help" etc. for details):
  pai sessions ...        Full session management (list, goto, info, ...)
  pai projects ...        Project management (cd, rebind, list, ...)
  pai registry ...        Registry maintenance (scan, ...)
  pai memory ...          Memory engine (index, search, ...)

Shell integration:
  eval "$(pai shell-init)"    # Add to ~/.zshrc for pai cd to work`
  );

// ---------------------------------------------------------------------------
// pai projects  (canonical plural namespace)
// ---------------------------------------------------------------------------

const projectsCmd = program
  .command("projects")
  .description("Manage registered projects (list, cd, add, info, ...)");

registerProjectsCommands(projectsCmd, getDb);

// ---------------------------------------------------------------------------
// pai sessions  (canonical plural namespace)
// Bare `pai sessions` runs the default `list` subcommand.
// ---------------------------------------------------------------------------

const sessionsCmd = program
  .command("sessions")
  .description("Session management (list, goto, pause, ...)");

registerSessionsCommands(sessionsCmd, getDb);
registerSessionCleanupCommand(sessionsCmd, getDb);

// ---------------------------------------------------------------------------
// pai registry
// ---------------------------------------------------------------------------

const registryCmd = program
  .command("registry")
  .description("Registry maintenance: scan, migrate, stats, rebuild");

registerRegistryCommands(registryCmd, getDb);

// ---------------------------------------------------------------------------
// pai memory
// ---------------------------------------------------------------------------

const memoryCmd = program
  .command("memory")
  .description("Memory engine: index, search, and status");

registerMemoryCommands(memoryCmd, getDb);

// ---------------------------------------------------------------------------
// pai mcp
// ---------------------------------------------------------------------------

const mcpCmd = program
  .command("mcp")
  .description("MCP server management: install and status");

registerMcpCommands(mcpCmd);

// ---------------------------------------------------------------------------
// pai daemon
// ---------------------------------------------------------------------------

const daemonCmd = program
  .command("daemon")
  .description("PAI daemon management: serve, status, restart, install, uninstall, logs");

registerDaemonCommands(daemonCmd);

// ---------------------------------------------------------------------------
// pai backup / pai restore
// ---------------------------------------------------------------------------

registerBackupCommands(program);
registerRestoreCommands(program);

// ---------------------------------------------------------------------------
// pai setup
// ---------------------------------------------------------------------------

registerSetupCommand(program);

// ---------------------------------------------------------------------------
// pai update
// ---------------------------------------------------------------------------

registerUpdateCommand(program);

// ---------------------------------------------------------------------------
// pai notify
// ---------------------------------------------------------------------------

const notifyCmd = program
  .command("notify")
  .description("Notification config: status, get, set, test, send");

registerNotifyCommands(notifyCmd);

// ---------------------------------------------------------------------------
// pai topic
// ---------------------------------------------------------------------------

const topicCmd = program
  .command("topic")
  .description("Topic shift detection: check whether context has drifted to a different project");

registerTopicCommands(topicCmd);

// ---------------------------------------------------------------------------
// pai kg
// ---------------------------------------------------------------------------

const kgCmd = program
  .command("kg")
  .description("Temporal knowledge graph: backfill, query, list, stats");

registerKgCommands(kgCmd);

// ---------------------------------------------------------------------------
// pai db
// ---------------------------------------------------------------------------

const dbCmd = program
  .command("db")
  .description("Database inspection: query, tables, schema (sqlite or postgres)");

registerDbCommands(dbCmd);

// ---------------------------------------------------------------------------
// pai obsidian
// ---------------------------------------------------------------------------

const obsidianCmd = program
  .command("obsidian")
  .description("Obsidian vault: sync project notes, view status, open in Obsidian");

registerObsidianCommands(obsidianCmd, getDb);

// ---------------------------------------------------------------------------
// pai zettel
// ---------------------------------------------------------------------------

const zettelCmd = program
  .command("zettel")
  .description("Zettelkasten intelligence: explore, surprise, converse, themes, health, suggest");

registerZettelCommands(zettelCmd, getDb);

// ---------------------------------------------------------------------------
// pai observation
// ---------------------------------------------------------------------------

const observationCmd = program
  .command("observation")
  .description("Observation capture: list, search, and stats");

registerObservationCommands(observationCmd);

// ---------------------------------------------------------------------------
// DAILY VERBS — top-level short forms
// ---------------------------------------------------------------------------

// pai pause [all] [--dry-run] [--exit] [--wait <ms>]
// When called as `pai pause all`, pauses every live session via AIBroker.
// When called as `pai pause`, saves state for the current session.
program
  .command("pause [target]")
  .description(
    "Save state and display safe-exit instructions for the current session.\n" +
      "Writes a ## Continue checkpoint to the project's TODO.md.\n" +
      "Use `pai pause all` to pause every live session via AIBroker.\n" +
      "Long form: pai sessions pause"
  )
  .option("--dry-run", "Preview changes without writing them")
  .option("--exit", "(pause all only) Also send /exit to each session after pausing")
  .option("--wait <ms>", "(pause all only) Milliseconds to wait before /exit (default: 5000)", "5000")
  .action(async (target: string | undefined, opts: { dryRun?: boolean; exit?: boolean; wait?: string }) => {
    if (target === "all") {
      await cmdPauseAll({
        exit: opts.exit,
        dryRun: opts.dryRun,
        wait: opts.wait !== undefined ? parseInt(opts.wait, 10) : undefined,
      });
    } else {
      if (target !== undefined) {
        console.error(`Unknown target: ${target}. Did you mean 'pai pause all'?`);
        process.exitCode = 1;
        return;
      }
      cmdPause(getDb(), { dryRun: opts.dryRun });
    }
  });

// pai end [--dry-run]
program
  .command("end")
  .description(
    "Finalize a session: save state, mark note Completed, display safe-exit instructions.\n" +
      "Long form: pai sessions end"
  )
  .option("--dry-run", "Preview all changes without writing them")
  .action((opts: { dryRun?: boolean }) => {
    cmdEnd(getDb(), opts);
  });

// pai resume <name> [--dry-run]  — compat alias for pai sessions goto
// Power users can also use: pai sessions goto <name>
program
  .command("resume <name>")
  .description(
    "Go to a session by name or UUID: resume if resumable, start fresh otherwise.\n" +
      "Also: pai <name>  (shorter)  |  pai sessions goto <name>  (long form)"
  )
  .option("--dry-run", "Print the exact argv and cwd, then exit without launching")
  .action(
    (name: string, opts: { dryRun?: boolean }) => {
      cmdGoto(getDb(), name, { dryRun: opts.dryRun });
    }
  );

// pai cd <identifier>  — prints path; shell wrapper does the actual cd
program
  .command("cd <identifier>")
  .description(
    "cd to a project directory (shell wrapper handles the actual cd).\n" +
      "Long form: pai projects cd <identifier>\n" +
      "The shell function installed by pai shell-init intercepts this command\n" +
      "and calls builtin cd with the resolved path.\n" +
      "Auto-detects moved projects when the registered path no longer exists."
  )
  .action((identifier: string) => {
    const db = getDb();
    const project = resolveIdentifier(db, identifier);
    if (!project) {
      console.error(`Project not found: ${identifier}`);
      process.exit(1);
      return;
    }

    if (existsSync(project.root_path)) {
      process.stdout.write(project.root_path + "\n");
      return;
    }

    // Path missing — search for moved location
    process.stderr.write(
      warn(`Path not found: ${project.root_path}\n`) +
      dim("  Searching for moved location...\n")
    );

    const result = findMovedPath(project.root_path);

    if (result.found) {
      const newPath = result.found;
      const newEncoded = encodeDir(newPath);
      const ts = now();
      db.prepare(
        "UPDATE projects SET root_path = ?, encoded_dir = ?, updated_at = ? WHERE id = ?"
      ).run(newPath, newEncoded, ts, project.id);
      process.stderr.write(
        ok(`Project moved: ${shortenPath(project.root_path, 50)}\n`) +
        dim(`  → ${newPath}\n`) +
        ok("Registry updated.\n")
      );
      process.stdout.write(newPath + "\n");
      return;
    }

    if (result.ambiguous) {
      process.stderr.write(
        warn(`Multiple directories named "${basename(project.root_path)}" found:\n`)
      );
      for (const candidate of result.ambiguous!) {
        process.stderr.write(dim(`  ${candidate}\n`));
      }
      process.stderr.write(
        dim(`\n  Disambiguate with: pai projects rebind ${project.slug} <path>\n`)
      );
      process.exitCode = 1;
      return;
    }

    process.stderr.write(
      err(
        `Project "${project.slug}" root_path "${project.root_path}" does not exist on disk\n` +
        `  and no folder named "${basename(project.root_path)}" was found in scan dirs.\n`
      ) +
      dim(`  Fix with: pai projects rebind ${project.slug} <new-path>\n`)
    );
    process.exitCode = 1;
  });

// Note: `pai sessions` and `pai projects` are now defined as the canonical
// namespaces above (with `isDefault: true` on their `list` subcommands).
// Bare invocation (`pai sessions`, `pai projects`) triggers the default list.

// ---------------------------------------------------------------------------
// pai notes  — markdown session notes (power user, still accessible)
// ---------------------------------------------------------------------------

const notesCmd = program
  .command("notes [project-slug]")
  .description(
    "Markdown session notes — list notes, optionally filtered to a project."
  )
  .option("--limit <n>", "Maximum number of notes to show", "20")
  .option("--status <status>", "Filter by status: open | completed | compacted")
  .action(
    (
      projectSlug: string | undefined,
      opts: { limit?: string; status?: string }
    ) => {
      cmdNotesList(getDb(), projectSlug, opts);
    }
  );

// pai notes list [project-slug] — explicit sub-action (same behaviour)
notesCmd
  .command("list [project-slug]")
  .description("List markdown session notes (same as: pai notes)")
  .option("--limit <n>", "Maximum number of notes to show", "20")
  .option("--status <status>", "Filter by status: open | completed | compacted")
  .action(
    (
      projectSlug: string | undefined,
      opts: { limit?: string; status?: string }
    ) => {
      cmdNotesList(getDb(), projectSlug, opts);
    }
  );

// ---------------------------------------------------------------------------
// pai find <query>  — explicit history search (power user alias)
// ---------------------------------------------------------------------------

program
  .command("find <query>")
  .description(
    "Search prompt history for matching sessions.\n" +
      "Same as: pai <query>  (the default command does history search too)"
  )
  .option("-n, --n <count>", "Maximum number of sessions to show", "20")
  .option("--json", "Output as JSON array")
  .action(async (query: string, opts: { n?: string; json?: boolean }) => {
    await cmdFind(query, opts);
  });

// ---------------------------------------------------------------------------
// pai shell-init  — emit shell function for eval "$(pai shell-init)"
// ---------------------------------------------------------------------------

program
  .command("shell-init")
  .description(
    "Emit shell integration code. Add to ~/.zshrc:\n" +
      '  eval "$(pai shell-init)"'
  )
  .action(() => {
    // The shell function intercepts commands that need a real `cd`:
    //   pai cd <name>           → resolves via pai cd, then builtin cd
    //   pai projects cd <name>  → same (long form)
    // Everything else is passed through to the real pai binary unchanged.
    process.stdout.write(
      `# PAI shell integration — generated by: pai shell-init
pai() {
  if [[ "$1" == "cd" ]]; then
    local dir=$(command pai cd "$2" 2>/dev/null)
    if [[ -n "$dir" && -d "$dir" ]]; then
      builtin cd "$dir"
      echo "-> $dir"
    else
      echo "Project not found: $2" >&2
      return 1
    fi
  elif [[ "$1" == "projects" && "$2" == "cd" ]]; then
    local dir=$(command pai projects cd "$3" 2>/dev/null)
    if [[ -n "$dir" && -d "$dir" ]]; then
      builtin cd "$dir"
      echo "-> $dir"
    else
      echo "Project not found: $3" >&2
      return 1
    fi
  else
    command pai "$@"
  fi
}
`
    );
  });

// ---------------------------------------------------------------------------
// pai [query] [pick]  — DEFAULT COMMAND: topic-first session resolver (v0.10.0)
//
// Must be registered LAST so named subcommands take priority.
// Commander matches named commands first; if nothing matches, this catches it.
// ---------------------------------------------------------------------------

program
  .command("query [query] [pick]", { isDefault: true, hidden: true })
  .description(
    "Find and launch a session by topic, name, or UUID.\n" +
      "No arg → recent sessions picker\n" +
      "Topic  → history search → candidate list → pick #\n" +
      "UUID   → direct resume via filesystem scan"
  )
  .option("-y, --auto", "Auto-pick #1 without prompting")
  .option("--dry-run", "Print what would happen without launching")
  .option("-n, --n <count>", "Max candidates for history search", "20")
  .action(async (query: string | undefined, pick: string | undefined, opts: { auto?: boolean; dryRun?: boolean; n?: string }) => {
    const pickN = pick !== undefined ? parseInt(pick, 10) : undefined;
    await cmdMain(getDb(), query, pickN, opts);
  });

// ---------------------------------------------------------------------------
// Error handling — show clean message instead of stack trace for user errors
// ---------------------------------------------------------------------------

program.configureOutput({
  writeErr: (str) => process.stderr.write(err(str)),
});

program.exitOverride((error) => {
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    process.exit(0);
  }
  if (
    error.code === "commander.missingArgument" ||
    error.code === "commander.unknownOption" ||
    error.code === "commander.unknownCommand"
  ) {
    // Commander has already printed the message
    process.exit(1);
  }
  // For unexpected errors, show message but not stack trace
  console.error(err(error.message));
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
