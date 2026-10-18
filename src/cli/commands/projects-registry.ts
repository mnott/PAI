/**
 * `pai registry`: front end for the project registry.
 * Behaviour lives in src/cli/impl/registry/index.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import {
  registryStatsCmd,
  registryRebuildCmd,
  registryLookupCmd,
  registryScanCmd,
  registryMigrateCmd,
  registryDedupeCmd,
  registryReconnectCmd
} from "../impl/registry/index.js";

const registryScanCommand: CommandDef = {
  name: "scan",
  summary: "Find projects on disk and register them",
  description: "Find projects on disk and register them.\n\nWalk ~/.claude/projects/ and configured scan_dirs, upsert all projects",
  options: [
    { name: "add-dir", type: "string", value: "PATH", summary: "Add a directory to scan_dirs config" },
    { name: "remove-dir", type: "string", value: "PATH", summary: "Remove a directory from scan_dirs config" },
    { name: "show-dirs", type: "boolean", summary: "Show currently configured scan directories" },
    { name: "quick", type: "boolean", summary: "Minimal output mode (used by hooks and daemon)" }
  ],
  examples: ["pai registry scan","pai registry scan --show-dirs"],
  seeAlso: ["pai registry migrate"],
  run: (ctx) => registryScanCmd({
    addDir: ctx.opts["add-dir"] as string | undefined,
    removeDir: ctx.opts["remove-dir"] as string | undefined,
    showDirs: ctx.opts["show-dirs"] === true,
    quick: ctx.opts.quick === true
  }),
};

const registryMigrateCommand: CommandDef = {
  name: "migrate",
  summary: "Import the old session-registry.json",
  description: "Import the old session-registry.json.\n\nImport data from ~/.claude/session-registry.json",
  examples: ["pai registry migrate","pai registry stats"],
  seeAlso: ["pai registry stats","pai registry scan"],
  run: (ctx) => registryMigrateCmd(),
};

const registryStatsCommand: CommandDef = {
  name: "stats",
  summary: "Count what the registry holds",
  description: "Count what the registry holds.\n\nShow summary statistics for the registry",
  examples: ["pai registry stats","pai registry stats"],
  seeAlso: ["pai registry rebuild","pai registry migrate"],
  run: (ctx) => registryStatsCmd(),
};

const registryRebuildCommand: CommandDef = {
  name: "rebuild",
  summary: "Erase the registry and rebuild it from disk (destructive)",
  description: "Erase the registry and rebuild it from disk (destructive).\n\nErase all registry data and rebuild from the filesystem (destructive)",
  examples: ["pai registry rebuild","pai registry stats"],
  seeAlso: ["pai registry dedupe","pai registry stats"],
  run: (ctx) => registryRebuildCmd(),
};

const registryDedupeCommand: CommandDef = {
  name: "dedupe",
  summary: "Merge registry rows that describe the same project",
  description: "Merge registry rows that describe the same project.\n\nMerge registry rows that describe the same project.\nTwo spellings of one directory (e.g. via a symlinked path prefix) register\nas separate projects and split session history between them. Rows are grouped\nby resolved path, so a merge only happens when the paths are provably identical.\nDry-run by default; --execute backs up the registry first and merges in one transaction.",
  options: [{ name: "execute", type: "boolean", summary: "Actually perform the merge (default is dry-run)" }],
  examples: ["pai registry dedupe","pai registry dedupe --execute"],
  seeAlso: ["pai registry reconnect","pai registry rebuild"],
  run: (ctx) => registryDedupeCmd({ execute: ctx.opts.execute === true }),
};

const registryReconnectCommand: CommandDef = {
  name: "reconnect",
  summary: "Reconnect projects to transcripts they lost",
  description: "Reconnect projects to transcripts they lost.\n\nPoint projects back at the transcripts they lost.\nA project's encoded_dir is written once and never updated when the project\nmoves, so handovers, session digests and checkpoints silently find nothing.\nRepairs are read from the transcripts themselves — each records the cwd it ran\nin — rather than re-derived from the naming rule that broke.\nDry-run by default; --execute writes the corrected rows in one transaction.",
  options: [{ name: "execute", type: "boolean", summary: "Actually write the corrections (default is dry-run)" }],
  examples: ["pai registry reconnect","pai registry reconnect --execute"],
  seeAlso: ["pai registry lookup","pai registry dedupe"],
  run: (ctx) => registryReconnectCmd({ execute: ctx.opts.execute === true }),
};

const registryLookupCommand: CommandDef = {
  name: "lookup",
  summary: "Print the project name for a folder (for scripts)",
  description: "Print the project name for a folder (for scripts).\n\nFind the project slug for a filesystem path (for use in scripts)",
  options: [{ name: "path", type: "string", value: "PATH", summary: "Filesystem path to look up" }],
  examples: ["pai registry lookup --path ~/code/my-app","pai registry lookup --path ."],
  seeAlso: ["pai registry reconnect"],
  run: (ctx) => registryLookupCmd(ctx.opts.path as string),
};

export const registrySubcommands: CommandDef[] = [
  registryScanCommand,
  registryMigrateCommand,
  registryStatsCommand,
  registryRebuildCommand,
  registryDedupeCommand,
  registryReconnectCommand,
  registryLookupCommand,
];

export const registryCommand: CommandDef = {
  name: "registry",
  summary: "Maintain the project registry: scan, stats, rebuild",
  description: "Maintain the project registry: scan, stats, rebuild.",
  examples: ["pai registry stats","pai registry scan --quick"],
  subcommands: registrySubcommands,
};