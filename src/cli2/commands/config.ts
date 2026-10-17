/**
 * `pai config`: front end for the config commands.
 * Behaviour lives in src/cli2/impl/config.js; this file declares names, flags and help.
 */

import type { CommandDef } from "../define.js";
import { legacyRunner } from "../lib/legacy.js";
import { registerConfigCommands } from "../impl/config.js";

const L = legacyRunner("config", registerConfigCommands);

export const configSubcommands: CommandDef[] = [
L({
  name: "path",
  summary: "Print where PAI keeps its settings",
  description: "Print where PAI keeps its settings.\n\nPrint the PAI_HOME namespace dir and each resolved per-user file",
  examples: ["pai config path","pai config path"],
  seeAlso: ["pai config yaml"],
}),
L({
  name: "yaml",
  summary: "Convert config.json to config.yaml",
  description: "Convert config.json to config.yaml.\n\nConvert config.json → config.yaml (and voices.json → voices.yaml), with a short\n      # comment above every top-level section and any \"_comment\"/\"_...Note\" JSON-\n      workaround key re-attached as a real comment. Verifies the generated YAML\n      re-parses to the exact same data before writing anything; the JSON is then\n      renamed to <name>.migrated-<YYYY-MM-DD> (never deleted). Every writer keeps\n      working unmodified afterwards — see docs/config.md.",
  options: [{ name: "dry-run", type: "boolean", summary: "Print the plan without writing anything" }, { name: "force", type: "boolean", summary: "Regenerate config.yaml (or voices.yaml) even if it already exists" }],
  examples: ["pai config yaml --dry-run","pai config yaml"],
  seeAlso: ["pai config list","pai config path"],
}),
L({
  name: "list",
  summary: "Print all settings (secrets hidden)",
  description: "Print all settings (secrets hidden).\n\nPrint the main PAI config as YAML (secrets masked). Defaults to what the file explicitly sets.",
  options: [{ name: "all", type: "boolean", summary: "Include every default value, not just what the file sets" }, { name: "json", type: "boolean", summary: "Print JSON instead of YAML" }],
  examples: ["pai config list","pai config list --json"],
  seeAlso: ["pai config get","pai config yaml"],
}),
L({
  name: "get",
  summary: "Print one setting",
  description: "Print one setting.\n\nPrint one config value (dotted path, e.g. search.recencyBoostDays), masked if it looks like a secret. An object/array subtree prints as YAML; pass --json for JSON.",
  args: [{ name: "PATH", summary: "Setting name with dots, e.g. search.recencyBoostDays", required: true }],
  options: [{ name: "json", type: "boolean", summary: "Print an object/array value as JSON instead of YAML" }],
  examples: ["pai config get search.recencyBoostDays","pai config get search.recencyBoostDays --json"],
  seeAlso: ["pai config set","pai config list"],
}),
L({
  name: "set",
  summary: "Change one setting",
  description: "Change one setting.\n\nSet one config value (dotted path). Value parsing: true/false, null, numbers,\n      [...] / {...} as JSON, else a string. Creates config.yaml (from config.json,\n      if any) on first use, then writes comment-preserving.",
  args: [{ name: "PATH", summary: "Setting name with dots, e.g. search.recencyBoostDays", required: true }, { name: "VALUE", summary: "The new value", required: true }],
  options: [{ name: "force", type: "boolean", summary: "Set an unknown top-level key, or a value of a different type than the default" }],
  examples: ["pai config set search.recencyBoostDays 7","pai config set search.recencyBoostDays 7 --force"],
  seeAlso: ["pai config unset","pai config get"],
}),
L({
  name: "unset",
  summary: "Reset one setting to its default",
  description: "Reset one setting to its default.\n\nRemove one config value (dotted path), reverting it to the built-in default",
  args: [{ name: "PATH", summary: "Setting name with dots, e.g. search.recencyBoostDays", required: true }],
  examples: ["pai config unset search.recencyBoostDays","pai config list"],
  seeAlso: ["pai config migrate","pai config set"],
}),
L({
  name: "migrate",
  summary: "Move old settings files into the current layout",
  description: "Move old settings files into the current layout.\n\nMove config.json, workers.yaml, whisper-rules.md, advisor-mode.json, session-state/,\nsession-scan-cache.json, queries/, summary-cooldowns.json, work-queue.json,\nkg-backfill-state.json, voices.json, the orphaned legacy federation database,\nthe legacy registry database, the legacy live federation database, ~/.pai/backups/,\n~/.pai/obsidian-vault/, ~/.pai/scheduler-state.json, and ~/.claude/agents/,\n~/.claude/commands/ into PAI_HOME.\nThe registry and federation databases each get an extra WAL checkpoint and PRAGMA\nintegrity_check (sqlite3 CLI, if present) on top of the byte-identical copy.\nbackups/ is copied and sha256-verified file-by-file into\nbackups/legacy-pai-backups/ rather than merged in place. agents/ and commands/ each\nget a symlink left at the old ~/.claude path once their content has moved, so\nClaude Code still finds them at its fixed harness paths.\nEach file is copied, verified byte-identical, then the old file is renamed to\n<name>.migrated-<YYYYMMDD> (never deleted); directories move their contents, then\nthe emptied old directory is renamed the same way. Idempotent — entries already at\nthe new location, or with nothing old to migrate, are skipped.",
  options: [{ name: "dry-run", type: "boolean", summary: "Print the plan without writing anything" }, { name: "logs", type: "boolean", summary: "Also move ~/.claude/logs/workers into PAI_HOME: an atomic rename plus a symlink left at the old path, so any worker still writing there keeps landing in the new directory (falls back to copy+verify across volumes, refusing while a worker is RUNNING — see `pai worker ps` — only in that fallback case)" }, { name: "history", type: "boolean", summary: "Also move ~/.claude/History/, agent-sessions.json, session-routing.json and history/security/security-events.jsonl into PAI_HOME. These are written by hooks on EVERY session's every turn, not just spawned workers — refuses while any worker other than the interactive session is RUNNING (see `pai worker ps`), but that guard cannot see OTHER interactive `claude` sessions on this machine. Confirm none are active (`ps aux | grep claude`, `aibroker sessions list`) before passing this flag." }],
  examples: ["pai config migrate --dry-run","pai config migrate"],
  seeAlso: ["pai config unset"],
}),
];

export const configCommand: CommandDef = {
  name: "config",
  summary: "PAI settings: show, read, change",
  description: "PAI settings: show, read, change.",
  examples: ["pai config path","pai config list"],
  subcommands: configSubcommands,
};
