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
 * LIVE PROCESS GRACE
 * ------------------
 * A PAI MCP server (`dist/daemon-mcp/index.mjs`) is started per Claude Code
 * session and lives for HOURS, lazily importing hashed chunks as it goes.
 * Keeping only the previous generation (the old rule) killed it after two
 * rebuilds: "Cannot find module 'dist/aibroker-client-<hash>.mjs'". So the
 * manifest records every generation (build time + chunk list, bounded history)
 * and prune keeps the chunks of every generation built at or after the one that
 * was current when the OLDEST live process touching this dist/ started — found
 * via `ps` (start time of any process whose command line names this dist dir).
 * The same repo can be reachable under two different paths (two directory
 * entries for one directory), and the long-running MCP servers may have been
 * started from the other one, so a process counts as live when any "/dist/"
 * token in its command line stats to the same device+inode as this dist dir —
 * the string match alone would miss them.
 * No live process → current + previous, as before. `ps` fails → prune NOTHING.
 * PRUNE_DIST_DEBUG=1 prints each matched live process command.
 *
 * Deliberately conservative in both directions:
 *   - only files directly in dist/ are considered, never subdirectories;
 *   - only bundle extensions, so nothing hand-placed is at risk;
 *   - if an entry point is missing, it prunes NOTHING and says so. A partial
 *     graph would look exactly like "most chunks are unreachable", and acting
 *     on it would delete a working build.
 */

import { readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reachableFrom } from "./lib/dist-reachable.mjs";

/**
 * Without a generation manifest (first run) an unreferenced chunk is kept until it is this old.
 * With a manifest the generation rules below decide instead — mtime is unreliable because every
 * build rewrites referenced chunks and frequent builds keep stale chunks younger than any age cap.
 */
const MAX_AGE_MS = Number(process.env.PRUNE_DIST_MAX_AGE_MS ?? 24 * 3600_000);

/** Manifest history is bounded; a process older than the whole window is past its grace anyway. */
const MAX_GENERATIONS = 30;

/** Extensions this script is allowed to delete. */
const PRUNABLE = [".mjs", ".mjs.map", ".d.mts", ".d.mts.map"];

/**
 * `lstart` is the absolute start time in a fixed-width weekday/month format
 * ("Fri Oct 23 16:45:33 2026") — exactly 5 fields, then the command. The names are
 * LOCALE-DEPENDENT: under a German locale ps prints "Mi. 21 Okt. 16:22:01 2026", which
 * Date.parse rejects — so ps is always run with LC_ALL/LANG=C (see oldestLiveStartMs).
 * `etimes` (seconds since start) is GNU-only — BSD/macOS ps rejects it — and is tried as a fallback.
 * Returns [{ startedAt, command }].
 */
export function parsePsOutput(out, nowMs) {
  const procs = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // lstart: 5 date fields then the command (keep the whitespace after the date).
    const lstart = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*)$/);
    if (lstart) {
      const startedAt = Date.parse(lstart[1]);
      if (!Number.isNaN(startedAt)) {
        procs.push({ startedAt, command: lstart[2] });
        continue;
      }
    }
    // etimes fallback: "<seconds> <command>".
    const etimes = line.match(/^(\d+)\s+(\S.*)$/);
    if (etimes) procs.push({ startedAt: nowMs - Number(etimes[1]) * 1000, command: etimes[2] });
  }
  return procs;
}

/**
 * Every absolute path token in `command` that contains a "/dist/" segment, each cut at that segment
 * so it names the dist DIR rather than a file inside it. Tokens are whitespace-separated; a path
 * with spaces in it is not recoverable from `ps` output anyway.
 */
export function distDirTokens(command) {
  const dirs = new Set();
  for (const token of command.split(/\s+/)) {
    if (!token.startsWith("/")) continue;
    const idx = token.indexOf("/dist/");
    if (idx === -1) continue;
    dirs.add(token.slice(0, idx + "/dist".length));
  }
  return [...dirs];
}

/**
 * Oldest start time (ms) among processes whose command line references `distDir`, or null when none.
 * `{ error }` when the process list cannot be obtained — callers must then prune nothing.
 * The same repo can be reachable under two different paths (two directory entries for one
 * directory), and long-running MCP servers may have been started from the other one — a plain
 * string match would then miss them and rotate generations they still need. So a process counts as
 * live when any "/dist/" token in its command line stats to the SAME device+inode as `distDir`
 * (the string match is kept only as a fast path). `stat` injects the stat implementation (tests).
 * `exec` injects the ps runner (tests). ps runs with LC_ALL/LANG=C so `lstart` prints English
 * weekday/month names — under e.g. a German locale Date.parse rejects "Mi. 21 Okt. …" and every
 * line parses to nothing, which must be treated as a ps failure, not as "no live process"
 * (that is how 9 chunks live processes still needed got deleted).
 * PRUNE_DIST_PROCESSES injects the list as JSON (tests); never point it at the real dist.
 * PRUNE_DIST_DEBUG=1 prints each matched command.
 */
