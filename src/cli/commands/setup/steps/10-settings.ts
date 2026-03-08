/** Steps 8b and 8: Assistant name prompt and settings.json patch. */

import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { mergeSettings } from "../../settings-manager.js";
import { c, line, section, type Rl, prompt, promptYesNo } from "../utils.js";

export async function stepDaName(rl: Rl): Promise<string> {
  section("Step 8b: Assistant Name");
  line();
  line("  Choose a name for your AI assistant. This name appears in tab titles");
  line("  and session notes when hooks are active.");
  line();

  const answer = await prompt(rl, chalk.bold("  Assistant name [PAI]: "));
  const daName = answer || "PAI";
  line();
  console.log(c.ok(`Assistant name set to: ${daName}`));
  return daName;
}

export async function stepSettings(rl: Rl, daName: string): Promise<boolean> {
  section("Step 8: Settings Patch");
  line();
  line("  PAI will add env vars, all hook registrations, permissions, and flags");
  line("  to ~/.claude/settings.json. Existing values are never overwritten.");
  line();

  const patch = await promptYesNo(rl, "Patch ~/.claude/settings.json with PAI hooks, env vars, and settings?", true);
  if (!patch) {
    console.log(c.dim("  Skipping settings patch."));
    return false;
  }

  const paiDir = join(homedir(), ".claude");

  const result = mergeSettings({
    env: {
      PAI_DIR: paiDir,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
      DA: daName,
    },
    hooks: [
      { hookType: "SessionStart", command: "${PAI_DIR}/Hooks/load-core-context.mjs" },
      { hookType: "SessionStart", command: "${PAI_DIR}/Hooks/load-project-context.mjs" },
      { hookType: "SessionStart", command: "${PAI_DIR}/Hooks/initialize-session.mjs" },
      { hookType: "SessionStart", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SessionStart" },
      { hookType: "SessionStart", matcher: "compact", command: "${PAI_DIR}/Hooks/post-compact-inject.mjs" },
      { hookType: "UserPromptSubmit", command: "${PAI_DIR}/Hooks/cleanup-session-files.mjs" },
      { hookType: "UserPromptSubmit", command: "${PAI_DIR}/Hooks/update-tab-titles.mjs" },
      { hookType: "UserPromptSubmit", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type UserPromptSubmit" },
      { hookType: "PreToolUse", matcher: "Bash", command: "${PAI_DIR}/Hooks/security-validator.mjs" },
      { hookType: "PreToolUse", matcher: "*", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PreToolUse" },
      { hookType: "PostToolUse", matcher: "TodoWrite", command: "${PAI_DIR}/Hooks/sync-todo-to-md.mjs" },
      { hookType: "PostToolUse", matcher: "*", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PostToolUse" },
      { hookType: "PostToolUse", matcher: "*", command: "${PAI_DIR}/Hooks/capture-tool-output.mjs" },
      { hookType: "PostToolUse", matcher: "*", command: "${PAI_DIR}/Hooks/update-tab-on-action.mjs" },
      { hookType: "Stop", command: "${PAI_DIR}/Hooks/stop-hook.mjs" },
      { hookType: "Stop", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type Stop" },
      { hookType: "Stop", command: "${PAI_DIR}/Hooks/pai-session-stop.sh" },
      { hookType: "SubagentStop", command: "${PAI_DIR}/Hooks/subagent-stop-hook.mjs" },
      { hookType: "SubagentStop", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SubagentStop" },
      { hookType: "SessionEnd", command: "${PAI_DIR}/Hooks/capture-session-summary.mjs" },
      { hookType: "SessionEnd", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type SessionEnd" },
      { hookType: "PreCompact", command: "${PAI_DIR}/Hooks/context-compression-hook.mjs" },
      { hookType: "PreCompact", command: "${PAI_DIR}/Hooks/capture-all-events.mjs --event-type PreCompact" },
      { hookType: "PreCompact", matcher: "", command: "${PAI_DIR}/Hooks/pai-pre-compact.sh" },
    ],
    statusLine: {
      type: "command",
      command: "bash ${PAI_DIR}/statusline-command.sh",
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
