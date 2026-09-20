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

export interface ClaudeProcessEnv {
  pid: number;
  baseUrl: string | null;
  authTokenPresent: boolean;
  defaultModels: Record<string, string>;
  enableToolSearch: string | null;
  workerId: string | null;
  age: string | null;
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

function findClaudePids(): number[] {
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

function readProcessEnvLine(pid: number): string | null {
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
    processes.push({
      pid,
      baseUrl: extract(/ANTHROPIC_BASE_URL=(\S*)/, line),
      authTokenPresent: /ANTHROPIC_AUTH_TOKEN=\S/.test(line),
      defaultModels,
      enableToolSearch: extract(/ENABLE_TOOL_SEARCH=(\S*)/, line),
      workerId: extract(/PAI_WORKER_ID=(\S*)/, line),
      age: readProcessAge(pid),
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
