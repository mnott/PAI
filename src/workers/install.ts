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
import { existsSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettingsJson, writeSettingsJson } from "../cli/commands/settings-manager.js";

const CLAUDE_DIR = join(homedir(), ".claude");
const HOOKS_DIR = join(CLAUDE_DIR, "Hooks");
const LOCAL_BIN = join(homedir(), ".local", "bin");

export const NEW_AGENT_HOOK = "${PAI_DIR}/Hooks/route-agents-to-worker.mjs";
const OLD_AGENT_HOOK_STEM = "route-agents-to-glm";

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

function patchAgentHook(lines: string[]): boolean {
  const settings = readSettingsJson();
  const hooks = (typeof settings["hooks"] === "object" && settings["hooks"] !== null
    ? settings["hooks"]
    : {}) as Record<string, unknown>;

  const preToolUse = Array.isArray(hooks["PreToolUse"])
    ? (hooks["PreToolUse"] as Array<Record<string, unknown>>)
    : [];

  let changed = false;
  let replaced = false;

  for (const rule of preToolUse) {
    if (rule["matcher"] !== "Agent") continue;
    const entries = Array.isArray(rule["hooks"]) ? (rule["hooks"] as Array<Record<string, unknown>>) : [];
    for (const entry of entries) {
      const cmd = typeof entry["command"] === "string" ? entry["command"] : "";
      if (cmd === NEW_AGENT_HOOK) replaced = true;
      if (cmd.includes(OLD_AGENT_HOOK_STEM)) {
        entry["command"] = NEW_AGENT_HOOK;
        lines.push(`settings.json: Agent hook migrated to ${NEW_AGENT_HOOK}`);
        changed = true;
        replaced = true;
      }
    }
    // rules whose matcher only existed for the old hook entry stay as-is;
    // the new command reuses the rule
  }

  if (!replaced) {
    preToolUse.push({
      matcher: "Agent",
      hooks: [{ type: "command", command: NEW_AGENT_HOOK }],
    });
    lines.push(`settings.json: Agent hook added → ${NEW_AGENT_HOOK}`);
    changed = true;
  }

  if (changed) {
    hooks["PreToolUse"] = preToolUse;
    settings["hooks"] = hooks;
    writeSettingsJson(settings);
  } else {
    lines.push(`settings.json: Agent hook already current`);
  }
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

function shim(name: string, pai: string): string {
  if (name === "glm-ps") return GLM_PS_SHIM(pai);
  if (name === "glm-log") return `#!/bin/sh\n# pai worker shim — replaces the shell glm-log of the same name\nexec ${pai} worker log "$@"\n`;
  if (name === "worker-say") return `#!/bin/sh\n# pai worker shim — say one line to a running worker\nexec ${pai} worker say "$@"\n`;
  // glm / glm-run: pass everything through; `pai worker run` forwards unknown
  // options to claude and drops --output-format/--verbose itself
  return `#!/bin/sh\n# pai worker shim — replaces the previous ${name} of the same name\nexec ${pai} worker run "$@"\n`;
}

function installShims(lines: string[]): boolean {
  const pai = paiPath();
  let changed = false;
  for (const name of ["glm", "glm-run", "glm-ps", "glm-log", "worker-say"]) {
    const path = join(LOCAL_BIN, name);
    const ours = `# pai worker shim`;
    let current: string | null = null;
    if (existsSync(path)) {
      try {
        current = execFileSync("head", ["-c", "64", path], { encoding: "utf8" });
      } catch {
        current = null;
      }
    }
    if (current !== null && !current.includes(ours)) {
      // one-time move-aside; never clobber what a later run moved there
      const aside = join(LOCAL_BIN, `${name}.pre-pai`);
      if (!existsSync(aside)) {
        renameSync(path, aside);
        lines.push(`${name}: previous version kept as ${name}.pre-pai`);
      } else {
        unlinkSync(path);
        lines.push(`${name}: replaced (${name}.pre-pai already exists)`);
      }
      changed = true;
    } else if (current === null) {
      changed = true;
    } else {
      lines.push(`${name}: shim already current`);
      continue;
    }
    const body = shim(name, pai);
    writeFileSync(path, body, { encoding: "utf8", mode: 0o755 });
    try {
      chmodSync(path, 0o755);
    } catch {
      /* mode set on create where supported */
    }
    lines.push(`${name}: shim installed → ${pai} worker …`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 3. old hook file
// ---------------------------------------------------------------------------

function removeOldHook(lines: string[]): boolean {
  const old = join(HOOKS_DIR, "route-agents-to-glm.sh");
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
  if (!existsSync(LOCAL_BIN)) {
    lines.push(`note: ${LOCAL_BIN} did not exist; make sure it is on PATH`);
  }
  return { lines, changed };
}
