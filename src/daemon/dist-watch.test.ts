import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDistWatch, distBuildId, DIST_STABLE_MS } from "./dist-watch.js";

function setup() {
  const st = { id: "100" as string | undefined, t: 0, busy: false };
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
});

// ---------------------------------------------------------------------------
// A rebuild can REPLACE the watched path. 2026-11-20 22:25: `pai worker merge`
// rebuilt dist and the watcher stayed idle — the watched path is the entry FILE,
// and a replacement (restoreDistGeneration renames a staging dir over dist; a
// clean build replaces the dir too) puts a fresh inode there. When the swapped-in
// entry matches what we run byte for byte (same size, emitted mtimes not newer),
// an id of "entry mtime + size" never moves: `id === startId` forever, and the
// merge gate restarted the daemon by hand ("watcher missed the build"). The id is
// now dist's newest whole-µs mtime over the dir + one level + the entry — a build
// always writes something after the entry (prune manifest, hooks/docs/stubs), so
// even an identical replacement carries a fresh stamp. These drive real files and
// real rename-swaps in a temp dir.
// ---------------------------------------------------------------------------

const roots: string[] = [];
function mkDist(): { root: string; dist: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "pai-distwatch-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(join(dist, "cli"), { recursive: true });
  const entry = join(dist, "cli", "index.mjs");
  writeFileSync(entry, "console.log(1);\n");
  return { root, dist, entry };
}

/** Rename-swap a staging dir over dist, exactly like restoreDistGeneration does. */
function swapDist(root: string, dist: string, entryBytes: string): void {
  const stage = join(root, "dist.new");
  mkdirSync(join(stage, "cli"), { recursive: true });
  writeFileSync(join(stage, "cli", "index.mjs"), entryBytes);
  renameSync(dist, join(root, `dist.old.${process.hrtime.bigint()}`));
  renameSync(stage, dist);
}

/** The build's last write (prune-dist writes its manifest after tsdown emits), at a fixed ms clock. */
function stampBuild(dist: string, atMs: number): void {
  writeFileSync(join(dist, ".prune-manifest.json"), "{}");
  utimesSync(join(dist, ".prune-manifest.json"), new Date(atMs), new Date(atMs));
}

/** The running build's stamp: newer than anything the next rebuild can carry. */
const BASE_MS = 1_800_000_000_000; // fixed clock, so mtimes never collide with "now"

afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the build id of a dist dir", () => {
  it("is undefined while the entry or its dir is missing (mid-build)", () => {
    const { dist, entry } = mkDist();
    rmSync(dist, { recursive: true, force: true });
    expect(distBuildId(entry)).toBeUndefined();
  });

  it("moves when a file the build wrote last is newer than the entry", () => {
    const { dist, entry } = mkDist();
    utimesSync(join(dist, "cli", "index.mjs"), new Date(BASE_MS), new Date(BASE_MS)); // our entry: an older stamp
    const idA = distBuildId(entry)!;
    stampBuild(dist, BASE_MS + 5_000); // prune-dist writes its manifest after tsdown emits the entries
    expect(distBuildId(entry)).not.toBe(idA);
  });

  it("ignores mtimes nested under dist (hooks/skills staging restamps those every build)", () => {
    const { dist, entry } = mkDist();
    const idA = distBuildId(entry)!;
    mkdirSync(join(dist, "hooks"), { recursive: true });
    writeFileSync(join(dist, "hooks", "guard.mjs"), "x"); // fresh mtime inside a top-level dir
    expect(distBuildId(entry)).toBe(idA); // one level only: nested work never re-stamps the build id
  });

  it("the 2026-11-20 miss: a replaced dist with byte-identical entry bytes still moves the id", () => {
    const { root, dist, entry } = mkDist();
    const idA = distBuildId(entry)!;
    utimesSync(entry, new Date(BASE_MS), new Date(BASE_MS)); // our entry: an older stamp than anything the rebuild carries
    const idA2 = distBuildId(entry)!;
    swapDist(root, dist, "console.log(1);\n"); // same bytes, fresh inodes…
    stampBuild(dist, BASE_MS + 5_000); // …and the build's last write lands in the swapped-in dir
    expect(idA2).toBe(idA);
    expect(distBuildId(entry)).not.toBe(idA);
  });

  it("a replacement whose entry keeps the same size but changes content moves the id too", () => {
    const { root, dist, entry } = mkDist();
    const idA = distBuildId(entry)!;
    utimesSync(entry, new Date(), new Date(Date.now() - 60_000)); // the swapped-in entry is no newer than what we run
    swapDist(root, dist, "console.log(2);\n"); // 16 bytes again: an entry size+mtime id would not move
    stampBuild(dist);
    expect(distBuildId(entry)).not.toBe(idA);
  });
});

