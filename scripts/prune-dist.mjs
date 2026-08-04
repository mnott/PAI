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
 * Deliberately conservative in both directions:
 *   - only files directly in dist/ are considered, never subdirectories;
 *   - only bundle extensions, so nothing hand-placed is at risk;
 *   - if an entry point is missing, it prunes NOTHING and says so. A partial
 *     graph would look exactly like "most chunks are unreachable", and acting
 *     on it would delete a working build.
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist");

/** The same entry list as tsdown.config.ts, as built output paths. */
const ENTRIES = [
  "index.mjs",
  "cli/index.mjs",
  "cli/program.mjs",
  "daemon/index.mjs",
  "daemon-mcp/index.mjs",
].map((p) => join(DIST, p));

/** Extensions this script is allowed to delete. */
const PRUNABLE = [".mjs", ".mjs.map", ".d.mts", ".d.mts.map"];

/** Every relative specifier in a built module, resolved to an absolute path. */
function importsOf(file) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  // `from "./x.mjs"`, `import "./x.mjs"`, and dynamic `import("./x.mjs")`.
  const re = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(resolve(dirname(file), m[1]));
  }
  return out;
}

const reachable = new Set();
const missingEntries = [];

for (const entry of ENTRIES) {
  if (!existsSync(entry)) {
    missingEntries.push(relative(DIST, entry));
    continue;
  }
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const dep of importsOf(f)) {
      if (!reachable.has(dep) && existsSync(dep)) stack.push(dep);
    }
  }
}

if (missingEntries.length > 0) {
  // A partial graph is indistinguishable from "almost everything is dead".
  console.error(
    `prune-dist: entry point(s) missing (${missingEntries.join(", ")}) — pruning nothing.`
  );
  process.exit(0);
}

let removed = 0;
let freed = 0;
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

  try {
    unlinkSync(p);
    removed += 1;
    freed += st.size;
  } catch {
    /* leave it; a file we cannot remove is not worth failing a build over */
  }
}

console.log(
  removed > 0
    ? `✔ Pruned ${removed} unreferenced bundle file(s) from dist/ (${(freed / 1e6).toFixed(1)} MB), ${reachable.size} reachable.`
    : `✔ dist/ has no unreferenced bundle files (${reachable.size} reachable).`
);
