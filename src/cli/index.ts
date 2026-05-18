#!/usr/bin/env node
/**
 * PAI Knowledge OS — CLI entry point
 *
 * Command tree:
 *   pai sessions list|goto|pause|info|rename|...  (canonical plural namespace)
 *   pai projects list|cd|add|info|...             (canonical plural namespace)
 *   pai registry scan|migrate|stats|rebuild
 *   pai memory   index|search|status
 *   pai search   <query>   (placeholder — Phase 3)
 *   pai update
 *   pai version
 *
 * Daily verb shortcuts (top-level):
 *   pai pause / pai resume / pai cd
 *   pai sessions / pai projects / pai notes
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openRegistry } from "../registry/db.js";
import type { Database } from "better-sqlite3";
import { registerProjectsCommands, cmdGo } from "./commands/project/projects-index.js";
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
import { err } from "./utils.js";
import { cmdPause } from "./commands/session/pause.js";
import { cmdGoto } from "./commands/session/goto.js";
import { cmdRecent } from "./commands/session/recent.js";
import { cmdList as cmdNotesList } from "./commands/session/commands.js";
import { resolveIdentifier } from "./commands/project/helpers.js";

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
Daily verbs (short forms):
  pai pause               Save state + display safe-exit reminder
  pai resume <name>       Go to a session (resume or start fresh)
  pai cd <name>           cd to a project directory

Listings:
  pai sessions            Resumable sessions catalog
  pai projects            Known project directories
  pai notes               Markdown session notes

Subcommands (power users):
  pai sessions ...        Session management (list, goto, pause, ...)
  pai projects ...        Project management (cd, list, ...)
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
// pai go <query>  — top-level shortcut for pai project go
// ---------------------------------------------------------------------------

program
  .command("go <query>")
  .description(
    "Jump to a project directory by slug or partial name.\n" +
    "Prints the root path to stdout — use with: cd $(pai go <query>)\n" +
    "Example shell function in ~/.zshrc:\n" +
    "  pcd() { cd \"$(pai go \"$@\")\" }"
  )
  .action((query: string) => {
    cmdGo(getDb(), query);
  });

// ---------------------------------------------------------------------------
// DAILY VERBS — top-level short forms
// ---------------------------------------------------------------------------

// pai pause [--dry-run]
program
  .command("pause")
  .description(
    "Save state and display safe-exit instructions for the current session.\n" +
      "Writes a ## Continue checkpoint to the project's TODO.md.\n" +
      "Long form: pai sessions pause"
  )
  .option("--dry-run", "Preview the ## Continue block without writing it")
  .action((opts: { dryRun?: boolean }) => {
    cmdPause(getDb(), opts);
  });

// pai resume <name> [--skip-name] [--skip-go] [--dry-run]
program
  .command("resume <name>")
  .description(
    "Go to a session by name: resume if resumable, start fresh otherwise.\n" +
      "Long form: pai sessions goto <name>"
  )
  .option("--skip-name", "Do not prepend /Name to restore the session name")
  .option("--skip-go", "Do not append \\ngo to trigger PAI auto-resume")
  .option("--dry-run", "Print the exact argv and cwd, then exit without launching")
  .action(
    (name: string, opts: { skipName?: boolean; skipGo?: boolean; dryRun?: boolean }) => {
      cmdGoto(getDb(), name, { noName: opts.skipName, noGo: opts.skipGo, dryRun: opts.dryRun });
    }
  );

// pai cd <identifier>  — prints path; shell wrapper does the actual cd
program
  .command("cd <identifier>")
  .description(
    "cd to a project directory (shell wrapper handles the actual cd).\n" +
      "Long form: pai projects cd <identifier>\n" +
      "The shell function installed by pai shell-init intercepts this command\n" +
      "and calls builtin cd with the resolved path."
  )
  .action((identifier: string) => {
    const project = resolveIdentifier(getDb(), identifier);
    if (!project) {
      console.error(`Project not found: ${identifier}`);
      process.exit(1);
    }
    process.stdout.write(project.root_path + "\n");
  });

// Note: `pai sessions` and `pai projects` are now defined as the canonical
// namespaces above (with `isDefault: true` on their `list` subcommands).
// Bare invocation (`pai sessions`, `pai projects`) triggers the default list.

// ---------------------------------------------------------------------------
// pai notes  — markdown session notes
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
// pai search <query>  (Phase 3 placeholder)
// ---------------------------------------------------------------------------

program
  .command("search <query>")
  .description("Full-text search across sessions and notes (Phase 3)")
  .option("--projects <p1,p2>", "Restrict search to these project slugs (comma-separated)")
  .option("--limit <n>", "Maximum results to return", "10")
  .action((query: string, opts: { projects?: string; limit?: string }) => {
    console.log(
      `\n  Search is coming in Phase 3.\n\n` +
        `  Query:    ${query}\n` +
        `  Projects: ${opts.projects ?? "(all)"}\n` +
        `  Limit:    ${opts.limit ?? 10}\n`
    );
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

// If no sub-command given, print help
if (process.argv.length <= 2) {
  program.help();
}
