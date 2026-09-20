/**
 * `pai audit tokens env` — is any live `claude` process pointed at a proxy?
 * A non-default ANTHROPIC_BASE_URL means every token that process sends and
 * receives passes through something other than Anthropic's own API.
 *
 * Uses `ps -axo pid=,etime=,comm=,args=` to enumerate processes (pgrep -x
 * fails to find processes when run from within a claude session). Filters for
 * comm="claude" (also "claude.exe" or paths ending with "/claude"), then
 * excludes MCP child processes by checking args for patterns like "npm exec",
 * "node", or "mcp-server".
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type Deferral = "on" | "OFF" | "n/a";

export interface ClaudeProcessEnv {
  pid: number;
  baseUrl: string | null;
  authTokenPresent: boolean;
  defaultModels: Record<string, string>;
  enableToolSearch: string | null;
  workerId: string | null;
  age: string | null;
  toolsArg: string | null;
  mcpServers: number | "default";
  deferral: Deferral;
}

export interface EnvReport {
  processes: ClaudeProcessEnv[];
  mcpServerCount: number;
  settingsModel: string | null;
  settingsEffortLevel: string | null;
}

export function isClaudeProcess(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return false;

  const comm = parts[2];
  const isClaudeComm =
    comm === "claude" ||
    comm === "claude.exe" ||
    comm.endsWith("/claude");

  if (!isClaudeComm) return false;

  const args = parts.slice(3).join(" ");
  const isMcpChild =
    args.includes("npm exec") ||
    args === "node" ||
    args.startsWith("node ") ||
    args.includes("mcp-server");

  return !isMcpChild;
}

export function findClaudePids(): number[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,etime=,comm=,args="], {
      encoding: "utf8",
    });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      if (!isClaudeProcess(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (!isNaN(pid)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

function extract(pattern: RegExp, text: string): string | null {
  const match = text.match(pattern);
  return match ? match[1] : null;
}

/**
 * `--tools A,B` and `--tools=A,B` are both valid on the argv this process was
 * launched with; an explicit but empty value (`--tools ""` / `--tools=`)
 * means "no tools at all", distinct from the flag being absent entirely.
 */
export function extractToolsArg(line: string): string | null {
  const eq = line.match(/--tools=(?:"([^"]*)"|(\S*))/);
  if (eq) return eq[1] !== undefined ? eq[1] : eq[2];
  const sp = line.match(/--tools\s+(?:"([^"]*)"|(\S+))/);
  if (sp) return sp[1] !== undefined ? sp[1] : sp[2];
  return null;
}

export function extractMcpConfigArg(line: string): string | null {
  const eq = line.match(/--mcp-config=(?:"([^"]*)"|(\S*))/);
  if (eq) return eq[1] !== undefined ? eq[1] : eq[2];
  const sp = line.match(/--mcp-config\s+(?:"([^"]*)"|(\S+))/);
  if (sp) return sp[1] !== undefined ? sp[1] : sp[2];
  return null;
}

/**
 * No `--tools` flag: the CLI default tool set applies, which includes
 * ToolSearch, so deferral is on. An explicit but empty list means no tools
 * at all, so deferral doesn't apply. Otherwise deferral is on only if the
 * explicit list still names ToolSearch.
 */
export function classifyDeferral(toolsArg: string | null): Deferral {
  if (toolsArg === null) return "on";
  if (toolsArg.trim() === "") return "n/a";
  const tools = toolsArg.split(",").map((t) => t.trim());
  return tools.includes("ToolSearch") ? "on" : "OFF";
}

function countMcpServersInFile(path: string): number {
  try {
    const resolved = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {}).length;
  } catch {
    return 0;
  }
}

export function readProcessEnvLine(pid: number): string | null {
  try {
    return execFileSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function readProcessAge(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function auditEnv(): EnvReport {
  const processes: ClaudeProcessEnv[] = [];
  for (const pid of findClaudePids()) {
    const line = readProcessEnvLine(pid);
    if (!line) continue;
    const defaultModels: Record<string, string> = {};
    const modelPattern = /ANTHROPIC_DEFAULT_(\w+?)_MODEL=(\S*)/g;
    let modelMatch: RegExpExecArray | null;
    while ((modelMatch = modelPattern.exec(line))) {
      defaultModels[modelMatch[1]] = modelMatch[2];
    }
    const toolsArg = extractToolsArg(line);
    const mcpConfigPath = extractMcpConfigArg(line);
    processes.push({
      pid,
      baseUrl: extract(/ANTHROPIC_BASE_URL=(\S*)/, line),
      authTokenPresent: /ANTHROPIC_AUTH_TOKEN=\S/.test(line),
      defaultModels,
      enableToolSearch: extract(/ENABLE_TOOL_SEARCH=(\S*)/, line),
      workerId: extract(/PAI_WORKER_ID=(\S*)/, line),
      age: readProcessAge(pid),
      toolsArg,
      mcpServers: mcpConfigPath ? countMcpServersInFile(mcpConfigPath) : "default",
      deferral: classifyDeferral(toolsArg),
    });
  }

  let mcpServerCount = 0;
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      mcpServerCount = Object.keys(parsed.mcpServers ?? {}).length;
    } catch {
      mcpServerCount = 0;
    }
  }

  let settingsModel: string | null = null;
  let settingsEffortLevel: string | null = null;
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { model?: string; effortLevel?: string };
      settingsModel = parsed.model ?? null;
      settingsEffortLevel = parsed.effortLevel ?? null;
    } catch {
      /* leave nulls */
    }
  }

  return { processes, mcpServerCount, settingsModel, settingsEffortLevel };
}
