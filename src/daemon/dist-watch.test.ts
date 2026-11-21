import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistWatch, distBuildId, DIST_STABLE_MS } from "./dist-watch.js";

function setup(startId = "100") {
  const st = { id: startId as string | undefined, t: 0, busy: false };
  const restart = vi.fn();
  const log = vi.fn();
  const tick = createDistWatch({ readId: () => st.id, now: () => st.t, busy: () => st.busy, restart, log });
  return { st, restart, log, tick };
}

describe("daemon dist watch", () => {
  it("does nothing when dist is unchanged", () => {
    const { st, restart, tick } = setup();
    for (let i = 0; i < 10; i++) {
      st.t += DIST_STABLE_MS;
      expect(tick()).toBe("idle");
    }
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts once after the debounce, logging old -> new", () => {
    const { st, restart, log, tick } = setup();
    st.id = "200";
    expect(tick()).toBe("settling");
    st.t += DIST_STABLE_MS - 1;
    expect(tick()).toBe("settling");
    st.t += 1;
    expect(tick()).toBe("restarting");
    tick();
    tick();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("DAEMON-SELF-RESTART reason=dist changed (100 -> 200)");
  });

  it("restarts the debounce when the build keeps changing", () => {
    const { st, restart, tick } = setup();
    st.id = "200";
    tick();
    st.t += DIST_STABLE_MS - 1;
    st.id = "300";
    expect(tick()).toBe("settling");
    st.t += DIST_STABLE_MS - 1;
    expect(tick()).toBe("settling");
    st.t += 1;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("waits for a running pass, then restarts", () => {
    const { st, restart, tick } = setup();
    st.busy = true;
    st.id = "200";
    tick();
    st.t += DIST_STABLE_MS * 5;
    expect(tick()).toBe("waiting-pass");
    expect(restart).not.toHaveBeenCalled();
    st.busy = false;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("ignores an unreadable dist (mid-build)", () => {
    const { st, restart, tick } = setup();
    st.id = undefined;
    st.t += DIST_STABLE_MS * 2;
    expect(tick()).toBe("idle");
    expect(restart).not.toHaveBeenCalled();
  });

  it("never restarts onto an older build: an id under ours stays idle and re-arms", () => {
    const { st, restart, tick } = setup();
    st.id = "050"; // a rollback: dist holds an OLDER generation than what we run
    for (let i = 0; i < 3; i++) {
      st.t += DIST_STABLE_MS;
      expect(tick()).toBe("idle");
    }
    expect(restart).not.toHaveBeenCalled();
    st.id = "200"; // and a later build still fires: the guard does not park the watcher
    tick();
    st.t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("compares ids across a clock-width change (a µs stamp crossing a digit width)", () => {
    // not hypothetical: now is 16 digits, year 2262 is 17. A bare string compare would read the longer NEWER
    // stamp as OLDER and park the watcher; padding fixes the order, sameId keeps one build written two ways
    // ("0…9" vs "9…") from reading as a change — that is a restart loop.
    const { st, restart, log, tick } = setup("0".repeat(16) + "9".repeat(16)); // our start id: an old-clock stamp written with leading zeros
    st.id = "9".repeat(16); // the same build read again, written plain
    st.t += DIST_STABLE_MS;
    expect(tick()).toBe("idle"); // equal once padded: still our build
    expect(log).not.toHaveBeenCalled(); // a differently-written SAME id is not a change (never restart-loop)
    st.id = "0".repeat(32 - 17) + "1" + "0".repeat(16); // a clock past year 2262: one digit longer, NEWER
    tick();
    st.t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting");
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A rebuild can REPLACE the watched path. 2026-11-20 22:25: `pai worker merge`
// rebuilt dist and the watcher stayed idle — the watched path is the entry FILE,
// and a replacement (restoreDistGeneration renames a staging dir over dist; a
// clean build replaces the dir too) puts a fresh inode there. When the swapped-in
// entry matches what we run byte for byte (same size, emitted mtimes not newer),
// an id of "entry mtime + size" never moves: `id === startId` forever, and the
// merge gate restarted the daemon by hand ("watcher missed the build"). The id
// now walks the ENTRY's own dir (what production builds: entries plus the prune
// manifest written last): the DIR at max(mtime, birthtime), its FILES at
// max(mtime, birthtime), its top-level DIRS at mtime only — a staged generation's
// files carry the staging moment in their birthtime and APFS keeps it across both
// rename and utimes (probed), so a swap cannot hide; hooks/skills restage inside
// top-level dirs every build, so those count at mtime and nothing below is read.
// A generation staged BEFORE ours (a rollback) stays under our id, and the watcher
// ignores an id at or below ours: never restart onto old code. These drive real
// files and real rename-swaps in a temp dir.
// ---------------------------------------------------------------------------

const roots: string[] = [];

/** A fixed clock in the past for settled-state fixtures (2026-11-18, behind this machine's clock). */
const BASE_MS = 1_795_000_000_000;
/** A fixed clock one hour ahead: a checkout root keeps future stamps from unrelated work (commits, tools). */
const FUTURE_MS = Date.now() + 3_600_000;

/**
 * A dist as production builds it: the entry sits directly in dist next to the prune
 * manifest, which prune-dist writes AFTER tsdown emits — the build's last write. Built
 * inside a staging dir that is then renamed into place and parked at `atMs`: a rename
 * keeps BOTH clocks of everything moved (probed on APFS), so after this every stamp the
 * id walks is exactly `atMs` in both clocks — utimes cannot move a birthtime, so hiding
 * the fixture's own creation moment is what this staging does.
 */
function mkDist(atMs = BASE_MS): { root: string; dist: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "pai-distwatch-"));
  roots.push(root);
  const stage = join(root, "gen"); // born now — the only "now" stamp left in the tree afterwards
  mkdirSync(stage);
  const dist = join(stage, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.mjs"), "console.log(1);\n");
  utimesSync(join(dist, "index.mjs"), new Date(atMs), new Date(atMs)); // park the entry too: tsdown re-stamps emitted files (and a birthtime moves DOWN under utimes — probed), so this is what a settled build holds
  renameSync(dist, join(root, "dist")); // both stamps of the dir and its files travel with it…
  utimesSync(stage, new Date(atMs), new Date(atMs)); // …park what utimes can; `gen`'s own birthtime stays "now" but is never walked (the id walks dist only)
  freezeDir(join(root, "dist"), atMs); // the rename bumps root's mtime and a build re-stamps dist after staging it in — park dist too: this is how a settled running build looks on disk (utimes moves a birthtime down, never up)
  return { root, dist: join(root, "dist"), entry: join(root, "dist", "index.mjs") };
}

/** The build's last write: prune-dist writes its manifest after tsdown emits the entries. Writing it bumps
 * dist's own mtime to NOW (a dir entry was added) — a real build stamps dist AFTER staging renames it in, so
 * park dist at `atMs` on the way out: that is exactly how a settled running build looks on disk. */
function stampBuild(dist: string, atMs: number): void {
  const manifest = join(dist, ".prune-manifest.json");
  writeFileSync(manifest, "{}");
  utimesSync(manifest, new Date(atMs), new Date(atMs)); // mtime moves, birthtime stays the staging moment — exactly what a build's re-stamp does
  freezeDir(dist, atMs); // the manifest write bumped dist's mtime to now: park it back (utimes moves a birthtime down too, probed)
}

/** Rename-swap a staging dir over dist, exactly like restoreDistGeneration does. */
function swapDist(root: string, dist: string, entryBytes: string): void {
  const stage = join(root, "dist.new");
  mkdirSync(stage); // born now: the staging birthtime no rename or utimes can erase
  writeFileSync(join(stage, "index.mjs"), entryBytes);
  stampBuild(stage, Date.now()); // the rebuild writes its manifest inside the staging dir before swapping it in
  renameSync(dist, join(root, `dist.old.${process.hrtime.bigint()}`));
  renameSync(stage, dist);
}

/**
 * Freeze a dir's own mtime to `atMs`. utimes does not touch a parent's mtime (only
 * add/remove/rename does) and never touches birthtime — so after this the dir carries
 * exactly the stamp set here (plus its staging birthtime), and nothing created before it
 * leaks in with a "now" mtime. The id walks only the entry's dir, so no ancestor freeze
 * is needed: a future stamp on root must not reach the id (that is the ancestor test).
 */
function freezeDir(dir: string, atMs: number): void {
  utimesSync(dir, new Date(atMs), new Date(atMs));
}

afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the build id of a dist dir", () => {
  it("is undefined while the entry or its dir is missing (mid-build)", () => {
    const { dist, entry } = mkDist();
    rmSync(dist, { recursive: true, force: true });
    expect(distBuildId(entry)).toBeUndefined();
  });

  it("moves when a file the build wrote last is newer than the entry", () => {
    const { dist, entry } = mkDist(BASE_MS - 1_000); // our build settled: dir at an older stamp…
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS)); // …entry emitted before the manifest
    const idA = distBuildId(entry)!;
    stampBuild(dist, BASE_MS + 5_000); // prune-dist writes its manifest after tsdown emits the entries
    expect(distBuildId(entry)).not.toBe(idA);
  });

  it("ignores mtimes nested under dist (hooks/skills staging restamps those every build)", () => {
    // staged NOW and parked DOWN to BASE_MS — a rename carries birthtimes through untouched, but utimes moves
    // them down too (probed on APFS), so this is the closest a settled running build can look: every stamp the
    // id walks is exactly BASE_MS in both clocks. What must not move the id from there is work nested under
    // dist: hooks/skills staging re-creates dirs there on every build, and their fresh stamps are invisible
    // to the walk (dirs skipped, nothing below them read).
    const { dist, entry } = mkDist(BASE_MS);
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS));
    stampBuild(dist, BASE_MS); // manifest written last at our stamp — its birthtime is counted too: it must stay ≤ ours
    const idA = distBuildId(entry)!;
    mkdirSync(join(dist, "hooks")); // a top-level dir staged NOW: its own fresh stamps are NOT walked…
    writeFileSync(join(dist, "hooks", "guard.mjs"), "x"); // …and neither is the work nested inside it
    freezeDir(dist, BASE_MS); // the mkdir bumped dist's mtime to now — a build re-stamps dist after staging: park it back
    expect(distBuildId(entry)).toBe(idA); // one level only: nested work never re-stamps the build id
  });

  it("ignores mtimes above dist (the package root keeps future stamps from unrelated work)", () => {
    const { root, dist, entry } = mkDist(); // our build settled at BASE_MS everywhere walked…
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS));
    const idA = distBuildId(entry)!;
    utimesSync(root, new Date(FUTURE_MS), new Date(FUTURE_MS)); // a future stamp one level ABOVE dist (a checkout's root)
    expect(distBuildId(entry)).toBe(idA); // an ancestor's mtime must not pin `id > startId` forever: that is a restart loop
  });

  it("the 2026-11-20 miss: a replaced dist with byte-identical entry bytes still moves the id", () => {
    const { root, dist, entry } = mkDist(); // our build settled at BASE_MS — older than anything the rebuild carries
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS));
    const idA = distBuildId(entry)!;
    swapDist(root, dist, "console.log(1);\n"); // same bytes staged NOW: a fresh dir whose stamps are the staging moment…
    freezeDir(dist, BASE_MS); // …re-stamped to our own stamp on the way in (mtime alone would hide)
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS));
    expect(distBuildId(entry)).not.toBe(idA); // birthtime is what a rename-swap cannot erase: the id moved
  });

  it("a replacement whose entry keeps the same size but changes content moves the id too", () => {
    const { root, dist, entry } = mkDist(); // our build settled at BASE_MS…
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS));
    const idA = distBuildId(entry)!;
    swapDist(root, dist, "console.log(2);\n"); // 16 bytes again: an entry size+mtime id would not move
    freezeDir(dist, BASE_MS); // the swapped-in dir's mtime is re-stamped to our own…
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS)); // …and so is the entry's
    expect(distBuildId(entry)).not.toBe(idA); // …the swap still shows: the staged dir's and manifest's birthtimes are now
  });
});

