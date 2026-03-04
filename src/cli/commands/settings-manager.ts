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
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  flags?: Record<string, unknown>;
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
 * Strip file extension from a command basename for extension-agnostic dedup.
 * This ensures that e.g. "context-compression-hook.ts" and
 * "context-compression-hook.mjs" are treated as the same hook.
 */
function commandStem(cmd: string): string {
  const base = cmd.split("/").pop() ?? cmd;
  return base.replace(/\.(mjs|ts|js|sh)$/, "");
}

/**
 * Collect every command string already registered for a given hookType.
 * Stores full command, basename, AND extension-stripped stem for flexible
 * matching (handles ${PAI_DIR}/Hooks/foo.sh vs /Users/.../Hooks/foo.sh,
 * and .ts → .mjs migrations).
 */
function existingCommandsForHookType(rules: HookRule[]): Set<string> {
  const cmds = new Set<string>();
  for (const rule of rules) {
    for (const entry of rule.hooks) {
      cmds.add(entry.command);
      // Also add the basename so expanded paths match template paths
      const base = entry.command.split("/").pop();
      if (base) cmds.add(base);
      // Also add extension-stripped stem for cross-extension dedup
      cmds.add(commandStem(entry.command));
    }
  }
  return cmds;
}

/**
 * Find and remove an existing rule whose command has the same stem
 * (extension-agnostic) as the incoming command. Returns true if a
 * replacement was made. This handles .ts → .mjs migrations cleanly.
 */
function replaceStaleHook(
  existingRules: HookRule[],
  incomingStem: string,
  incomingCommand: string,
  incomingMatcher: string | undefined,
): boolean {
  for (let i = 0; i < existingRules.length; i++) {
    const rule = existingRules[i];
    for (let j = 0; j < rule.hooks.length; j++) {
      const existingStem = commandStem(rule.hooks[j].command);
      if (existingStem === incomingStem && rule.hooks[j].command !== incomingCommand) {
        // Replace the old command with the new one
        rule.hooks[j].command = incomingCommand;
        // Update matcher if provided
        if (incomingMatcher !== undefined) {
          rule.matcher = incomingMatcher;
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * Merge hooks — append entries, deduplicating by command string.
 * Extension-agnostic: a .mjs hook replaces an existing .ts hook with the
 * same stem, ensuring clean .ts → .mjs migrations without duplicates.
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

    const basename = command.split("/").pop() ?? command;
    const stem = commandStem(command);

    // Exact match — already registered, skip
    const existingCmds = existingCommandsForHookType(existingRules);
    if (existingCmds.has(command) || existingCmds.has(basename)) {
      report.push(chalk.dim(`  Skipped: hook ${hookType} → ${basename} already registered`));
      continue;
    }

    // Stem match with different extension — replace old entry (.ts → .mjs migration)
    if (existingCmds.has(stem)) {
      if (replaceStaleHook(existingRules, stem, command, matcher)) {
        hooksSection[hookType] = existingRules;
        report.push(chalk.yellow(`  Upgraded: hook ${hookType} → ${basename} (replaced stale extension)`));
        changed = true;
        continue;
      }
    }

    // No match at all — append new rule
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

/**
 * Merge permissions — append allow/deny entries, deduplicating.
 */
function mergePermissions(
  settings: Record<string, unknown>,
  incoming: { allow?: string[]; deny?: string[] },
  report: string[],
): boolean {
  let changed = false;

  const perms = (
    typeof settings["permissions"] === "object" && settings["permissions"] !== null
      ? settings["permissions"]
      : {}
  ) as Record<string, string[]>;

  for (const list of ["allow", "deny"] as const) {
    const entries = incoming[list];
    if (!entries || entries.length === 0) continue;

    const existing: string[] = Array.isArray(perms[list]) ? perms[list] : [];
    const existingSet = new Set(existing);

    for (const entry of entries) {
      if (existingSet.has(entry)) {
        report.push(chalk.dim(`  Skipped: permissions.${list} "${entry}" already present`));
      } else {
        existing.push(entry);
        existingSet.add(entry);
        report.push(chalk.green(`  Added permissions.${list}: ${entry}`));
        changed = true;
      }
    }

    perms[list] = existing;
  }

  settings["permissions"] = perms;
  return changed;
}

/**
 * Merge flags — set keys only if not already present, never overwrite.
 */
function mergeFlags(
  settings: Record<string, unknown>,
  incoming: Record<string, unknown>,
  report: string[],
): boolean {
  let changed = false;

  for (const [key, value] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      report.push(chalk.dim(`  Skipped: ${key} already set`));
    } else {
      settings[key] = value;
      report.push(chalk.green(`  Added flag: ${key}`));
      changed = true;
    }
  }

  return changed;
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

  if (opts.permissions !== undefined) {
    if (mergePermissions(settings, opts.permissions, report)) changed = true;
  }

  if (opts.flags !== undefined && Object.keys(opts.flags).length > 0) {
    if (mergeFlags(settings, opts.flags, report)) changed = true;
  }

  if (changed) {
    writeSettingsJson(settings);
  }

  return { changed, report };
}
