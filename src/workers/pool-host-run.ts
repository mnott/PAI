/**
 * pool-host-run.ts — process-level plumbing of the detached pool host: a capped log for its
 * stdout/stderr, a ledger line for every exit, and the bind policy that keeps one owner of the port.
 */
import { existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { poolDir } from "./pool.js";

const LOG_CAP_BYTES = 1_000_000;

export function poolHostLogPath(logDir: string): string {
  return join(poolDir(logDir), "host.log");
}

/** Open host.log for append; a log over the cap moves to host.log.1 first (one generation kept). Returns the fd for the child's stdio. */
export function openHostLog(logDir: string, capBytes = LOG_CAP_BYTES): number {
  mkdirSync(poolDir(logDir), { recursive: true });
  const path = poolHostLogPath(logDir);
  try {
    if (existsSync(path) && statSync(path).size > capBytes) renameSync(path, `${path}.1`);
  } catch {
    /* rotation is best effort */
  }
  return openSync(path, "a");
}

export interface ExitHooks {
  logDir: string;
  pid: number;
  on: (ev: "uncaughtException" | "unhandledRejection", cb: (e: unknown) => void) => void;
  exit: (code: number) => void;
  write?: (line: string) => void;
}

/** An uncaught exception or unhandled rejection leaves a POOL-HOST-EXIT ledger line (and a log line) before the host exits 1. */
export function installExitLogging(h: ExitHooks): void {
  for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
    h.on(ev, (e) => {
      const reason = e instanceof Error ? (e.stack ?? e.message) : String(e);
      h.write?.(`pai worker pool host: ${ev}: ${reason}\n`);
      logHostExit(h.logDir, h.pid, `${ev}: ${reason.split("\n")[0]}`);
      h.exit(1);
    });
  }
}

export function logHostExit(logDir: string, pid: number, reason: string): void {
  if (!logDir) return;
  try {
    appendLedger(ledgerPath(logDir), "POOL-HOST-EXIT", { pid, reason });
  } catch {
    /* the ledger must not mask the exit */
  }
}

export interface BindDeps {
  listen: () => void;
  /** Does a healthy pool host answer on the port? */
  alive: () => Promise<boolean>;
  retry: (fn: () => void, ms: number) => void;
  /** Leave the process: code 0 = another host owns the port. */
  fail: (code: number, reason: string) => void;
  maxTries?: number;
}

/**
 * Handle a listen error. EADDRINUSE is not fatal on its own: the port may still be held by the
 * predecessor being replaced (retry until it lets go), and when a healthy host answers there the
 * port has an owner already — this one steps aside (exit 0) instead of dying as a stale state file.
 */
export function createBindHandler(d: BindDeps): (e: NodeJS.ErrnoException) => void {
  let tries = 0;
  return (e) => {
    if (e.code !== "EADDRINUSE") return d.fail(1, `cannot listen: ${e.message}`);
    void d.alive().then((owned) => {
      if (owned) return d.fail(0, "superseded: another pool host owns the port");
      if (++tries < (d.maxTries ?? 40)) return d.retry(d.listen, 250);
      d.fail(1, `cannot listen: ${e.message} (port still held after ${tries} tries)`);
    });
  };
}
