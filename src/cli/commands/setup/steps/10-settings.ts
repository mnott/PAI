/** Steps 8b and 8: Assistant name prompt and settings.json patch. */

import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { mergeSettings, type HookEntry } from "../../../lib/settings-manager.js";
import { c, line, section, type Rl, prompt, promptYesNo, setupOptions } from "../utils.js";

const WORKER_GUARD_OLD_MATCHERS = [
  "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
  "Bash|Edit|Write|MultiEdit|NotebookEdit",
];

/** Hook registrations setup merges into settings.json. */
export const SETTINGS_HOOKS: HookEntry[] = [
    { hookType: "SessionStart", command: "${ADAPTER_DIR}/Hooks/load-core-context.mjs" },
    { hookType: "SessionStart", command: "${ADAPTER_DIR}/Hooks/load-project-context.mjs" },
    { hookType: "SessionStart", command: "${ADAPTER_DIR}/Hooks/initialize-session.mjs" },
    { hookType: "SessionStart", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type SessionStart" },
    { hookType: "SessionStart", matcher: "compact", command: "${ADAPTER_DIR}/Hooks/post-compact-inject.mjs" },
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/cleanup-session-files.mjs" },
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/update-tab-titles.mjs" },
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/local-model-hint.mjs" },
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/handoff-link.mjs" },
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type UserPromptSubmit" },
    // Rolling checkpoint. The model is not invoked on /exit and never on
    // Ctrl+C, so a handover written at exit time is impossible — it has to
    // already exist. Rate-limited internally; safe on high-frequency events.
    { hookType: "UserPromptSubmit", command: "${ADAPTER_DIR}/Hooks/pai-session-autosave.sh" },
    { hookType: "PreToolUse", matcher: "Bash", command: "${ADAPTER_DIR}/Hooks/security-validator.mjs" },
    // Test governance for every session: a new test file is one-time (.pai-scratch/
    // only) unless promoted in tests/KEPT.md. Bash coverage rides security-validator.
    { hookType: "PreToolUse", matcher: "Write|Edit|MultiEdit", command: "${ADAPTER_DIR}/Hooks/test-file-governance.mjs" },
    // Every tool: the loop guard inside counts Read/Grep/Glob repeats too.
    { hookType: "PreToolUse", matcher: "*", oldMatchers: WORKER_GUARD_OLD_MATCHERS, command: "${ADAPTER_DIR}/Hooks/worker-guard.mjs" },
    { hookType: "PreToolUse", matcher: "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep", command: "${ADAPTER_DIR}/Hooks/worker-path-repair.mjs" },
    { hookType: "PreToolUse", matcher: "Write|Edit|MultiEdit", oldMatchers: ["Edit|MultiEdit"], command: "${ADAPTER_DIR}/Hooks/worker-edit-repair.mjs" },
    // Dotted tool names (Glob.glob) die before any name-matched hook sees
    // them, so this one must match every call and rewrite the name itself.
    { hookType: "PreToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/worker-tool-name-repair.mjs" },
    { hookType: "PreToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type PreToolUse" },
    { hookType: "PostToolUse", matcher: "TodoWrite", command: "${ADAPTER_DIR}/Hooks/sync-todo-to-md.mjs" },
    { hookType: "PostToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type PostToolUse" },
    { hookType: "PostToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/capture-tool-output.mjs" },
    { hookType: "PostToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/update-tab-on-action.mjs" },
    { hookType: "PostToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/pai-session-autosave.sh" },
    { hookType: "PostToolUse", matcher: "*", command: "${ADAPTER_DIR}/Hooks/worker-note.mjs" },
    // Failures that never reach PreToolUse (input validation) are counted by the loop guard here.
    { hookType: "PostToolUseFailure", matcher: "*", command: "${ADAPTER_DIR}/Hooks/worker-note.mjs" },
    { hookType: "Stop", command: "${ADAPTER_DIR}/Hooks/stop-hook.mjs" },
    { hookType: "Stop", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type Stop" },
    { hookType: "Stop", command: "${ADAPTER_DIR}/Hooks/pai-session-stop.sh" },
    { hookType: "SubagentStop", command: "${ADAPTER_DIR}/Hooks/subagent-stop-hook.mjs" },
    { hookType: "SubagentStop", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type SubagentStop" },
    { hookType: "SessionEnd", command: "${ADAPTER_DIR}/Hooks/capture-session-summary.mjs" },
    { hookType: "SessionEnd", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type SessionEnd" },
    { hookType: "PreCompact", command: "${ADAPTER_DIR}/Hooks/context-compression-hook.mjs" },
    { hookType: "PreCompact", command: "${ADAPTER_DIR}/Hooks/capture-all-events.mjs --event-type PreCompact" },
    { hookType: "PreCompact", matcher: "", command: "${ADAPTER_DIR}/Hooks/pai-pre-compact.sh" },
];

export async function stepDaName(rl: Rl): Promise<string> {
  section("Step 10: Assistant Name");
  line();
  line("  Choose a name for your AI assistant. This name appears in tab titles");
  line("  and session notes when hooks are active.");
  line();

  const answer = setupOptions.daName ?? (await prompt(rl, chalk.bold("  Assistant name [PAI]: "), ""));
  const daName = answer || "PAI";
  line();
  console.log(c.ok(`Assistant name set to: ${daName}`));
  return daName;
}

export async function stepSettings(rl: Rl, daName: string): Promise<boolean> {
  section("Step 11: Settings Patch");
  line();
  line("  PAI will add env vars, all hook registrations, permissions, and flags");
  line("  to ~/.claude/settings.json. Existing values are never overwritten.");
  line();

  const patch = await promptYesNo(rl, "Patch ~/.claude/settings.json with PAI hooks, env vars, and settings?", true, "settings");
  if (!patch) {
    console.log(c.dim("  Skipping settings patch."));
    return false;
  }

  const adapterDir = join(homedir(), ".claude");

  const result = mergeSettings({
    env: {
      ADAPTER_DIR: adapterDir,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DA: daName,
    },
    hooks: SETTINGS_HOOKS,
    statusLine: {
      type: "command",
      command: "bash ${ADAPTER_DIR}/statusline-command.sh",
    },
    permissions: {
      allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite", "ExitPlanMode", "mcp__pai"],
      deny: ["Bash(rm -rf /)", "Bash(rm -rf /*)", "Bash(rm -rf ~)", "Bash(rm -rf $HOME)", "Bash(sudo rm -rf /)", "Bash(sudo rm -rf /*)"],
    },
    flags: {
      enableAllProjectMcpServers: true,
    },
  });

  line();
  for (const r of result.report) {
    console.log(r);
  }

  if (!result.changed) {
    console.log(c.dim("  Settings already up-to-date. No changes made."));
  }

  return result.changed;
}
