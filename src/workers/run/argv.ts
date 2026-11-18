/**
 * run/argv.ts — command-line assembly: headless prompt text, tool grants, MCP/chrome args, moved verbatim out of
 * run.ts (split plan). run.ts re-exports everything here so every
 * existing import path keeps working.
 */

import { promptTrailer } from "../report.js";
import { grantsChrome } from "../mcp.js";
import { type ProjectLaunchConfig } from "../project-config.js";
import { SHARED_MARKER, UNIT_MARKER } from "../pool.js";

/**
 * The prompt text actually sent to the worker and whether the trailer got
 * appended. An instruction at the END of the user turn outweighs one buried
 * in the system prompt (measured 2026-09-20: the AG2 contract alone was
 * ignored by both Haiku and Sonnet). Never applied to an interactive launch
 * (no -p) or when the caller brought its own --append-system-prompt — the
 * trailer's "format in system prompt" would then point at nothing.
 */
export function headlessPromptText(
  prompt: string | null,
  headless: boolean,
  callerSystemPrompt: boolean,
  format: "ag2" | "json"
): { text: string | null; applied: boolean } {
  const applied = headless && prompt !== null && !callerSystemPrompt;
  return { text: applied ? prompt! + promptTrailer(format) : prompt, applied };
}

/**
 * Where a loopback run's per-worker lines (worktree path, id, deadline, note
 * token) go in the task: after a `--- shared ---` section, right before the
 * `--- unit ---` marker, so the shared section stays inside the cached prefix;
 * a task without both markers gets them at its head.
 */
export function placeVolatile(task: string, volatile: string): string {
  const lines = task.split("\n");
  const a = lines.findIndex((l) => l.trim() === SHARED_MARKER);
  const b = lines.findIndex((l, i) => i > a && l.trim() === UNIT_MARKER);
  if (a < 0 || b < 0) return volatile + "\n\n" + task;
  return [...lines.slice(0, b), volatile, "", ...lines.slice(b)].join("\n");
}

/**
 * The core tools a headless run grants when the caller brings none of its
 * own. Permission-gated tools (Bash, Read, Write, …) are never offered to a
 * headless session that has no allow rule for them — the child starts with
 * only the tools that never ask (tool search, web, cron, tasks) and cannot
 * touch a file or shell (2026-09-18). A caller's own --allowedTools is a
 * deliberate restriction and passes through untouched.
 */
export const DEFAULT_WORKER_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";

/** The --allowedTools args a headless run needs; [] when the caller granted. */
export function headlessToolGrants(allowedTools: string[]): string[] {
  return allowedTools.length ? [] : ["--allowedTools", DEFAULT_WORKER_TOOLS];
}

/**
 * `--tools` narrows which built-in tool *schemas* claude loads into the
 * system prompt — distinct from `--allowedTools`, which narrows which of
 * those loaded tools may run without asking. A headless worker with a small
 * grant (say, just Read) still pays for every built-in schema (Bash, Web*,
 * NotebookEdit, …) it never uses: ~9k tokens per spawn (29,270 -> 20,352,
 * measured 2026-09-20). Passing --tools built from the same grant removes
 * the unused schemas.
 *
 * MCP grants (`mcp__server__tool` / `mcp__server__*`) are left out of the
 * --tools list: they are not built-in tool names, --tools does not
 * recognize them, and the MCP server's tools load through --mcp-config
 * regardless. Tested 2026-09-20: with an --allowedTools grant of
 * `Read,mcp__pai__memory_search`, passing `--tools Read` (mcp name
 * omitted) still let the worker call memory_search successfully; the tool
 * loads from the filtered MCP config, not from --tools.
 */
export function headlessToolsFlag(allowedTools: string[]): string[] {
  const names: string[] = [];
  for (const entry of allowedTools) {
    for (const raw of entry.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (raw.startsWith("mcp__")) continue; // loads via --mcp-config, not --tools
      const patterned = raw.match(/^([A-Za-z]+)\(.*\)$/); // e.g. Bash(git *) -> Bash
      const name = patterned ? patterned[1] : raw;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.length ? ["--tools", names.join(",")] : [];
}

/**
 * A `--tools` value with no ToolSearch silently disables MCP tool deferral
 * (measured 2026-09-20: a run with `--tools "Bash,Read,Grep,Glob,Agent"` paid
 * 65,300 first-turn tokens with 5 MCP servers, 230,448 with 16, versus
 * 24,889 / 37,133 with ToolSearch present). Applied to the fully-assembled
 * argv so it catches a `--tools` from any source — the computed
 * `headlessToolsFlag`/project-pin flag, or one the caller put directly on
 * the command line.
 */
export function ensureToolSearch(cmd: string[]): string[] {
  const flagIdx = cmd.findIndex((a) => a === "--tools");
  if (flagIdx >= 0 && flagIdx + 1 < cmd.length) {
    const value = cmd[flagIdx + 1];
    if (value && !value.split(",").includes("ToolSearch")) {
      const out = [...cmd];
      out[flagIdx + 1] = `${value},ToolSearch`;
      process.stderr.write("pai: added ToolSearch to --tools (keeps MCP tool deferral on)\n");
      return out;
    }
    return cmd;
  }
  const eqIdx = cmd.findIndex((a) => a.startsWith("--tools="));
  if (eqIdx >= 0) {
    const value = cmd[eqIdx].slice("--tools=".length);
    if (value && !value.split(",").includes("ToolSearch")) {
      const out = [...cmd];
      out[eqIdx] = `--tools=${value},ToolSearch`;
      process.stderr.write("pai: added ToolSearch to --tools (keeps MCP tool deferral on)\n");
      return out;
    }
  }
  return cmd;
}

/**
 * The claude flag that turns on the browser bridge, when the run asked for it.
 *
 * The bridge is not an MCP server — it rides the Chrome native-host channel,
 * is absent from `mcpServers`, and is off in a spawned claude until `--chrome`
 * is passed. A grant such as `mcp__claude-in-chrome__tabs_context_mcp` is
 * therefore a request for that flag, not for a server to load; without this
 * the grant names a tool that never exists. `rest` is the caller's own argv:
 * a `--chrome` they passed themselves is kept rather than duplicated.
 */
export function chromeGrantArgs(wanted: string[], rest: string[] = []): string[] {
  if (rest.includes("--chrome")) return [];
  return grantsChrome(wanted) ? ["--chrome"] : [];
}

/**
 * Which MCP server names and --tools list an interactive launch (`pai
 * worker run`, no -p) uses: an explicit --mcp on this command line beats
 * the project's `pai project mcp` pin; an explicit --tools beats `pai
 * project tools`. Neither given: [] — today's "everything loads" default.
 */
export function interactiveMcpTools(
  explicitMcp: string[],
  callerTools: boolean,
  projectLaunch: Omit<ProjectLaunchConfig, "slug"> | null
): { mcpNames: string[]; tools: string[] } {
  return {
    mcpNames: explicitMcp.length ? explicitMcp : (projectLaunch?.mcp ?? []),
    tools: !callerTools && projectLaunch?.tools?.length ? projectLaunch.tools : [],
  };
}

// ---------------------------------------------------------------------------
// image engine (2i) — no process spawn: one HTTP request, one file written.
// ---------------------------------------------------------------------------
