/**
 * Self-restart on a new build: `pai worker merge` and `pai release` rebuild dist
 * under the running daemon, which kept serving the old code until someone ran
 * `pai daemon restart`. The watcher polls the build id of dist — the newest
 * whole-microsecond stamp over the entry's own dir (see `distBuildId`) — and once it
 * is newer than the id the daemon started with and has held for the debounce (a build
 * writes many files) with no write-heavy pass running, it restarts. The restart is a
 * SIGTERM to ourselves: the existing shutdown path closes the store and removes the
 * socket, launchd (KeepAlive) starts the new build.
 *
 * Three misses, each fixed here:
 * - 2026-11-16: the id was `Math.round(mtimeMs)` of the entry file. A rebuild can land
 *   in the same millisecond as the previous one, and then the new build's id equals the
 *   old: nothing to see. The id is now a raw whole-µs stamp — never rounded to ms.
 * - 2026-11-16: one busy tick parked the watcher for the full debounce again (a daemon
 *   under load was blocked in pane-audit/local-idle for seconds at a stretch), and after
 *   the first fire it never looked again. The settle timer now only resets when the id
 *   itself changes, and any id at or below ours re-arms the watcher.
 * - 2026-11-20 22:25: a merge rebuilt dist and the watcher stayed idle — the gate
 *   restarted the daemon by hand. The id was "entry mtime + size", and a rebuild can
 *   REPLACE dist (restoreDistGeneration rename-swaps a staging dir over it; a clean
 *   build replaces the dir too). A swapped-in entry byte-identical to what we run keeps
 *   the same size, and tsdown's emitted mtimes need not be newer: `id === startId`
 *   forever. The id now walks the entry's own dir — the DIR at max(mtime, birthtime),
 *   its top-level FILES at max(mtime, birthtime), nothing below them — because a
 *   rename-swap brings a freshly staged dir whose BIRTHTIME no utimes can move (probed
 *   on APFS: utimes moves a birthtime down, never up). Top-level DIR entries are not
 *   counted and nothing nested is read: hooks/skills staging re-creates dirs inside dist
 *   on every build with fresh mtimes, and that work must not re-stamp the id. The last
 *   write of a production build is prune-dist's manifest — a top-level file — so a plain
 *   in-place rebuild moves the id through it too.
 *
 * An id at or below ours never fires: dist holding an OLDER generation (a rollback)
 * must not restart us onto old code, and comparing padded strings keeps that true when
 * µs stamps change digit width.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** A build writes many files; dist must hold the same id this long before we act. */
export const DIST_STABLE_MS = 10_000;
export const DIST_POLL_MS = 5_000;

/** Same build id under two spellings: equal once leading zeros are stripped — never treat that as a change. */
const sameId = (a: string, b: string) => a.replace(/^0+/, "") === b.replace(/^0+/, "");
/** µs stamps as fixed-width strings: order by digits first, so a clock crossing a digit width still compares right. */
const cmpId = (v: string) => v.padStart(32, "0");

export interface DistWatchDeps {
  /** Current build id of dist (newest whole-µs stamp over the entry's dir; see distBuildId), undefined when unreadable (mid-build). */
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
    if (id === undefined || startId === undefined || sameId(id, startId)) {
      // no readable id right now, or dist is back on our own build: forget any pending settle and re-arm.
      seen = undefined;
      fired = false;
      return "idle";
    }
    if (cmpId(id) < cmpId(startId)) {
      // dist holds an OLDER generation (a rollback): never restart onto old code, but keep the fired flag —
      // we are waiting out a restart on `seen` — so a transient older build cannot re-arm us onto it.
      return "idle";
    }
    if (fired && id === seen) return "restarting"; // one fire per distinct id; we are waiting out the restart
    if (fired) {
      // a SECOND new id after firing (another rebuild landed while launchd brought us back): settle on it and
      // fire again — the fired flag must not park the watcher on the first fire's id forever.
      fired = false;
      seen = undefined;
    }
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
 * Build id of dist: the newest whole-microsecond stamp over the ENTRY's own dir — the DIR at
 * max(mtime, birthtime), its top-level FILES at max(mtime, birthtime). Not rounded to ms: a rebuild
 * finishing in the same millisecond as the previous one must still read as new (2026-11-16). Top-level
 * DIR entries are skipped and nothing below them is read: hooks/skills staging re-creates dirs inside
 * dist every build, and an id that counted their fresh stamps would fire on work that changed no code.
 * A rename-swapped generation cannot hide: the swapped-in dir (and prune-dist's manifest) was staged
 * fresh, and APFS keeps a birthtime across rename — utimes can move it DOWN but never UP. An ancestor
 * of dist is never walked: a checkout root carries future stamps from unrelated work, which would pin
 * `id > startId` forever and restart-loop the daemon.
 */
export function distBuildId(entry: string): string | undefined {
  try {
    const dir = dirname(entry);
    // statSync, not lstatSync: dist is a symlink in some installs (a released generation link) and the swap
    // replaces what it points at — following it sees the new generation.
    let us = Math.max(Math.round(statSync(dir).mtimeMs * 1000), Math.round(statSync(dir).birthtimeMs * 1000));
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // dirs are re-staged every build (hooks/skills) and a symlink's own birthtime is the link's, not its
      // target's — only regular files carry the build's stamps.
      if (!e.isFile()) continue;
      const st = statSync(join(dir, e.name));
      us = Math.max(us, Math.round(st.mtimeMs * 1000), Math.round(st.birthtimeMs * 1000));
    }
    return `${us}`;
  } catch {
    return undefined;
  }
}
