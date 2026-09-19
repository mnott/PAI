/**
 * mcp.ts — the MCP allowlist for headless workers.
 *
 * Headless workers start with NO MCP servers: every server definition is a
 * prompt-time tool inventory the model pays to know, and a worker that only
 * reads and edits files needs none of it. A run may opt in with `--mcp
 * name[,name…]`, a role carrying `"mcp": [...]`, or implicitly by naming
 * `mcp__server__tool` in --allowedTools (a grant without its server loaded is
 * a dead letter). Names may be single servers from ~/.claude.json's
 * `mcpServers` or `workers.mcpSets` set names, which expand to their member
 * list. The filtered config lands in
 * `<logDir>/<id>.mcp.json` and is passed with `--strict-mcp-config
 * --mcp-config` so exactly those servers load. MCP servers are chosen at
 * launch only — a mid-run `say` cannot add any.
 *
 * One name in that space is not a server at all: `claude-in-chrome` is the
 * Chrome native-host bridge, which no config file can load and which the
 * `--chrome` flag switches on instead. It is recognised here so a grant
 * naming it becomes that flag rather than an "unknown MCP server" rejection.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkersConfigError, type WorkersConfig } from "./config.js";

/** ~/.claude.json — the user's MCP server definitions (top-level mcpServers). */
export const CLAUDE_JSON = join(homedir(), ".claude.json");

/**
 * The browser bridge is not an MCP server. It rides the Chrome native-host
 * channel, so it never appears in `mcpServers`; a spawned claude has it off
 * and the `--chrome` flag switches it on. Tool grants naming it must
 * therefore neither resolve to a server nor be rejected as unknown — they
 * select a flag. See `grantsChrome`.
 */
export const CHROME_SERVER = "claude-in-chrome";

/**
 * True for a real server definition, false for anything else that happens to
 * sit under `mcpServers`.
 *
 * The vendor config is not ours and has been observed carrying non-server
 * entries under that key — tool-usage records keyed by tool name
 * (`Read`, `Bash`, `mcp__server__tool`, …). Those are not servers: handing
 * one to `--mcp-config` yields "invalid MCP server config", and listing one
 * as available invites a run that cannot work. A server has a `command` (or a
 * `url` for remote transports); an `mcp__…` key is a tool name whatever its
 * shape.
 */
function isServerDefinition(name: string, value: unknown): boolean {
  if (name.startsWith("mcp__")) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (typeof v.command === "string" && v.command.length > 0) ||
    (typeof v.url === "string" && v.url.length > 0)
  );
}

export function readMcpServers(claudeJson = CLAUDE_JSON): Record<string, unknown> {
  try {
    if (!existsSync(claudeJson)) return {};
    const parsed = JSON.parse(readFileSync(claudeJson, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (isServerDefinition(name, value)) out[name] = value;
    }
    return out;
  } catch {
    // a damaged ~/.claude.json must not take workers down with it
    return {};
  }
}

/**
 * True when any `--mcp` name or `--allowedTools` grant asks for the browser
 * bridge: the bare server name, `mcp__claude-in-chrome`, or any
 * `mcp__claude-in-chrome__<tool>`. The runner turns this into `--chrome` on
 * the claude argv.
 */
export function grantsChrome(entries: string[]): boolean {
  for (const entry of entries) {
    for (const name of entry.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (name === CHROME_SERVER) return true;
      if (name === `mcp__${CHROME_SERVER}`) return true;
      if (name.startsWith(`mcp__${CHROME_SERVER}__`)) return true;
    }
  }
  return false;
}

/**
 * Split a `--mcp a,b,c` flag value (also accepts repeated flags already split
 * by the caller) and expand set names from workers.mcpSets.
 */
export function expandMcpNames(
  names: string[],
  config: Pick<WorkersConfig, "mcpSets">,
  claudeJson = CLAUDE_JSON
): string[] {
  const available = readMcpServers(claudeJson);
  const out: string[] = [];
  for (const raw of names) {
    for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (name === CHROME_SERVER) continue; // a flag, not a server — see grantsChrome
      if (name in config.mcpSets) {
        for (const member of config.mcpSets[name]) {
          if (!out.includes(member)) out.push(member);
        }
        continue;
      }
      if (!(name in available)) {
        const sets = Object.keys(config.mcpSets);
        throw new WorkersConfigError(
          `unknown MCP server "${name}". Available servers: ` +
            `${Object.keys(available).join(", ") || "(none in ~/.claude.json)"}` +
            `${sets.length ? `; sets: ${sets.join(", ")}` : ""}`
        );
      }
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Derive server names from tool grants: every `mcp__<server>__<tool>` (or bare
 * `mcp__<server>`, or `mcp__<server>__*`) in an --allowedTools list names a
 * server the run expects to be loaded. A grant is a dead letter unless its
 * server is in the filtered config, so the runner treats these as implicit
 * --mcp names — and only these; non-mcp grants load nothing.
 */
export function mcpServersFromToolGrants(tools: string[]): string[] {
  const out: string[] = [];
  for (const entry of tools) {
    for (const name of entry.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!name.startsWith("mcp__")) continue;
      const server = name.slice("mcp__".length).split("__")[0];
      if (server === CHROME_SERVER) continue; // a flag, not a server — see grantsChrome
      if (server && !out.includes(server)) out.push(server);
    }
  }
  return out;
}

/** Path of a run's filtered MCP config. */
export function runMcpConfigPath(logDir: string, id: string): string {
  return join(logDir, `${id}.mcp.json`);
}

/**
 * Write a config containing only `names` (already expanded) and return its
 * path. Unknown names fail fast with the available list.
 */
export function writeMcpConfig(
  logDir: string,
  id: string,
  names: string[],
  claudeJson = CLAUDE_JSON
): string {
  const available = readMcpServers(claudeJson);
  const unknown = names.filter((n) => !(n in available));
  if (unknown.length) {
    throw new WorkersConfigError(
      `unknown MCP server(s): ${unknown.join(", ")}. Available: ` +
        `${Object.keys(available).join(", ") || "(none in ~/.claude.json)"}`
    );
  }
  const servers: Record<string, unknown> = {};
  for (const n of names) servers[n] = available[n];
  const path = runMcpConfigPath(logDir, id);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8");
  return path;
}

/** `pai worker mcp list`: the servers and sets a run could name. */
export function describeMcp(config: Pick<WorkersConfig, "mcpSets">, claudeJson = CLAUDE_JSON): string[] {
  const servers = Object.keys(readMcpServers(claudeJson));
  const lines: string[] = [];
  if (servers.length) {
    lines.push(`servers (~/.claude.json):`);
    for (const s of servers) lines.push(`  ${s}`);
  } else {
    lines.push(`no MCP servers defined in ~/.claude.json`);
  }
  const sets = Object.entries(config.mcpSets);
  if (sets.length) {
    lines.push(`sets (workers.mcpSets):`);
    for (const [name, members] of sets) lines.push(`  ${name} = ${members.join(", ")}`);
  }
  lines.push(`usage: pai worker run --mcp <name>[,<name>…] -p '<task>'`);
  return lines;
}
