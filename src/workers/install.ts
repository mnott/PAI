/**
 * install.ts — `pai worker install`: one command, whole migration.
 *
 * Three things:
 *
 *   1. ~/.claude/settings.json: point the PreToolUse "Agent" hook at
 *      ${PAI_DIR}/Hooks/route-agents-to-worker.mjs, replacing the old
 *      route-agents-to-glm.sh registration if present.
 *   2. ~/.local/bin compatibility shims (glm, glm-run, glm-ps, glm-log) that
 *      exec the pai equivalents, so every existing habit, alias and script
 *      keeps working. Anything already at those paths is moved aside to
 *      <name>.pre-pai once — never deleted.
 *   3. Remove the old route-agents-to-glm.sh from ~/.claude/Hooks (the
 *      settings.json entry is gone, so the file is dead).
 *
 * Idempotent: running it twice changes nothing the second time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeHomeDir } from "../config/pai-home.js";
import { readSettingsJson, writeSettingsJson } from "../cli/lib/settings-manager.js";

// Resolved at call time so a changed HOME / CLAUDE_CONFIG_DIR (tests, dry runs) is honoured.
const claudeDir = (): string => claudeHomeDir();
const hooksDir = (): string => join(claudeDir(), "Hooks");
const localBin = (): string => join(homedir(), ".local", "bin");

export const NEW_AGENT_HOOK = "${PAI_DIR}/Hooks/route-agents-to-worker.mjs";
const OLD_AGENT_HOOK_STEM = "route-agents-to-glm";

/**
 * The PreToolUse matcher for the subagent gate. It covers both names the
 * harness has used for the in-process subagent tool — the current "Agent" and
 * the older "Task" — because a matcher that names only one of them leaves the
 * gate registered but never invoked after a rename.
 */
export const AGENT_MATCHER = "Agent|Task";

/** Matchers a previous PAI version wrote for this same hook. */
const LEGACY_AGENT_MATCHERS = ["Agent", "Task"];

export interface InstallResult {
  lines: string[];
  changed: boolean;
}

/** Absolute path of the pai executable to hard-wire into the shims. */
function paiPath(): string {
  try {
    return execFileSync("/usr/bin/which", ["pai"], { encoding: "utf8" }).trim() || "pai";
  } catch {
    return "pai";
  }
}

// ---------------------------------------------------------------------------
// 1. settings.json: Agent hook migration
// ---------------------------------------------------------------------------

/**
 * Bring the subagent-gate registration up to date inside an already-read
 * settings object. Pure: it mutates `settings` and reports, the caller decides
 * whether to write. Exported so the registration can be tested against a copy
 * of a real settings.json instead of the live file.
 *
 * Three things must hold afterwards, and each one has been wrong at some point:
 *   - the rule exists,
 *   - its matcher covers every subagent tool name (AGENT_MATCHER), not just
 *     the one the harness happened to emit when it was written,
 *   - its command points at the current hook.
 */
export function patchAgentHookSettings(
  settings: Record<string, unknown>,
  lines: string[]
): boolean {
  const hooks = (typeof settings["hooks"] === "object" && settings["hooks"] !== null
    ? settings["hooks"]
    : {}) as Record<string, unknown>;

  const preToolUse = Array.isArray(hooks["PreToolUse"])
    ? (hooks["PreToolUse"] as Array<Record<string, unknown>>)
    : [];

  let changed = false;
  let found = false;

  for (const rule of preToolUse) {
    const matcher = typeof rule["matcher"] === "string" ? rule["matcher"] : "";
    if (matcher !== AGENT_MATCHER && !LEGACY_AGENT_MATCHERS.includes(matcher)) continue;

    const entries = Array.isArray(rule["hooks"])
      ? (rule["hooks"] as Array<Record<string, unknown>>)
      : [];
    let ours = false;
    for (const entry of entries) {
      const cmd = typeof entry["command"] === "string" ? entry["command"] : "";
      if (cmd === NEW_AGENT_HOOK) ours = true;
      if (cmd.includes(OLD_AGENT_HOOK_STEM)) {
        entry["command"] = NEW_AGENT_HOOK;
        lines.push(`settings.json: subagent hook migrated to ${NEW_AGENT_HOOK}`);
        changed = true;
        ours = true;
      }
    }
    if (!ours) continue; // someone else's rule on the same matcher — leave it

    found = true;
    if (matcher !== AGENT_MATCHER) {
      rule["matcher"] = AGENT_MATCHER;
      lines.push(`settings.json: subagent matcher widened "${matcher}" → "${AGENT_MATCHER}"`);
      changed = true;
    }
  }

  if (!found) {
    preToolUse.push({
      matcher: AGENT_MATCHER,
      hooks: [{ type: "command", command: NEW_AGENT_HOOK }],
    });
    lines.push(`settings.json: subagent hook added (${AGENT_MATCHER}) → ${NEW_AGENT_HOOK}`);
    changed = true;
  }

  if (changed) {
    hooks["PreToolUse"] = preToolUse;
    settings["hooks"] = hooks;
  } else {
    lines.push(`settings.json: subagent hook already current`);
  }
  return changed;
}