describe("the watcher across a dist that gets replaced", () => {
  it("fires on a rebuild that rename-swaps dist with byte-identical entry bytes (2026-11-20 22:25)", () => {
    const { root, dist, entry } = mkDist();
    let restarts = 0;
    let t = 0;
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    utimesSync(entry, new Date(), new Date(Date.now() - 60_000)); // our running build carries no newer stamp than what comes next
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle"); // settled on the running build
      t += DIST_STABLE_MS + 1_000;
    }
    swapDist(root, dist, "console.log(1);\n"); // the merge rebuild replaces dist, entry bytes identical
    stampBuild(dist); // the build's last write, after the swap
    expect(tick()).toBe("settling"); // the fresh stamp is seen…
    t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting"); // …and after the debounce the daemon restarts onto it
    expect(restarts).toBe(1);
    for (let i = 0; i < 3; i++) expect(tick()).toBe("restarting"); // one fire per distinct id
  });

  it("stays idle across a replacement that carries no newer stamp than what we run (a rollback)", () => {
    const { root, dist, entry } = mkDist();
    let restarts = 0;
    let t = 0;
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    stampBuild(dist); // our running build carries a fresh stamp…
    utimesSync(join(dist, "cli", "index.mjs"), new Date(), new Date(Date.now() + 60_000)); // …and is newer than what comes next
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle");
      t += DIST_STABLE_MS + 1_000;
    }
    const stage = join(root, "dist.old-gen");
    mkdirSync(join(stage, "cli"), { recursive: true });
    writeFileSync(join(stage, "cli", "index.mjs"), "console.log(0);\n");
    utimesSync(join(stage, "cli", "index.mjs"), new Date(), new Date(Date.now() - 60_000));
    utimesSync(stage, new Date(), new Date(Date.now() - 60_000));
    renameSync(dist, join(root, "dist.current"));
    renameSync(stage, dist); // rolled back to an older generation: nothing newer on disk
    for (let i = 0; i < 4; i++) {
      expect(tick()).toBe("idle");
      t += DIST_STABLE_MS + 1_000;
    }
    expect(restarts).toBe(0);
  });

  it("re-arms after a replacement: a second rebuild fires again", () => {
    const { root, dist, entry } = mkDist();
    let restarts = 0;
    let t = 0;
    const tick = createDistWatch(
      { readId: () => distBuildId(entry), now: () => t, busy: () => false, restart: () => restarts++, log: () => undefined },
      distBuildId(entry)
    );
    utimesSync(entry, new Date(), new Date(Date.now() - 60_000));
    for (let i = 0; i < 3; i++) {
      expect(tick()).toBe("idle");
      t += DIST_STABLE_MS + 1_000;
    }
    swapDist(root, dist, "console.log(1);\n");
    stampBuild(dist);
    for (let i = 0; i < 2; i++) tick(); // settle + fire
    expect(restarts).toBe(1);
    // the new build re-stamps dist again (the next merge): a fresh id fires once more
    utimesSync(join(dist, ".prune-manifest.json"), new Date(), new Date(Date.now() + 120_000));
    expect(tick()).toBe("settling");
    t += DIST_STABLE_MS;
    expect(tick()).toBe("restarting");
    expect(restarts).toBe(2);
  });
});
