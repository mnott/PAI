/**
 * settings-manager — merge-not-overwrite utility for ~/.claude/settings.json
 *
 * Provides safe, idempotent writes to Claude Code's settings.json:
 *   - env vars: added only if the key is absent (never overwrites)
 *   - hooks: appended per hookType, deduplicated by command string
 *   - statusLine: written only if the key is not already present
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookType =
  | "PreCompact"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStop";

export interface HookEntry {
  hookType: HookType;
  matcher?: string;
  command: string;
}

export interface SettingsMergeOptions {
  env?: Record<string, string>;
  hooks?: HookEntry[];
  statusLine?: { type: string; command: string };
}

export interface MergeResult {
  changed: boolean;
  report: string[];
}

// ---------------------------------------------------------------------------
// Internal shape of settings.json hooks
// ---------------------------------------------------------------------------

interface HookCommand {
  type: string;
  command: string;
}

interface HookRule {
  matcher?: string;
  hooks: HookCommand[];
}

type HooksSection = Partial<Record<HookType, HookRule[]>>;

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

export function readSettingsJson(): Record<string, unknown> {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeSettingsJson(data: Record<string, unknown>): void {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

/**
 * Merge env vars — add keys that are absent, never overwrite existing ones.
 */
function mergeEnv(
  settings: Record<string, unknown>,
  incoming: Record<string, string>,
  report: string[],
): boolean {
  let changed = false;

  const existing = (
    typeof settings["env"] === "object" && settings["env"] !== null
      ? settings["env"]
      : {}
  ) as Record<string, string>;

  for (const [key, value] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      report.push(chalk.dim(`  Skipped: env.${key} already set`));
    } else {
      existing[key] = value;
      report.push(chalk.green(`  Added env: ${key}`));
      changed = true;
    }
  }

  settings["env"] = existing;
  return changed;
}

/**
 * Collect every command string already registered for a given hookType.
 * Stores both the full command and the basename for flexible matching
 * (handles ${PAI_DIR}/Hooks/foo.sh vs /Users/.../Hooks/foo.sh).
 */
function existingCommandsForHookType(rules: HookRule[]): Set<string> {
  const cmds = new Set<string>();
  for (const rule of rules) {
    for (const entry of rule.hooks) {
      cmds.add(entry.command);
      // Also add the basename so expanded paths match template paths
      const base = entry.command.split("/").pop();
      if (base) cmds.add(base);
    }
  }
  return cmds;
}

/**
 * Merge hooks — append entries, deduplicating by command string.
 */
function mergeHooks(
  settings: Record<string, unknown>,
  incoming: HookEntry[],
  report: string[],
): boolean {
  let changed = false;

  const hooksSection = (
    typeof settings["hooks"] === "object" && settings["hooks"] !== null
      ? settings["hooks"]
      : {}
  ) as HooksSection;

  for (const entry of incoming) {
    const { hookType, matcher, command } = entry;

    const existingRules: HookRule[] = Array.isArray(hooksSection[hookType])
      ? (hooksSection[hookType] as HookRule[])
      : [];

    const existingCmds = existingCommandsForHookType(existingRules);

    const basename = command.split("/").pop() ?? command;
    if (existingCmds.has(command) || existingCmds.has(basename)) {
      report.push(chalk.dim(`  Skipped: hook ${hookType} → ${basename} already registered`));
      continue;
    }

    // Append a new rule with this command
    const newRule: HookRule = {
      hooks: [{ type: "command", command }],
    };
    if (matcher !== undefined) {
      newRule.matcher = matcher;
    }

    existingRules.push(newRule);
    hooksSection[hookType] = existingRules;

    report.push(chalk.green(`  Added hook: ${hookType} → ${basename}`));
    changed = true;
  }

  settings["hooks"] = hooksSection;
  return changed;
}

/**
 * Merge statusLine — write only if the key is not already present.
 */
function mergeStatusLine(
  settings: Record<string, unknown>,
  incoming: { type: string; command: string },
  report: string[],
): boolean {
  if (Object.prototype.hasOwnProperty.call(settings, "statusLine")) {
    report.push(chalk.dim("  Skipped: statusLine already configured"));
    return false;
  }

  settings["statusLine"] = { ...incoming };
  report.push(chalk.green("  Added statusLine"));
  return true;
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

/**
 * Merge env vars, hooks, and/or a statusLine entry into ~/.claude/settings.json.
 * Never overwrites existing values — only adds what is missing.
 *
 * Returns { changed, report } where report contains human-readable lines.
 */
export function mergeSettings(opts: SettingsMergeOptions): MergeResult {
  const settings = readSettingsJson();
  const report: string[] = [];
  let changed = false;

  if (opts.env !== undefined && Object.keys(opts.env).length > 0) {
    if (mergeEnv(settings, opts.env, report)) changed = true;
  }

  if (opts.hooks !== undefined && opts.hooks.length > 0) {
    if (mergeHooks(settings, opts.hooks, report)) changed = true;
  }

  if (opts.statusLine !== undefined) {
    if (mergeStatusLine(settings, opts.statusLine, report)) changed = true;
  }

  if (changed) {
    writeSettingsJson(settings);
  }

  return { changed, report };
}
