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

import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkersConfigError, type WorkersConfig } from "./config.js";
import { claudeJsonPath } from "../config/claude-json.js";
import { writePrivateFile } from "./settings-file.js";

/** ~/.claude.json — the user's MCP server definitions (top-level mcpServers). */

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

export function readMcpServers(claudeJson = claudeJsonPath()): Record<string, unknown> {
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
  claudeJson = claudeJsonPath()
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
  claudeJson = claudeJsonPath(),
  spawnEnv?: NodeJS.ProcessEnv
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
  writeScrubbedMcpConfig(path, servers, spawnEnv);
  return path;
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|API|AUTH|COOKIE|CREDENTIAL/i;
/** Never handed to a worker, whatever a config says. */
const NEVER_PASS = new Set(["ANTHROPIC_API_KEY"]);

/**
 * Replace secret values in each server's `env` block by "${NAME}" (Claude
 * Code expands ${VAR} in MCP config env from its own environment). A value is
 * secret when its name looks like one or it equals a secret-named var of
 * `parentEnv`. Returns the scrubbed servers and the values the worker's spawn
 * env must carry for the references to resolve.
 */
export function scrubMcpServers(
  servers: Record<string, unknown>,
  parentEnv: NodeJS.ProcessEnv = process.env
): { servers: Record<string, unknown>; secrets: Record<string, string> } {
  const parentSecrets = new Set<string>();
  for (const [k, v] of Object.entries(parentEnv)) if (v && v.length >= 8 && SECRET_NAME.test(k)) parentSecrets.add(v);
  const secrets: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(servers)) {
    const d = def as Record<string, unknown> | null;
    const e = d && typeof d === "object" ? d.env : undefined;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      out[name] = def;
      continue;
    }
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
      if (typeof v === "string" && !/^\$\{[^}]*\}$/.test(v) && (SECRET_NAME.test(k) || parentSecrets.has(v))) {
        env[k] = `\${${k}}`;
        if (!NEVER_PASS.has(k)) secrets[k] = v;
      } else env[k] = v;
    }
    out[name] = { ...d, env };
  }
  return { servers: out, secrets };
}

/** Write an MCP config 0600 with secrets scrubbed; the values go into `spawnEnv` (unless already set there). */
export function writeScrubbedMcpConfig(
  path: string,
  servers: Record<string, unknown>,
  spawnEnv?: NodeJS.ProcessEnv,
  parentEnv: NodeJS.ProcessEnv = process.env
): void {
  const { servers: clean, secrets } = scrubMcpServers(servers, parentEnv);
  if (spawnEnv) for (const [k, v] of Object.entries(secrets)) if (!spawnEnv[k]) spawnEnv[k] = v;
  writePrivateFile(path, JSON.stringify({ mcpServers: clean }, null, 2) + "\n");
}

/**
 * gc: rewrite worker MCP configs in the log dir (`*.mcp.json`) that still
 * hold secret values, with "${NAME}" references. Returns the files changed.
 */
export function gcMcpConfigs(logDir: string, dryRun = false, parentEnv: NodeJS.ProcessEnv = process.env): string[] {
  const changed: string[] = [];
  if (!existsSync(logDir)) return changed;
  for (const name of readdirSync(logDir)) {
    if (!name.endsWith(".mcp.json")) continue;
    const path = join(logDir, name);
    try {
      const text = readFileSync(path, "utf8");
      const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
      if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") continue;
      const { servers } = scrubMcpServers(parsed.mcpServers, parentEnv);
      const next = JSON.stringify({ ...parsed, mcpServers: servers }, null, 2) + "\n";
      if (next === text) continue;
      if (!dryRun) writePrivateFile(path, next);
      changed.push(path);
    } catch {
      /* unreadable or foreign file: leave it */
    }
  }
  return changed;
}

/** `pai worker mcp list`: the servers and sets a run could name. */
export function describeMcp(config: Pick<WorkersConfig, "mcpSets">, claudeJson = claudeJsonPath()): string[] {
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
