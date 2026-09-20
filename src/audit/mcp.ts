/**
 * `pai audit mcp` — cross-reference every MCP server name found anywhere
 * (global/project config, project `.mcp.json`, live process argv, 30-day
 * transcript usage) against where it's configured, whether it's pinned via
 * `pai project mcp`, whether a live process actually loaded it, and how much
 * it was used in the last 30 days.
 *
 * The `--connect` path is the only side-effecting one: it launches every
 * configured stdio MCP server to call `listTools()`. It never runs unless
 * the caller passes `connect: true` explicitly — there is no default-on path.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findClaudePids, extractMcpConfigArg, readProcessEnvLine } from "./env.js";
import { projectLaunchConfig } from "../workers/project-config.js";

export interface McpLiveProcess {
  pid: number;
  mcpConfigPath: string | null;
  servers: string[] | null;
}

export interface McpUsage {
  distinctTools: number;
  calls: number;
}

export interface McpServerRow {
  server: string;
  configuredIn: string[];
  disabled: boolean;
  /** "yes" when the project pin lists this server, "-" when a pin exists without it, null when the project has no pin (every server loads). */
  pinned: "yes" | "-" | null;
  loadedLive: string;
  toolsExposed: number | "UNKNOWN";
  toolsUsed30d: number;
  calls30d: number;
}

export interface McpReport {
  servers: McpServerRow[];
  liveProcesses: McpLiveProcess[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

/** Whether a transcript file is worth streaming: fresh enough and small enough. */
export function shouldScanTranscript(stat: { size: number; mtimeMs: number }, now: number): boolean {
  if (stat.size > MAX_TRANSCRIPT_BYTES) return false;
  if (now - stat.mtimeMs > THIRTY_DAYS_MS) return false;
  return true;
}

/**
 * Whether a live process's resolved server set includes `serverName`.
 * `servers === null` means "no --mcp-config flag", i.e. every configured
 * server loads; an array (possibly empty) means only those names load.
 */
export function liveProcessLoadsServer(
  proc: { servers: string[] | null },
  serverName: string,
  allConfiguredNames: string[]
): boolean {
  if (proc.servers === null) return allConfiguredNames.includes(serverName);
  return proc.servers.includes(serverName);
}

function resolveHomePath(path: string, homeDir: string): string {
  return path.startsWith("~") ? join(homeDir, path.slice(1)) : path;
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface ClaudeJsonShape {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown>; disabledMcpServers?: string[] }>;
}

interface McpJsonShape {
  mcpServers?: Record<string, unknown>;
}

interface ConfiguredSources {
  configuredIn: Map<string, Set<string>>;
  disabled: Set<string>;
  serverDefs: Map<string, unknown>;
}

function gatherConfiguredSources(cwd: string, homeDir: string): ConfiguredSources {
  const configuredIn = new Map<string, Set<string>>();
  const disabled = new Set<string>();
  const serverDefs = new Map<string, unknown>();

  const addTag = (name: string, tag: string) => {
    if (!configuredIn.has(name)) configuredIn.set(name, new Set());
    configuredIn.get(name)!.add(tag);
  };

  const claudeJsonPath = join(homeDir, ".claude.json");
  const claudeJson = readJsonFile<ClaudeJsonShape>(claudeJsonPath);
  if (claudeJson) {
    for (const [name, def] of Object.entries(claudeJson.mcpServers ?? {})) {
      addTag(name, "global");
      if (!serverDefs.has(name)) serverDefs.set(name, def);
    }
    const projectEntry = claudeJson.projects?.[resolve(cwd)];
    if (projectEntry) {
      for (const [name, def] of Object.entries(projectEntry.mcpServers ?? {})) {
        addTag(name, "project");
        if (!serverDefs.has(name)) serverDefs.set(name, def);
      }
      for (const name of projectEntry.disabledMcpServers ?? []) {
        disabled.add(name);
        if (!configuredIn.has(name)) configuredIn.set(name, new Set());
      }
    }
  }

  const mcpJsonPath = join(cwd, ".mcp.json");
  if (existsSync(mcpJsonPath)) {
    const mcpJson = readJsonFile<McpJsonShape>(mcpJsonPath);
    if (mcpJson) {
      for (const [name, def] of Object.entries(mcpJson.mcpServers ?? {})) {
        addTag(name, "project .mcp.json");
        if (!serverDefs.has(name)) serverDefs.set(name, def);
      }
    }
  }

  return { configuredIn, disabled, serverDefs };
}

function gatherLiveProcesses(homeDir: string): McpLiveProcess[] {
  const procs: McpLiveProcess[] = [];
  for (const pid of findClaudePids()) {
    const line = readProcessEnvLine(pid);
    if (!line) continue;
    const mcpConfigArg = extractMcpConfigArg(line);
    if (!mcpConfigArg) {
      procs.push({ pid, mcpConfigPath: null, servers: null });
      continue;
    }
    const resolved = resolveHomePath(mcpConfigArg, homeDir);
    const parsed = readJsonFile<McpJsonShape>(resolved);
    const servers = parsed ? Object.keys(parsed.mcpServers ?? {}) : [];
    procs.push({ pid, mcpConfigPath: resolved, servers });
  }
  return procs;
}

/** Recursively find every file under `dir` ending in `.jsonl`. */
function findJsonlFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
  return found;
}

interface ToolUseBlock {
  type?: string;
  name?: string;
}

interface TranscriptLine {
  type?: string;
  name?: string;
  message?: { content?: ToolUseBlock[] };
}

function foldToolUseBlock(block: ToolUseBlock, usage: Map<string, { tools: Set<string>; calls: number }>): void {
  if (block.type !== "tool_use") return;
  const name = block.name;
  if (!name || !name.startsWith("mcp__")) return;
  const parts = name.split("__");
  const server = parts[1];
  const tool = parts.slice(2).join("__");
  if (!server) return;
  if (!usage.has(server)) usage.set(server, { tools: new Set(), calls: 0 });
  const entry = usage.get(server)!;
  entry.tools.add(tool);
  entry.calls += 1;
}

async function gatherUsage(transcriptsDir: string, now: number): Promise<Map<string, McpUsage>> {
  const usage = new Map<string, { tools: Set<string>; calls: number }>();
  for (const file of findJsonlFiles(transcriptsDir)) {
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!shouldScanTranscript(stat, now)) continue;

    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.includes('"mcp__')) continue;
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(raw) as TranscriptLine;
      } catch {
        continue;
      }
      if (parsed.type === "tool_use") {
        foldToolUseBlock(parsed as ToolUseBlock, usage);
      }
      if (Array.isArray(parsed.message?.content)) {
        for (const block of parsed.message!.content!) {
          foldToolUseBlock(block, usage);
        }
      }
    }
  }

  const result = new Map<string, McpUsage>();
  for (const [server, entry] of usage) {
    result.set(server, { distinctTools: entry.tools.size, calls: entry.calls });
  }
  return result;
}

