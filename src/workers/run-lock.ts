/**
 * run-lock.ts — one plan or queue run at a time. The run writes a lock file
 * with its pid and start time and removes it on exit; a lock whose pid is dead
 * is taken over.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive } from "./status.js";

export interface RunLock {
  pid: number;
  startedAt: number;
}

export const planLockPath = (planPath: string): string => `${planPath}.lock`;
export const queueLockPath = (queueStatePath: string): string => `${queueStatePath}.lock`;

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const sinceText = (l: RunLock): string => `since ${hhmm(l.startedAt)} (pid ${l.pid})`;

export class RunLockedError extends Error {
  constructor(readonly what: string, readonly lock: RunLock) {
    super(`a run of ${what} is already in progress since ${hhmm(lock.startedAt)}`);
  }
}

/** The lock of a live run, or null (no file, unreadable, or a dead pid). */
export function readRunLock(path: string, isAlive: (pid: number) => boolean = (p) => pidAlive(p)): RunLock | null {
  if (!existsSync(path)) return null;
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as RunLock;
    return Number.isInteger(l.pid) && l.pid > 0 && typeof l.startedAt === "number" && isAlive(l.pid) ? l : null;
  } catch {
    return null;
  }
}

export interface LockDeps {
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  /** Runs on SIGTERM/SIGINT before the lock is released and the process exits (stop workers, write the run-end). */
  onSignal?: (sig: NodeJS.Signals) => Promise<void>;
  /** Exit hook; tests replace process.exit. */
  exit?: (code: number) => void;
}

/** Run `fn` holding the lock at `path`; refuses when a live run holds it. `what` names the run in the message. */
export async function withRunLock<T>(path: string | undefined, what: string, fn: () => Promise<T>, deps: LockDeps = {}): Promise<T> {
  if (!path) return fn();
  const pid = deps.pid ?? process.pid;
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({ pid, startedAt: (deps.now ?? Date.now)() } satisfies RunLock);
  for (let attempt = 0; ; attempt++) {
    const held = readRunLock(path, deps.isAlive);
    if (held && held.pid !== pid) throw new RunLockedError(what, held);
    try {
      // exclusive create: of two racing runs only one gets the file
      writeFileSync(path, body, { encoding: "utf8", flag: held ? "w" : "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // a stale (dead-pid / unreadable) lock is in the way: clear it and retry once
      if (attempt >= 2) throw e;
      if (!readRunLock(path, deps.isAlive)) {
        try {
          unlinkSync(path);
        } catch {
          /* raced */
        }
      }
    }
  }
  const release = (): void => {
    try {
      const l = JSON.parse(readFileSync(path, "utf8")) as RunLock;
      if (l.pid === pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  let signalled = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    void (async () => {
      try {
        await deps.onSignal?.(sig);
      } catch {
        /* the exit must happen anyway */
      }
      release();
      (deps.exit ?? process.exit)(128 + (sig === "SIGTERM" ? 15 : 2));
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    return await fn();
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    release();
  }
}
