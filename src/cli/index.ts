#!/usr/bin/env node
/**
 * PAI Knowledge OS — CLI entry point
 *
 * Command tree:
 *   pai project add|list|info|archive|unarchive|move|tag|alias|edit
 *   pai session  list|info
 *   pai registry scan|migrate|stats|rebuild
 *   pai memory   index|search|status
 *   pai search   <query>   (placeholder — Phase 3)
 *   pai version
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openRegistry } from "../registry/db.js";
import type { Database } from "better-sqlite3";
import { registerProjectCommands } from "./commands/project.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerSessionCleanupCommand } from "./commands/session-cleanup.js";
import { registerRegistryCommands } from "./commands/registry.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerBackupCommands } from "./commands/backup.js";
import { registerRestoreCommands } from "./commands/restore.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerObsidianCommands } from "./commands/obsidian.js";
import { err } from "./utils.js";

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
  .version(getVersion(), "-V, --version", "Print version and exit");

// ---------------------------------------------------------------------------
// pai project
// ---------------------------------------------------------------------------

const projectCmd = program
  .command("project")
  .description("Manage registered projects");

registerProjectCommands(projectCmd, getDb);

// ---------------------------------------------------------------------------
// pai session
// ---------------------------------------------------------------------------

const sessionCmd = program
  .command("session")
  .description("Browse session notes");

registerSessionCommands(sessionCmd, getDb);
registerSessionCleanupCommand(sessionCmd, getDb);

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
// pai obsidian
// ---------------------------------------------------------------------------

const obsidianCmd = program
  .command("obsidian")
  .description("Obsidian vault: sync project notes, view status, open in Obsidian");

registerObsidianCommands(obsidianCmd, getDb);

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
