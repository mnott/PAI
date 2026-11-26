/**
 * pane-open-lock.ts — serializes iTerm pane creation across processes (parallel `pai worker run --detach`
 * spawns made iTerm slow enough that osascript timed out) and retries a timed-out open with backoff.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./status.js";
import { setOsascriptTimeout } from "./pane.js";

export const PANE_OPEN_TIMEOUTS_MS = [5_000, 10_000, 20_000];
const STALE_MS = 120_000;
const WAIT_MS = 90_000;

export interface OpenLockDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  pid?: number;
  waitMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when `e` is an osascript timeout (the retryable pane-open failure). */
export const isOsascriptTimeout = (e: unknown): boolean => /osascript timed out/.test(e instanceof Error ? e.message : String(e));

/** Run `fn` holding the cross-process pane-open lock; a stale lock (dead pid or old) is taken over; after a long wait fn runs anyway. */
export async function withPaneOpenLock<T>(logDir: string, fn: () => Promise<T>, deps: OpenLockDeps = {}): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const alive = deps.isAlive ?? ((p: number) => pidAlive(p));
  const pid = deps.pid ?? process.pid;
  const path = join(logDir, "pane-open.lock");
  mkdirSync(logDir, { recursive: true });
  const deadline = now() + (deps.waitMs ?? WAIT_MS);
  let held = false;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid, at: now() }), { flag: "wx" });
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break;
    }
    let stale = true;
    try {
      const l = JSON.parse(readFileSync(path, "utf8")) as { pid: number; at: number };
      stale = !(Number.isInteger(l.pid) && alive(l.pid) && now() - l.at < STALE_MS);
    } catch {
      /* unreadable: stale */
    }
    if (stale) {
      try {
        unlinkSync(path);
      } catch {
        /* raced */
      }
      continue;
    }
    if (now() >= deadline) break; // never fail the start on the lock
    await sleep(200);
  }
  try {
    return await fn();
  } finally {
    if (held) {
      try {
        unlinkSync(path);
      } catch {
        /* gone */
      }
    }
  }
}

/**
 * Open a pane under the lock: up to 3 tries with osascript timeouts 5/10/20 s and a backoff between. Only
 * osascript timeouts retry; any other error propagates. Throws the last timeout when all tries time out.
 */
export async function retryPaneOpen<T>(
  logDir: string,
  open: () => Promise<T>,
  deps: OpenLockDeps & { timeouts?: number[]; setTimeoutMs?: (ms?: number) => void; backoffMs?: number } = {}
): Promise<T> {
  const sleep = deps.sleep ?? realSleep;
  const timeouts = deps.timeouts ?? PANE_OPEN_TIMEOUTS_MS;
  const set = deps.setTimeoutMs ?? setOsascriptTimeout;
  return withPaneOpenLock(
    logDir,
    async () => {
      let last: unknown;
      for (let i = 0; i < timeouts.length; i++) {
        set(timeouts[i]);
        try {
          return await open();
        } catch (e) {
          if (!isOsascriptTimeout(e)) throw e;
          last = e;
          if (i < timeouts.length - 1) await sleep((deps.backoffMs ?? 1_000) * (i + 1));
        } finally {
          set();
        }
      }
      throw last;
    },
    deps
  );
}
