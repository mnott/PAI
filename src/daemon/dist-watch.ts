/**
 * Self-restart on a new build: `pai worker merge` and `pai release` rebuild dist
 * under the running daemon, which kept serving the old code until someone ran
 * `pai daemon restart`. The watcher polls dist's whole-microsecond newest mtime
 * (the build id); once it differs from the id the daemon started with and has
 * stayed the same for the debounce (a build writes many files), and no write-heavy
 * pass is running, it restarts. The restart is a SIGTERM to ourselves: the existing
 * shutdown path closes the store and removes the socket, launchd (KeepAlive) starts
 * the new build.
 *
 * Three ways this missed a build, all fixed here:
 * - 2026-11-16, the id was `Math.round(mtimeMs)` of the entry file. A rebuild can land
 *   in the same millisecond as the previous one (or re-emit identical bytes with an
 *   older mtime), and then the new build's id equals the old: nothing to see. The id
 *   became the raw whole-µs mtime plus the file size.
 * - 2026-11-16, one busy tick parked the watcher for the full debounce again (a daemon
 *   under load was blocked in pane-audit/local-idle for seconds at a stretch), and after
 *   the first fire it never looked again. The settle timer now only resets when the
 *   id itself changes, and the fired flag is re-armed whenever the id returns to
 *   the start value (a restart that launchd brought back on the old build).
 * - 2026-11-20 22:25, the watched path was the entry FILE. A rebuild can REPLACE dist —
 *   the rollback path renames a staging dir over it (`restoreDistGeneration`), and any
 *   future clean build replaces the dir too — so the path we poll is a fresh inode after
 *   the swap. When the new generation's entry has the same size and its emitted mtimes
 *   do not exceed what we run (a merge whose changes are not imported by an entry, or a
 *   byte-identical re-emit), the entry id never moves: `id === startId`, forever idle,
 *   while the merge gate's 60 s verify window ran out and restarted the daemon by hand.
 *   The id is now dist's NEWEST whole-µs mtime over the dir and its files (the same walk
 *   scripts/dist-stale.mjs does): a build always writes something after the entry — the
 *   prune manifest, then hooks/docs/skill-stubs — so even a replacement whose bytes are
 *   identical carries a fresh stamp, and a rename-swap never hides it. The entry file is
 *   still included in the walk: a rebuild that touches only files older than it must
 *   still read as newer than what we run (2026-11-16's same-ms re-emit stays covered).
 */
import { readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** A build writes many files; dist must hold the same id this long before we act. */
export const DIST_STABLE_MS = 10_000;
export const DIST_POLL_MS = 5_000;

export interface DistWatchDeps {
  /** Current build id of dist (its newest whole-µs mtime), undefined when unreadable (mid-build). */
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
      // no readable change right now, or dist is back on our own build: forget any pending settle,
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
 * Build id of a dist dir: its NEWEST whole-µs mtime over the dir itself, one level of
 * entries and the entry file. Not rounded to ms — a rebuild finishing in the same
 * millisecond as the previous one must still read as a new build (the 2026-11-16 miss) —
 * and not taken from the entry alone: a rebuild that replaces dist (a rename-swap of a
 * staging dir, a clean build) leaves us polling a fresh inode whose entry can match what
 * we run byte for byte, while the build's last writes land beside it (the 2026-11-20 miss).
 * One level only: dist/hooks and dist/skills are rewritten by their own atomic staging
 * steps on every build, so recursing there would re-stamp on work that never changes the
 * code we run; top-level mtimes (entries, maps, the prune manifest) cover every rebuild.
 */
export function distBuildId(entry: string): string | undefined {
  try {
    const newest = Math.round(statSync(entry).mtimeMs * 1000);
    const dir = dirname(entry);
    let id = Math.max(newest, Math.round(statSync(dir).mtimeMs * 1000));
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      try {
        const t = Math.round(statSync(`${dir}/${e.name}`).mtimeMs * 1000);
        if (t > id) id = t;
      } catch {
        /* vanished mid-walk (the build is swapping files): the rest of the dir still stamps */
      }
    }
    return String(id);
  } catch {
    return undefined; // entry or dir unreadable: mid-build (or dist was just replaced), retry next tick
  }
}
