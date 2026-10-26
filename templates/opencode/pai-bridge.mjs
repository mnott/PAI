// pai-bridge.mjs — OpenCode plugin: PAI's Claude Code PreToolUse guards for OpenCode tool calls.
//
// Written by `pai harness setup opencode`; options come from the plugin tuple in opencode.json:
//   { hooks: [{ tools: ["bash"], command: ["node", "/path/to/guard.mjs"] }, ...] }
// Each hook is a PAI Claude Code hook run unchanged: it gets Claude-shaped JSON on stdin
// (tool_name, tool_input, cwd, session_id) and denies by exit 2 or by
// hookSpecificOutput.permissionDecision "deny". A deny throws, which OpenCode reports to the
// model as the tool's error. A hook that cannot run (missing, crashes, times out) allows:
// the guards must never take the frontend down.
//
// The default export is the only export on purpose: OpenCode treats every export of a plugin
// module as a plugin.

import { spawnSync } from "node:child_process";

const CLAUDE_TOOL = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  multiedit: "MultiEdit",
  patch: "Edit",
  task: "Task",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
};

const snake = (k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const toClaudeInput = (args) => Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [snake(k), v]));

function verdict(res) {
  if (res.status === 2) return (res.stderr || "denied by PAI guard").trim();
  try {
    const out = JSON.parse(res.stdout || "{}").hookSpecificOutput;
    if (out?.permissionDecision === "deny") return out.permissionDecisionReason || "denied by PAI guard";
  } catch {
    /* not JSON: no decision */
  }
  return null;
}

async function server(input, options) {
  const hooks = Array.isArray(options?.hooks) ? options.hooks : [];
  return {
    "tool.execute.before": async (call, output) => {
      for (const h of hooks) {
        if (!h.tools?.includes(call.tool) || !Array.isArray(h.command) || !h.command.length) continue;
        const payload = JSON.stringify({
          session_id: call.sessionID,
          hook_event_name: "PreToolUse",
          tool_name: CLAUDE_TOOL[call.tool] ?? call.tool,
          tool_input: toClaudeInput(output.args),
          cwd: input?.directory ?? process.cwd(),
        });
        const res = spawnSync(h.command[0], h.command.slice(1), { input: payload, encoding: "utf8", timeout: 10_000 });
        if (res.error) continue;
        const deny = verdict(res);
        if (deny) throw new Error(deny);
      }
    },
  };
}

export default { id: "pai-bridge", server };
