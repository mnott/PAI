/**
 * paths.ts — where worker run artefacts live.
 *
 * Everything a run writes (event mirror, status file, pane registry, routing
 * state, the empty MCP config) sits under one logDir so the whole tree is
 * disposable and configurable: `workers.logDir`, default ~/.claude/logs/workers.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWorkersConfig, expandHome, type WorkersConfig } from "./config.js";
import { paiHomePath, resolvePaiFile } from "../config/pai-home.js";

/** The shipped default logDir (a YAML parse), read once. */
let shippedLogDir: string | undefined;

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
  if (config.logDir !== (shippedLogDir ??= defaultWorkersConfig().logDir)) return expanded;
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

/** Where `pai worker gc` moves the files of long-finished workers: <logDir>/archive/<YYYY-MM>/. */
export function archiveRoot(logDir: string): string {
  return join(logDir, "archive");
}

/**
 * The one id -> file resolver: `<logDir>/<id><suffix>`, or, when the top folder has no such file and an
 * archive month does, that archived copy. Scans (loadStatuses, ps, cockpit) read the top folder only.
 * The archive listing is cached per logDir: a reaper tick resolves hundreds of ids, and re-reading the
 * archive directory per id was the bulk of the tick's synchronous fs time. A `pai worker gc` runs in a
 * separate process and can create a new month folder (the first archive of a new month) while a daemon
 * lives for days, so the cache is kept fresh: it expires after ARCHIVE_LISTING_TTL_MS, and a lookup that
 * finds nothing in the cached months re-reads the listing once before giving up.
 */
const ARCHIVE_LISTING_TTL_MS = 60_000;
const archiveListing = new Map<string, { months: string[]; readAt: number }>();

/** Read the archive month folders (newest first); never throws — no archive reads as empty. */
function readArchiveMonths(logDir: string): string[] {
  try {
    return readdirSync(archiveRoot(logDir)).sort().reverse();
  } catch {
    /* no archive */
    return [];
  }
}

/** The cached month listing for logDir, re-read when the cache is absent or older than the TTL. */
function archiveMonths(logDir: string, now: number): string[] {
  const hit = archiveListing.get(logDir);
  if (hit && now - hit.readAt < ARCHIVE_LISTING_TTL_MS) return hit.months;
  const months = readArchiveMonths(logDir);
  archiveListing.set(logDir, { months, readAt: now });
  return months;
}

export function workerFilePath(logDir: string, id: string, suffix: string): string {
  const top = join(logDir, `${id}${suffix}`);
  if (existsSync(top)) return top;
  const find = (months: string[]): string | undefined => {
    for (const month of months) {
      const p = join(archiveRoot(logDir), month, `${id}${suffix}`);
      if (existsSync(p)) return p;
    }
    return undefined;
  };
  let found = find(archiveMonths(logDir, Date.now()));
  if (!found) {
    // a miss may mean a month folder this process has never seen: re-read once before giving up
    found = find(readArchiveMonths(logDir));
  }
  return found ?? top;
}

export function statusPath(logDir: string, id: string): string {
  return workerFilePath(logDir, id, ".status");
}

export function eventsPath(logDir: string, id: string): string {
  return workerFilePath(logDir, id, ".jsonl");
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