describe("the watcher across a dist that gets replaced", () => {
  it("fires on a rebuild that rename-swaps dist with byte-identical entry bytes (2026-11-20 22:25)", () => {
    const { root, dist, entry } = mkDist(Date.now() - 60_000); // our running build settled a minute ago: nothing the swap carries is older than this
    let restarts = 0;
    let t = 0;
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle"); // settled on the running build
      t += DIST_STABLE_MS + 1_000;
    }
    swapDist(root, dist, "console.log(1);\n"); // the merge rebuild replaces dist, entry bytes identical — the swap itself is the event
    expect(tick()).toBe("settling"); // the staged dir's and manifest's birthtimes are seen…
    t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting"); // …and after the debounce the daemon restarts onto it
    expect(restarts).toBe(1);
    for (let i = 0; i < 3; i++) expect(tick()).toBe("restarting"); // one fire per distinct id
  });

  it("stays idle across a replacement that carries no newer stamp than what we run (a rollback)", () => {
    const { root, dist, entry } = mkDist(Date.now() - 60_000); // our running build settled a minute ago everywhere walked…
    let restarts = 0;
    let t = 0;
    stampBuild(dist, Date.now() + 60_000); // …and its manifest is stamped a minute AHEAD of everything the rolled-back generation carries (its last write)
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle");
      t += DIST_STABLE_MS + 1_000;
    }
    // the rolled-back generation was staged BEFORE our build: same old entry, its manifest last-written half a
    // minute ago — every stamp under it is older than ours (a rename keeps both clocks of everything moved)
    const { dist: oldGen } = mkDist(Date.now() - 60_000);
    stampBuild(oldGen, Date.now() - 30_000);
    renameSync(dist, join(root, "dist.current"));
    renameSync(oldGen, dist); // rolled back to an older generation: nothing newer on disk (the root's rename mtime is not walked)
    for (let i = 0; i < 4; i++) {
      expect(tick()).toBe("idle"); // id < startId: a rollback onto OLD code must never trigger a restart onto it
      t += DIST_STABLE_MS + 1_000;
    }
    expect(restarts).toBe(0);
  });

  it("re-arms after a replacement: a second rebuild fires again", () => {
    const { root, dist, entry } = mkDist(Date.now() - 60_000); // our running build settled older than what comes next
    let restarts = 0;
    let t = 0;
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle");
      t += DIST_STABLE_MS + 1_000;
    }
    swapDist(root, dist, "console.log(1);\n"); // first rebuild: the swap itself moves the id
    tick(); // settle clock starts on the new id…
    t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting"); // …and after the debounce it fires
    expect(restarts).toBe(1);
    // the next rebuild re-stamps dist again: a fresh id fires once more. The watcher ignores an id at or below ours
    // (a rollback must never restart us onto old code), so this one has to be NEWER than the swap's staging stamp.
    utimesSync(join(dist, ".prune-manifest.json"), new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    expect(tick()).toBe("settling"); // the fired flag re-arms on a new id…
    t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting");
    expect(restarts).toBe(2);
  });
});