export function oldestLiveStartMs(distDir, { nowMs = Date.now(), stat = statSync, exec = execFileSync } = {}) {
  let procs;
  try {
    if (process.env.PRUNE_DIST_PROCESSES !== undefined) {
      procs = JSON.parse(process.env.PRUNE_DIST_PROCESSES);
    } else {
      const out = exec("ps", ["-eo", "lstart=,command="], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
      procs = parsePsOutput(out, nowMs);
      // Non-empty ps output that parsed to (almost) nothing means the format changed on us
      // (a locale we did not force away, a ps we misread) — treat it like a ps failure so we
      // prune nothing rather than conclude "no live process" and delete live generations.
      const lines = out.split("\n").filter((l) => l.trim());
      const distLines = lines.filter((l) => l.includes("/dist/")).length;
      if (lines.length > 0 && (procs.length === 0 || procs.length < distLines / 2)) {
        return { error: "process list unavailable" };
      }
    }
  } catch {
    return { error: "process list unavailable" };
  }
  if (!Array.isArray(procs)) return { error: "process list unavailable" };
  const needle = resolve(distDir);
  const debug = process.env.PRUNE_DIST_DEBUG === "1";
  let thisDir;
  try {
    thisDir = stat(needle);
  } catch {
    thisDir = null;
  }
  let oldest = null;
  for (const p of procs) {
    let uses = p.command.includes(needle); // fast path: the exact path appears verbatim
    if (!uses && thisDir) {
      for (const token of distDirTokens(p.command)) {
        let st;
        try {
          st = stat(token);
        } catch {
          continue; // a path we cannot stat is not this dist
        }
        if (st.dev === thisDir.dev && st.ino === thisDir.ino) {
          uses = true;
          break;
        }
      }
    }
    if (!uses) continue;
    if (debug) console.log(`prune-dist: live process (started ${new Date(p.startedAt).toISOString()}): ${p.command}`);
    if (oldest === null || p.startedAt < oldest) oldest = p.startedAt;
  }
  return { oldest };
}

/**
 * Prune `distDir` (absolute or relative to cwd). Exports for tests; the CLI runs it at the bottom.
 * Generation manifest: `{ stamp, generations: [{ builtAt, chunks }] }`, newest first, bounded to
 * MAX_GENERATIONS. A chunk survives while it belongs to a generation still needed by a live
 * process (see LIVE PROCESS GRACE above); without a manifest (first run) the age rule applies.
 * `stat` injects the stat implementation (tests); defaults to statSync.
 */
export function pruneDist(distDir, { stat = statSync } = {}) {
  const DIST = resolve(distDir);
  /** The same entry list as tsdown.config.ts, as built output paths. */
  const ENTRIES = [
    "index.mjs",
    "cli/index.mjs",
    "daemon/index.mjs",
    "daemon-mcp/index.mjs",
  ].map((p) => join(DIST, p));
  const MANIFEST = join(DIST, ".prune-manifest.json");
  const names = (set) => [...set].map((p) => relative(DIST, p)).sort();

  const missingEntries = ENTRIES.filter((e) => !existsSync(e)).map((e) => relative(DIST, e));
  if (missingEntries.length > 0) {
    // A partial graph is indistinguishable from "almost everything is dead".
    console.error(
      `prune-dist: entry point(s) missing (${missingEntries.join(", ")}) — pruning nothing.`
    );
    return;
  }
  const reachable = reachableFrom(ENTRIES);

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    /* none yet */
  }

  const current = names(reachable);
  // Entries are rewritten by every build, so their mtimes identify the build; re-running prune on one build must not rotate.
  const stamp = ENTRIES.map((e) => statSync(e).mtimeMs).join(",");
  const sameBuild = manifest && manifest.stamp === stamp;
  const history = sameBuild ? manifest.generations ?? [] : [...(manifest?.generations ?? [])];

  const { oldest, error } = oldestLiveStartMs(DIST, { stat });
  if (error) {
    console.error(`prune-dist: cannot list processes (${error}) — pruning nothing this run.`);
    return;
  }

  // Generations to keep: the newest one built at or before the oldest live process's start, and every
  // generation newer than it (that process may have lazy imports from any build since it started).
  // Without a live process: current + previous only, as before.
  const keepGenerations = new Set();
  if (oldest !== null) {
    const anchor = history.filter((g) => g.builtAt <= oldest)[0]; // newest-first, so [0] is the newest match
    for (const g of history) {
      if (g === anchor || g.builtAt > oldest) for (const c of g.chunks) keepGenerations.add(c);
    }
  } else {
    for (const g of history.slice(0, 1)) for (const c of g.chunks) keepGenerations.add(c);
  }

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
    if (keepGenerations.has(relative(DIST, owner))) continue;

    if (history.length === 0 && Date.now() - st.mtimeMs < MAX_AGE_MS) {
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

  const generations = [{ builtAt: Date.now(), chunks: current }, ...history].slice(0, MAX_GENERATIONS);
  writeFileSync(MANIFEST, JSON.stringify({ stamp, generations }));

  console.log(
    removed > 0
      ? `✔ Pruned ${removed} unreferenced bundle file(s) from dist/ (${(freed / 1e6).toFixed(1)} MB), ${reachable.size} reachable, ${kept} recent kept.`
      : `✔ dist/ has no stale unreferenced bundle files (${reachable.size} reachable, ${kept} recent kept).`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  pruneDist(process.argv[2] ?? "dist");
}