function patchAgentHook(lines: string[]): boolean {
  const settings = readSettingsJson();
  const changed = patchAgentHookSettings(settings, lines);
  if (changed) writeSettingsJson(settings);
  return changed;
}

// ---------------------------------------------------------------------------
// 2. ~/.local/bin shims
// ---------------------------------------------------------------------------

const GLM_PS_SHIM = (pai: string) => `# pai worker shim — replaces the python glm-ps of the same name
case "\${1-}" in
  ""|"ps") exec ${pai} worker ps ;;
  follow|watch|pane|log) exec ${pai} worker "$@" ;;
  --status) shift; exec ${pai} worker status-line "\${ITERM_SESSION_ID:-}" "\${PWD:-$HOME}" ;;
  -*) exec ${pai} worker ps "$@" ;;
  *) exec ${pai} worker replay "$@" ;;
esac
`;

/**
 * Names whose shim starts the harness itself on that provider (`pai launch`)
 * rather than a subagent worker — the historical meaning of typing "glm":
 * an interactive session pinned to the glm endpoint, not whatever provider
 * happens to be `active` in workers.yaml right now.
 */
const LAUNCH_SHIM_PROVIDERS = ["glm", "kimi"];

export function shim(name: string, pai: string): string {
  if (name === "glm-ps") return GLM_PS_SHIM(pai);
  if (name === "glm-log") return `#!/bin/sh\n# pai worker shim — replaces the shell glm-log of the same name\nexec ${pai} worker log "$@"\n`;
  if (name === "worker-say") return `#!/bin/sh\n# pai worker shim — say one line to a running worker\nexec ${pai} worker say "$@"\n`;
  if (LAUNCH_SHIM_PROVIDERS.includes(name)) {
    return `#!/bin/sh\n# pai launch shim — starts an interactive Claude Code session pinned to the ${name} provider\nexec ${pai} launch --provider ${name} "$@"\n`;
  }
  // glm-run: pass everything through to a headless/worker run; `pai worker
  // run` forwards unknown options to claude and drops --output-format/
  // --verbose itself
  return `#!/bin/sh\n# pai worker shim — replaces the previous ${name} of the same name\nexec ${pai} worker run "$@"\n`;
}

export function installShims(lines: string[]): boolean {
  const pai = paiPath();
  let changed = false;
  for (const name of ["glm", "glm-run", "glm-ps", "glm-log", "worker-say", "kimi"]) {
    const path = join(localBin(), name);
    let current: string | null = null;
    if (existsSync(path)) {
      try {
        current = execFileSync("head", ["-c", "64", path], { encoding: "utf8" });
      } catch {
        current = null;
      }
    }
    if (current !== null && !/# pai (worker|launch) shim/.test(current)) {
      // one-time move-aside; never clobber what a later run moved there
      const aside = join(localBin(), `${name}.pre-pai`);
      if (!existsSync(aside)) {
        renameSync(path, aside);
        lines.push(`${name}: previous version kept as ${name}.pre-pai`);
      } else {
        // never delete a file that is not ours: keep it under a timestamped name
        const stamped = `${name}.pre-pai.${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
        renameSync(path, join(localBin(), stamped));
        lines.push(`${name}: replaced (${name}.pre-pai already exists; previous version kept as ${stamped})`);
      }
      changed = true;
    } else if (current === null) {
      changed = true;
    } else {
      lines.push(`${name}: shim already current`);
      continue;
    }
    const body = shim(name, pai);
    mkdirSync(localBin(), { recursive: true });
    writeFileSync(path, body, { encoding: "utf8", mode: 0o755 });
    try {
      chmodSync(path, 0o755);
    } catch {
      /* mode set on create where supported */
    }
    const target = LAUNCH_SHIM_PROVIDERS.includes(name) ? `${pai} launch --provider ${name}` : `${pai} worker …`;
    lines.push(`${name}: shim installed → ${target}`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 3. old hook file
// ---------------------------------------------------------------------------

function removeOldHook(lines: string[]): boolean {
  const old = join(hooksDir(), "route-agents-to-glm.sh");
  if (!existsSync(old)) return false;
  unlinkSync(old);
  lines.push(`removed ${OLD_AGENT_HOOK_STEM}.sh (registration migrated above)`);
  return true;
}

// ---------------------------------------------------------------------------

export function installWorkers(): InstallResult {
  const lines: string[] = [];
  let changed = patchAgentHook(lines);
  if (installShims(lines)) changed = true;
  if (removeOldHook(lines)) changed = true;
  if (!existsSync(localBin())) {
    lines.push(`note: ${localBin()} did not exist; make sure it is on PATH`);
  }
  return { lines, changed };
}
