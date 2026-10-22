/**
 * paths.ts — where worker run artefacts live.
 *
 * Everything a run writes (event mirror, status file, pane registry, routing
 * state, the empty MCP config) sits under one logDir so the whole tree is
 * disposable and configurable: `workers.logDir`, default ~/.claude/logs/workers.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWorkersConfig, expandHome, type WorkersConfig } from "./config.js";
import { paiHomePath, resolvePaiFile } from "../config/pai-home.js";

/**
 * Absolute logDir for the given config. An explicit `logDir` in workers.yaml
 * is honored verbatim (the user chose it). Otherwise this resolves like every
 * other PAI_HOME file: PAI_HOME/logs/workers if it exists, else the old
 * ~/.claude/logs/workers (with a one-time notice), else the new path.
 */
export function workersLogDir(config: Pick<WorkersConfig, "logDir">): string {
  const expanded = expandHome(config.logDir);
  // the shipped default is the sentinel: an explicit user logDir (whatever it
  // says) is honored verbatim; only the unset default resolves through PAI_HOME
  if (config.logDir !== defaultWorkersConfig().logDir) return expanded;
  // the old ~/.claude/logs/workers belongs to the default home only: a
  // PAI_HOME override (temp home, second install) never owns it, so no hint
  if (process.env.PAI_HOME) return paiHomePath("logs", "workers");
  return resolvePaiFile(paiHomePath("logs", "workers"), [expanded], "pai config migrate --logs");
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

/** A worker id as a file stem: no path separators, so `<logDir>/<id>.status` stays inside logDir. */
export const WORKER_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

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

/** Job id a pooled slot is serving right now (one line); absent while the slot is idle. */
export function slotCurrentPath(logDir: string, slot: string): string {
  return join(logDir, "slots", `${slot}.current`);
}
