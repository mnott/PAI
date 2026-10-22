#!/usr/bin/env node
/**
 * prune-dist.mjs — collect bundle chunks nothing imports any more.
 *
 * tsdown emits CONTENT-HASHED chunks (`router-i9S19Usg.mjs`) and never removes
 * the ones a rebuild supersedes, so dist/ only grows. Measured 2026-08-04: 207
 * chunks where a clean build produces 42. `prepublishOnly` builds into that same
 * directory, so npm packs the dead ones too — @tekmidian/pai 0.28.0 shipped 591
 * files, including a stale copy of the WhatsApp notification provider that had
 * just been fixed.
 *
 * That is not only weight. Which code actually RUNS depends on which chunk the
 * entry graph reaches, so a superseded chunk is a live hazard: the notification
 * repair appeared not to work until dist/ was wiped, because the CLI was still
 * reaching the old router chunk.
 *
 * WHY NOT `clean: true`
 * --------------------
 * See the comment in tsdown.config.ts, and do not "simplify" this away.
 * dist/hooks/*.mjs are executed by every LIVE Claude Code session on every tool
 * call, through symlinks in ~/.claude/Hooks/. Emptying dist/ deletes them for
 * the second or so a rebuild takes, and every hook firing in that window dies
 * with ENOENT — in other people's sessions, not just this one. A single clean
 * build produced 318 such failures across a 5-file sample.
 *
 * So this collects by REACHABILITY instead of by wiping: walk the import graph
 * from the declared entry points, then delete only the top-level bundle files
 * nothing in that graph names. dist/hooks/ and dist/skills/ are never touched —
 * they are not part of this graph and are rewritten by their own build steps.
 *
 * LIVE ROUTER: chunks reachable from the previous build's entries are kept for one more build (manifest below);
 * older generations are deleted. Source maps are pruned with their module; they are excluded from the npm package.
 *
 * Deliberately conservative in both directions:
 *   - only files directly in dist/ are considered, never subdirectories;
 *   - only bundle extensions, so nothing hand-placed is at risk;
 *   - if an entry point is missing, it prunes NOTHING and says so. A partial
 *     graph would look exactly like "most chunks are unreachable", and acting
 *     on it would delete a working build.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { reachableFrom } from "./lib/dist-reachable.mjs";

const DIST = resolve(process.argv[2] ?? "dist");

/** The same entry list as tsdown.config.ts, as built output paths. */
const ENTRIES = [
  "index.mjs",
  "cli/index.mjs",
  "daemon/index.mjs",
  "daemon-mcp/index.mjs",
].map((p) => join(DIST, p));

/**
 * An unreferenced chunk is kept until it is this old. A long-running process (a `pai worker run` that outlives a
 * rebuild) lazily imports chunks of the build it started from; deleting them immediately made it die with
 * ERR_MODULE_NOT_FOUND. Rebuilding rewrites referenced chunks, so mtime is when a build last wrote the file.
 */
const MAX_AGE_MS = Number(process.env.PRUNE_DIST_MAX_AGE_MS ?? 24 * 3600_000);

/** Extensions this script is allowed to delete. */
const PRUNABLE = [".mjs", ".mjs.map", ".d.mts", ".d.mts.map"];

const missingEntries = ENTRIES.filter((e) => !existsSync(e)).map((e) => relative(DIST, e));
const reachable = reachableFrom(ENTRIES);

/**
 * Generation manifest: basenames reachable from the current and the previous build. A chunk survives while it is in
 * either, so a running process (started from the previous build) keeps its lazy imports, and anything older goes —
 * regardless of mtime, because with frequent builds every stale chunk is younger than MAX_AGE_MS and the age rule alone
 * never deletes anything (measured: 4219 files / 436 MB). Without a manifest (first run) the age rule applies.
 */
const MANIFEST = join(DIST, ".prune-manifest.json");
const names = (set) => [...set].map((p) => relative(DIST, p)).sort();
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {
  /* none yet */
}
if (missingEntries.length > 0) {
  // A partial graph is indistinguishable from "almost everything is dead".
  console.error(
    `prune-dist: entry point(s) missing (${missingEntries.join(", ")}) — pruning nothing.`
  );
  process.exit(0);
}

const current = names(reachable);
// Entries are rewritten by every build, so their mtimes identify the build; re-running prune on one build must not rotate.
const stamp = ENTRIES.map((e) => statSync(e).mtimeMs).join(",");
const sameBuild = manifest && manifest.stamp === stamp;
const previous = manifest ? (sameBuild ? manifest.previous : manifest.current) : null;
const keep = new Set([...current, ...(previous ?? [])]);

let removed = 0;
let freed = 0;
let kept = 0;
for (const name of readdirSync(DIST)) {
  const p = join(DIST, name);
  let st;
  try {
    st = statSync(p);
  } catch {
    continue;
  }
  if (!st.isFile()) continue; // never recurse: dist/hooks, dist/skills are off-limits
  if (!PRUNABLE.some((ext) => name.endsWith(ext))) continue;

  // A sourcemap or declaration lives or dies with the module it belongs to.
  const owner = p.replace(/\.map$/, "").replace(/\.d\.mts$/, ".mjs");
  if (reachable.has(p) || reachable.has(owner)) continue;
  if (previous && keep.has(name.replace(/\.map$/, "").replace(/\.d\.mts$/, ".mjs"))) continue;

  if (!previous && Date.now() - st.mtimeMs < MAX_AGE_MS) {
    kept += 1;
    continue;
  }

  try {
    unlinkSync(p);
    removed += 1;
    freed += st.size;
  } catch {
    /* leave it; a file we cannot remove is not worth failing a build over */
  }
}

writeFileSync(MANIFEST, JSON.stringify({ stamp, current: sameBuild ? manifest.current : current, previous: previous ?? [] }));

console.log(
  removed > 0
    ? `✔ Pruned ${removed} unreferenced bundle file(s) from dist/ (${(freed / 1e6).toFixed(1)} MB), ${reachable.size} reachable, ${kept} recent kept.`
    : `✔ dist/ has no stale unreferenced bundle files (${reachable.size} reachable, ${kept} recent kept).`
);
