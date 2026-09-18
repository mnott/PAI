/**
 * paths.ts — where worker run artefacts live.
 *
 * Everything a run writes (event mirror, status file, pane registry, routing
 * state, the empty MCP config) sits under one logDir so the whole tree is
 * disposable and configurable: `workers.logDir`, default ~/.claude/logs/workers.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, type WorkersConfig } from "./config.js";

/** Absolute logDir for the given config. */
export function workersLogDir(config: WorkersConfig): string {
  return expandHome(config.logDir);
}

/** The strict empty MCP config for headless runs, written on demand. */
export function ensureNoMcpConfig(logDir: string): string {
  const path = noMcpConfigPath(logDir);
  if (!existsSync(path)) {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path, '{ "mcpServers": {} }\n', "utf8");
  }
  return path;
}

export function statusPath(logDir: string, id: string): string {
  return join(logDir, `${id}.status`);
}

export function eventsPath(logDir: string, id: string): string {
  return join(logDir, `${id}.jsonl`);
}

export function ledgerPath(logDir: string): string {
  return join(logDir, "ledger.log");
}

export function routingStatePath(logDir: string): string {
  return join(logDir, "routing-state.json");
}

export function panesDir(logDir: string): string {
  return join(logDir, "panes");
}

/**
 * The strict empty MCP config handed to headless workers. Written into the
 * logDir on demand (never into the user's vendor config directory — this is
 * PAI state, not vendor state).
 */
export function noMcpConfigPath(logDir: string): string {
  return join(logDir, "no-mcp.json");
}
