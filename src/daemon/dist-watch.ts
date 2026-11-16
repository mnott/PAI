/**
 * Self-restart on a new build: `pai worker merge` and `pai release` rebuild dist
 * under the running daemon, which kept serving the old code until someone ran
 * `pai daemon restart`. The watcher polls the entry file's whole-microsecond mtime
 * (the build id); once it differs from the id the daemon started with and has
 * stayed the same for the debounce (a build writes many files), and no write-heavy
 * pass is running, it restarts. The restart is a SIGTERM to ourselves: the existing
 * shutdown path closes the store and removes the socket, launchd (KeepAlive) starts
 * the new build.
 *
 * Two ways tonight (2026-11-16) this missed a build, both fixed here:
 * - The id was `Math.round(mtimeMs)`. A rebuild can land in the same millisecond as
 *   the previous one (or re-emit identical bytes with an older mtime), and then the
 *   new build's id equals the old: nothing to see. The id is now the raw whole-µs
 *   mtime plus the file size — two builds in one ms differ by at least a byte, and
 *   a re-emitted identical build needs no restart anyway.
 * - One busy tick parked the watcher for the full debounce again (a daemon under
 *   load was blocked in pane-audit/local-idle for seconds at a stretch), and after
 *   the first fire it never looked again. The settle timer now only resets when the
 *   id itself changes, and the fired flag is re-armed whenever the id returns to
 *   the start value (a restart that launchd brought back on the old build).
 */
import { statSync } from "node:fs";

/** A build writes many files; dist must hold the same id this long before we act. */
export const DIST_STABLE_MS = 10_000;
export const DIST_POLL_MS = 5_000;

export interface DistWatchDeps {
  /** Current build id of dist (entry file mtime + size), undefined when unreadable (mid-build). */
  readId: () => string | undefined;
  now: () => number;
  /** True while an index/embed pass is writing; the restart waits for it. Read once per tick, before the settle clock advances. */
  busy: () => boolean;
  restart: (reason: string) => void;
  log: (line: string) => void;
}

/** Returns a tick to run on a timer; fires `restart` at most once per distinct new id. */
export function createDistWatch(d: DistWatchDeps, startId: string | undefined = d.readId()): () => "idle" | "settling" | "waiting-pass" | "restarting" {
  let seen: string | undefined;
  let since = 0;
  let fired = false;
  return () => {
    // one clock reading per tick, taken before busy(): the real busy() reads job files and never moves the
    // clock, but a fake that advances per call must not make waiting out a pass look like settling.
    const now = d.now();
    const id = d.readId();
    const busy = d.busy();
    if (id === undefined || startId === undefined || id === startId) {
      // no readable change right now, or the entry is back on our own build: forget any pending settle,
      // and re-arm so a later build can fire again (a failed restart leaves us on startId).
      seen = undefined;
      fired = false;
      return "idle";
    }
    if (fired) return "restarting";
    if (id !== seen) {
      seen = id;
      since = now; // only a NEW id restarts the settle clock; waiting out a busy pass does not
    }
    if (now - since < DIST_STABLE_MS) return "settling";
    if (busy) return "waiting-pass";
    fired = true;
    const reason = `dist changed (${startId} -> ${id})`;
    d.log(`DAEMON-SELF-RESTART reason=${reason}`);
    d.restart(reason);
    return "restarting";
  };
}

/**
 * Build id of the dist entry file: its whole-microsecond mtime plus size. Not rounded to ms — a rebuild
 * finishing in the same millisecond as the previous one must still read as a new build (the 2026-11-16 miss).
 */
export function distBuildId(entry: string): string | undefined {
  try {
    const st = statSync(entry);
    return `${Math.round(st.mtimeMs * 1000)}:${st.size}`;
  } catch {
    return undefined;
  }
}
