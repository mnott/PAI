/**
 * PAI CLI — Commander program builder.
 *
 * Constructs the full `pai` command tree WITHOUT parsing argv. This separation
 * lets the documentation generator (scripts/build-docs.mjs) import and introspect
 * the live program object — the single source of truth for `--help`, the
 * generated man pages, and `pai help <area>`.
 *
 * The thin entry point (cli/index.ts) imports buildProgram() and calls parse().
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
import { registerSkillCommands } from "./commands/skill.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerNotifyCommands } from "./commands/notify.js";
import { registerTopicCommands } from "./commands/topic.js";
import { registerKgCommands } from "./commands/kg.js";
import { registerDbCommands } from "./commands/db.js";
import { registerHelpCommand } from "./commands/help.js";
import { err, warn, ok, dim, shortenPath, encodeDir, now } from "./utils.js";
import { cmdPause } from "./commands/session/pause.js";
import { cmdEnd } from "./commands/session/end.js";
import { cmdGoto } from "./commands/session/goto.js";
import { cmdPauseAll } from "./commands/session/pause-all.js";
import { cmdClearNames } from "./commands/session/clear-names.js";
import { cmdList as cmdNotesList } from "./commands/session/commands.js";
import { resolveIdentifier } from "./commands/project/helpers.js";
import { cmdFind } from "./commands/find.js";
import { cmdMain } from "./commands/main-resolver.js";
import { cmdPick } from "./commands/pick.js";

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Lazy database singleton
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
// Program builder
// ---------------------------------------------------------------------------

/**
 * Build and return the fully configured `pai` Commander program.
 * Does NOT call parse — the caller (cli/index.ts) does that.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("pai")
    .description("PAI Knowledge OS — Personal AI Infrastructure CLI")
    .version(getVersion(), "-V, --version", "Print version and exit")
    .addHelpText(
      "after",
      `
Daily commands:
  pai                     Show your work: live tabs + recent sessions + recent projects
  pai <name>              Switch / resume / fresh — universal
  pai pause [all]         Pause current (or all live) sessions
  pai end                 Finalize current session

Subcommands (rarely needed):
  pai projects ...        Project registry management (cd, rebind, info, ...)
  pai registry ...        Registry maintenance (scan, ...)
  pai memory ...          Memory engine (index, search, ...)
  pai shell-init          Shell integration (eval "$(pai shell-init)")

Recovery:
  pai clear-names         Wipe corrupt iTerm tab-name store

Examples:
  pai aibroker            Switch to the live AIBroker tab in iTerm
  pai mdf                 Find sessions where you worked on MDF
  pai 81c5c3dc            Resume session by UUID prefix
  pai --all               Show everything including cold and zero-session projects`
    );

  // -------------------------------------------------------------------------
  // pai projects  (canonical plural namespace)
  // -------------------------------------------------------------------------

  const projectsCmd = program
    .command("projects")
    .description("Manage registered projects (list, cd, add, info, ...)");

  registerProjectsCommands(projectsCmd, getDb);

  // Singular alias: `pai project` → `pai projects`
  const projectCmd = program
    .command("project")
    .description("Alias for `pai projects`");

  registerProjectsCommands(projectCmd, getDb);

  // -------------------------------------------------------------------------
  // pai sessions  (alias for the unified `pai` listing)
  // -------------------------------------------------------------------------

  program
    .command("sessions")
    .description("Alias for `pai` — show the unified deduped listing.")
    .option("--all", "Show all entries including cold / zero-session / archived projects")
    .option("-n, --n <count>", "Max candidates for history search", "20")
    .action(async (opts: { all?: boolean; n?: string }) => {
      await cmdMain(getDb(), undefined, undefined, opts);
    });

  // -------------------------------------------------------------------------
  // pai registry
  // -------------------------------------------------------------------------

  const registryCmd = program
    .command("registry")
    .description("Registry maintenance: scan, migrate, stats, rebuild");

  registerRegistryCommands(registryCmd, getDb);

  // -------------------------------------------------------------------------
  // pai memory
  // -------------------------------------------------------------------------

  const memoryCmd = program
    .command("memory")
    .description("Memory engine: index, search, and status");

  registerMemoryCommands(memoryCmd, getDb);

  // -------------------------------------------------------------------------
  // pai mcp
  // -------------------------------------------------------------------------

  const mcpCmd = program
    .command("mcp")
    .description("MCP server management: install and status");

  registerMcpCommands(mcpCmd);

  // -------------------------------------------------------------------------
  // pai daemon
  // -------------------------------------------------------------------------

  const daemonCmd = program
    .command("daemon")
    .description("PAI daemon management: serve, status, restart, install, uninstall, logs");

  registerDaemonCommands(daemonCmd);

  // -------------------------------------------------------------------------
  // pai backup / pai restore
  // -------------------------------------------------------------------------

  registerBackupCommands(program);
  registerRestoreCommands(program);

  // -------------------------------------------------------------------------
  // pai setup / pai update
  // -------------------------------------------------------------------------

  registerSetupCommand(program);
  registerUpdateCommand(program);

  // -------------------------------------------------------------------------
  // pai notify
  // -------------------------------------------------------------------------

  const notifyCmd = program
    .command("notify")
    .description("Notification config: status, get, set, test, send");

  registerNotifyCommands(notifyCmd);

  // -------------------------------------------------------------------------
  // pai topic
  // -------------------------------------------------------------------------

  const topicCmd = program
    .command("topic")
    .description("Topic shift detection: check whether context has drifted to a different project");

  registerTopicCommands(topicCmd);

  // -------------------------------------------------------------------------
  // pai kg
  // -------------------------------------------------------------------------

  const kgCmd = program
    .command("kg")
    .description("Temporal knowledge graph: backfill, query, list, stats");

  registerKgCommands(kgCmd);

  // -------------------------------------------------------------------------
  // pai db
  // -------------------------------------------------------------------------

  const dbCmd = program
    .command("db")
    .description("Database inspection: query, tables, schema (sqlite or postgres)");

  registerDbCommands(dbCmd);

  // -------------------------------------------------------------------------
  // pai obsidian
  // -------------------------------------------------------------------------

  const obsidianCmd = program
    .command("obsidian")
    .description("Obsidian vault: sync project notes, view status, open in Obsidian");

  registerObsidianCommands(obsidianCmd, getDb);

  // -------------------------------------------------------------------------
  // pai zettel
  // -------------------------------------------------------------------------

  const zettelCmd = program
    .command("zettel")
    .description("Zettelkasten intelligence: explore, surprise, converse, themes, health, suggest");

  registerZettelCommands(zettelCmd, getDb);

  // -------------------------------------------------------------------------
  // pai observation
  // -------------------------------------------------------------------------

  const observationCmd = program
    .command("observation")
    .description("Observation capture: list, search, and stats");

  registerObservationCommands(observationCmd);

  // -------------------------------------------------------------------------
  // pai skill
  // -------------------------------------------------------------------------

  const skillCmd = program
    .command("skill")
    .description("Skill telemetry and (future) discovery for the self-educating skill system");

  registerSkillCommands(skillCmd);

  // -------------------------------------------------------------------------
  // pai help [area]  — rich man-page viewer for the generated docs
  // -------------------------------------------------------------------------

  registerHelpCommand(program);

  // -------------------------------------------------------------------------
  // DAILY VERBS — top-level
  // -------------------------------------------------------------------------

  // pai pause [all] [--dry-run] [--exit] [--wait <ms>]
  program
    .command("pause [target]")
    .description(
      "Save state and display safe-exit instructions for the current session.\n" +
        "Writes a ## Continue checkpoint to the project's TODO.md.\n" +
        "Use `pai pause all` to pause every live session via AIBroker."
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
          console.error(err(`Unknown target: ${target}. Did you mean 'pai pause all'?`));
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
      "Finalize a session: save state, mark note Completed, display safe-exit instructions."
    )
    .option("--dry-run", "Preview all changes without writing them")
    .action((opts: { dryRun?: boolean }) => {
      cmdEnd(getDb(), opts);
    });

  // pai clear-names [--dry-run]  — recovery: wipe corrupt iTerm/JSON name store
  program
    .command("clear-names")
    .description(
      "Recovery: wipe corrupted iTerm2 session name state.\n" +
        "Clears ~/.aibroker/session-names.json AND user.paiName from all live iTerm2 sessions.\n" +
        "After running this, use /Name to re-label each tab."
    )
    .option("--dry-run", "Preview what would be cleared without making changes")
    .action(async (opts: { dryRun?: boolean }) => {
      await cmdClearNames(opts);
    });

  // -------------------------------------------------------------------------
  // HIDDEN COMPAT ALIASES
  // -------------------------------------------------------------------------

  // pai resume <name> [--dry-run]  — hidden; prefer `pai <name>`
  program
    .command("resume <name>", { hidden: true })
    .description("Go to a session by name or UUID (prefer: pai <name>)")
    .option("--dry-run", "Print the exact argv and cwd, then exit without launching")
    .action((name: string, opts: { dryRun?: boolean }) => {
      cmdGoto(getDb(), name, { dryRun: opts.dryRun });
    });

  // pai cd <identifier>  — hidden; shell wrapper uses this
  program
    .command("cd <identifier>", { hidden: true })
    .description("cd to a project directory (shell wrapper handles the actual cd)")
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

  // -------------------------------------------------------------------------
  // pai notes  — hidden power-user alias; accessible but not in main help
  // -------------------------------------------------------------------------

  const notesCmd = program
    .command("notes [project-slug]", { hidden: true })
    .description("Markdown session notes — list notes, optionally filtered to a project.")
    .option("--limit <n>", "Maximum number of notes to show", "20")
    .option("--status <status>", "Filter by status: open | completed | compacted")
    .action(
      (projectSlug: string | undefined, opts: { limit?: string; status?: string }) => {
        cmdNotesList(getDb(), projectSlug, opts);
      }
    );

  notesCmd
    .command("list [project-slug]")
    .description("List markdown session notes (same as: pai notes)")
    .option("--limit <n>", "Maximum number of notes to show", "20")
    .option("--status <status>", "Filter by status: open | completed | compacted")
    .action(
      (projectSlug: string | undefined, opts: { limit?: string; status?: string }) => {
        cmdNotesList(getDb(), projectSlug, opts);
      }
    );

  // -------------------------------------------------------------------------
  // pai find <query>  — hidden power-user alias for history search
  // -------------------------------------------------------------------------

  program
    .command("find <query>", { hidden: true })
    .description("Search prompt history for matching sessions.")
    .option("-n, --n <count>", "Maximum number of sessions to show", "20")
    .option("--json", "Output as JSON array")
    .action(async (query: string, opts: { n?: string; json?: boolean }) => {
      await cmdFind(query, opts);
    });

  // -------------------------------------------------------------------------
  // pai shell-init  — emit shell function for eval "$(pai shell-init)"
  // -------------------------------------------------------------------------

  program
    .command("shell-init")
    .description('Emit shell integration code. Add to ~/.zshrc: eval "$(pai shell-init)"')
    .action(() => {
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
  elif [[ $# -eq 0 ]]; then
    # Bare \`pai\` → interactive picker. fzf draws on /dev/tty; the picker writes
    # a chosen directory to PAI_PICK_OUT when you press Ctrl-G (cd only), which we
    # then cd into here (a child process can't change this shell's cwd itself).
    local __pai_f
    __pai_f=$(mktemp -t pai-pick 2>/dev/null) || { command pai; return $?; }
    PAI_PICK_OUT="$__pai_f" command pai
    local __pai_rc=$?
    local __pai_dir=""
    [[ -s "$__pai_f" ]] && __pai_dir=$(cat "$__pai_f")
    command rm -f "$__pai_f"
    if [[ -n "$__pai_dir" && -d "$__pai_dir" ]]; then
      builtin cd "$__pai_dir"
      echo "-> $__pai_dir"
    fi
    return $__pai_rc
  else
    command pai "$@"
  fi
}

# Print the working directory after an interactive Claude Code session exits.
# A SessionEnd hook can't do this reliably: Claude Code does not fire SessionEnd
# on /exit (anthropics/claude-code#17885) and may reap the hook mid-run (#41577).
# Running it from the shell, after \`claude\` returns, sidesteps both.
claude() {
  local __pai_skip=0 __pai_arg
  for __pai_arg in "$@"; do
    case "$__pai_arg" in
      -p|--print) __pai_skip=1 ;;
    esac
  done
  command claude "$@"
  local __pai_rc=$?
  if [[ -t 1 && $__pai_skip -eq 0 ]]; then
    printf '\\n\\033[2m📂 Working directory:\\033[0m %s\\n\\033[2m   cd "%s"\\033[0m\\n' "$PWD" "$PWD"
  fi
  return $__pai_rc
}
`
      );
    });

  // -------------------------------------------------------------------------
  // pai [query] [pick]  — DEFAULT COMMAND (must be registered LAST)
  // -------------------------------------------------------------------------

  program
    .command("query [query] [pick]", { isDefault: true, hidden: true })
    .description(
      "Find and launch a session by topic, name, or UUID.\n" +
        "No arg → deduped session listing\n" +
        "Name   → switch live tab, or resume, or start fresh\n" +
        "UUID   → direct resume via filesystem scan\n" +
        "Topic  → history search → candidate list → pick #"
    )
    .option("-y, --auto", "Auto-pick #1 without prompting")
    .option("--dry-run", "Print what would happen without launching")
    .option("-n, --n <count>", "Max candidates for history search", "20")
    .option("--all", "Show all entries including cold / zero-session / archived projects")
    .option("--list", "Skip the interactive picker; print the static session listing")
    .action(async (query: string | undefined, pick: string | undefined, opts: { auto?: boolean; dryRun?: boolean; n?: string; all?: boolean; list?: boolean }) => {
      // No query → interactive fzf picker (projects + sessions, go where you pick).
      // `--list` (or a non-TTY pipe, handled inside cmdPick) falls back to the
      // static listing. Any query still goes through the name/UUID/topic resolver.
      if (query === undefined && !opts.list) {
        await cmdPick(getDb(), { all: opts.all, dryRun: opts.dryRun });
        return;
      }
      const pickN = pick !== undefined ? parseInt(pick, 10) : undefined;
      await cmdMain(getDb(), query, pickN, opts);
    });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

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
      process.exit(1);
    }
    console.error(err(error.message));
    process.exit(1);
  });

  return program;
}
