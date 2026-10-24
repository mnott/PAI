/**
 * Self-restart on a new build: `pai worker merge` and `pai release` rebuild dist
 * under the running daemon, which kept serving the old code until someone ran
 * `pai daemon restart`. The watcher polls the entry file's mtime (the build id);
 * once it differs from the id the daemon started with and has stayed the same for
 * the debounce (a build writes many files), and no write-heavy pass is running, it
 * restarts. The restart is a SIGTERM to ourselves: the existing shutdown path closes
 * the store and removes the socket, launchd (KeepAlive) starts the new build.
 */
import { statSync } from "node:fs";

/** A build writes many files; dist must hold the same id this long before we act. */
export const DIST_STABLE_MS = 10_000;
export const DIST_POLL_MS = 5_000;

export interface DistWatchDeps {
  /** Current build id of dist (entry file mtime), undefined when unreadable (mid-build). */
  readId: () => string | undefined;
  now: () => number;
  /** True while an index/embed pass is writing; the restart waits for it. */
  busy: () => boolean;
  restart: (reason: string) => void;
  log: (line: string) => void;
}

/** Returns a tick to run on a timer; fires `restart` at most once. */
export function createDistWatch(d: DistWatchDeps, startId: string | undefined = d.readId()): () => "idle" | "settling" | "waiting-pass" | "restarting" {
  let seen: string | undefined;
  let since = 0;
  let fired = false;
  return () => {
    if (fired) return "restarting";
    const id = d.readId();
    if (id === undefined || startId === undefined || id === startId) {
      seen = undefined;
      return "idle";
    }
    if (id !== seen) {
      seen = id;
      since = d.now();
    }
    if (d.now() - since < DIST_STABLE_MS) return "settling";
    if (d.busy()) return "waiting-pass";
    fired = true;
    const reason = `dist changed (${startId} -> ${id})`;
    d.log(`DAEMON-SELF-RESTART reason=${reason}`);
    d.restart(reason);
    return "restarting";
  };
}

/** Build id of the dist entry file: its mtime in ms. */
export function distBuildId(entry: string): string | undefined {
  try {
    return String(Math.round(statSync(entry).mtimeMs));
  } catch {
    return undefined;
  }
}