interface StdioLikeDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function isStdioDef(def: unknown): def is StdioLikeDef {
  return typeof def === "object" && def !== null && typeof (def as StdioLikeDef).command === "string";
}

/** Connect to every stdio MCP server row and record how many tools it exposes. Side-effecting: only called when `opts.connect === true`. */
async function connectAndCountTools(
  rows: McpServerRow[],
  serverDefs: Map<string, unknown>
): Promise<void> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  for (const row of rows) {
    const def = serverDefs.get(row.server);
    if (!isStdioDef(def)) continue;

    const transport = new StdioClientTransport({
      command: def.command!,
      args: def.args ?? [],
      env: def.env,
    });
    const client = new Client({ name: "pai-audit-mcp", version: "1.0.0" }, { capabilities: {} });

    let settled = false;
    const timeout = new Promise<"UNKNOWN">((res) => {
      setTimeout(() => {
        if (!settled) res("UNKNOWN");
      }, 10_000);
    });

    try {
      const attempt = (async (): Promise<number | "UNKNOWN"> => {
        await client.connect(transport);
        const result = await client.listTools();
        return result.tools.length;
      })();
      const outcome = await Promise.race([attempt, timeout]);
      settled = true;
      row.toolsExposed = outcome;
    } catch {
      settled = true;
      row.toolsExposed = "UNKNOWN";
    } finally {
      try {
        await client.close();
      } catch {
        /* already closed or never connected */
      }
    }
  }
}

export async function auditMcp(opts: {
  cwd: string;
  homeDir: string;
  connect?: boolean;
  projectsDbPath?: string;
  transcriptsDir?: string;
}): Promise<McpReport> {
  const cwd = opts.cwd;
  const homeDir = opts.homeDir;
  const transcriptsDir = opts.transcriptsDir ?? join(homeDir, ".claude", "projects");

  const { configuredIn, disabled, serverDefs } = gatherConfiguredSources(cwd, homeDir);
  const liveProcesses = gatherLiveProcesses(homeDir);
  const usage = await gatherUsage(transcriptsDir, Date.now());
  const pinned = opts.projectsDbPath
    ? projectLaunchConfig(resolve(cwd), opts.projectsDbPath)?.mcp ?? null
    : projectLaunchConfig(resolve(cwd))?.mcp ?? null;

  const allNames = new Set<string>([...configuredIn.keys(), ...usage.keys()]);
  const allConfiguredNames = [...configuredIn.keys()];

  const rows: McpServerRow[] = [];
  for (const name of allNames) {
    const liveMatches = liveProcesses.filter((p) => liveProcessLoadsServer(p, name, allConfiguredNames));
    const serverUsage = usage.get(name);
    rows.push({
      server: name,
      configuredIn: [...(configuredIn.get(name) ?? new Set())],
      disabled: disabled.has(name),
      pinned: pinned === null ? null : pinned.includes(name) ? "yes" : "-",
      loadedLive: liveMatches.length ? liveMatches.map((p) => `pid ${p.pid}`).join(", ") : "-",
      toolsExposed: "UNKNOWN",
      toolsUsed30d: serverUsage?.distinctTools ?? 0,
      calls30d: serverUsage?.calls ?? 0,
    });
  }

  rows.sort((a, b) => a.server.localeCompare(b.server));

  if (opts.connect === true) {
    await connectAndCountTools(rows, serverDefs);
  }

  return { servers: rows, liveProcesses };
}
