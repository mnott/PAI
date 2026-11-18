/**
 * Incremental indexer: list → detect changes → extract → store → resolve.
 *
 * // ponytail: file watcher daemon would replace per-query reconcile; upgrade path
 *
 * File listing uses `git ls-files --cached --others --exclude-standard` when
 * the root is a git repo (tracked + untracked-but-not-ignored), else a plain
 * directory walk. node_modules/dist/build/vendor/.git and files over 1 MB are
 * skipped. Change detection: mtime first, sha256 content hash only when the
 * mtime differs — an unchanged file never re-parses.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CodeGraphStore } from "./store.js";
import { extractFile } from "./extract/index.js";
import { resolveAffected } from "./resolve.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", ".git"]);
const MAX_FILE_BYTES = 1_000_000;

export interface IndexCounts {
  changed: number;
  deleted: number;
}

/** repo-relative files to index. Git listing when available, walk otherwise. */
export function listFiles(root: string): string[] {
  let gitPaths: string[] | null = null;
  if (existsSync(join(root, ".git"))) {
    try {
      const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      gitPaths = out.split("\0").filter(Boolean);
    } catch {
      gitPaths = null; // not a usable git repo — fall back to the walk
    }
  }

  const result: string[] = [];
  if (gitPaths) {
    for (const p of gitPaths) {
      if (skipped(p)) continue;
      const abs = join(root, p);
      let st;
      try { st = statSync(abs); } catch { continue; } // listed but gone
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      result.push(p);
    }
    return result.sort();
  }

  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue; // .git and friends
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        const rel = relative(root, join(dir, e.name)).split(sep).join("/");
        if (skipped(rel)) continue;
        let st;
        try { st = statSync(join(dir, e.name)); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        result.push(rel);
      }
    }
  };
  walk(root);
  return result.sort();
}

/** skip the junk dirs; every other file gets a row (unknown languages: file row only) */
function skipped(relPath: string): boolean {
  return relPath.split("/").some((p) => SKIP_DIRS.has(p));
}

function hashOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Index `root` into the store. Incremental: only files whose mtime differs and
 * whose sha256 then differs are re-extracted; files gone from disk are deleted
 * (their symbols/refs cascade). Resolution runs for every affected ref.
 */
export async function indexRoot(store: CodeGraphStore, root: string, opts: { force?: boolean } = {}): Promise<IndexCounts & { files: number }> {
  const rootAbs = resolve(root);
  const disk = listFiles(rootAbs);
  const stored = await store.listFiles(rootAbs);
  const storedByPath = new Map(stored.map((f) => [f.path, f]));

  const diskSet = new Set(disk);
  const deleted: string[] = [];
  for (const f of stored) if (!diskSet.has(f.path)) deleted.push(f.path);

  let changed = 0;
  const brokenRefIds: number[] = [];
  const changedPaths: string[] = [];

  for (const path of deleted) {
    const res = await store.deleteFiles(rootAbs, [path]);
    brokenRefIds.push(...res.brokenRefIds);
  }

  for (const path of disk) {
    const abs = join(rootAbs, path);
    const st = statSync(abs);
    if (st.size > MAX_FILE_BYTES) continue;
    const prev = storedByPath.get(path);
    if (!opts.force && prev && prev.mtime === Math.round(st.mtimeMs)) continue; // mtime unchanged → skip the read entirely

    const content = readFileSync(abs);
    const hash = hashOf(content);
    if (!opts.force && prev && prev.contentHash === hash) {
      // content identical, mtime only: refresh the stored mtime so next time is cheap.
      // A touch alone must not wipe symbols/refs, so this is an UPDATE, not a re-upsert.
      await store.touchFileMtime(rootAbs, path, Math.round(st.mtimeMs), st.size);
      continue;
    }

    const text = content.toString("utf8");
    const extracted = await extractFile({ path, content: text, mtime: Math.round(st.mtimeMs), size: st.size });
    if (!extracted) {
      // unknown language: file row only
      await store.upsertFile(rootAbs, {
        path, language: "unknown", contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size,
        symbols: [], refs: [],
      });
      changed++;
      continue;
    }
    const res = await store.upsertFile(rootAbs, {
      path, language: extracted.language, contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size,
      symbols: extracted.symbols, refs: extracted.refs,
    });
    brokenRefIds.push(...res.brokenRefIds);
    changedPaths.push(path);
    changed++;
  }

  await resolveAffected(store, rootAbs, changedPaths, brokenRefIds);
  return { changed, deleted: deleted.length, files: disk.length };
}

/**
 * Cheap reconcile for ensureFresh(): mtime → hash only for files whose mtime
 * moved; deletions are picked up from the git listing. Returns null when
 * nothing changed (the common case).
 *
 * // ponytail: file watcher daemon would replace per-query reconcile; upgrade path
 */
export async function reconcile(store: CodeGraphStore, root: string): Promise<IndexCounts | null> {
  const rootAbs = resolve(root);
  const disk = listFiles(rootAbs);
  const stored = await store.listFiles(rootAbs);
  const storedByPath = new Map(stored.map((f) => [f.path, f]));
  const diskSet = new Set(disk);

  let touched = false;
  const deleted: string[] = [];
  for (const f of stored) if (!diskSet.has(f.path)) { deleted.push(f.path); touched = true; }

  const changedPaths: string[] = [];
  const brokenRefIds: number[] = [];
  for (const path of deleted) brokenRefIds.push(...(await store.deleteFiles(rootAbs, [path])).brokenRefIds);

  let changed = 0;
  for (const path of disk) {
    const prev = storedByPath.get(path);
    if (!prev) { touched = true; continue; } // new file → full index needed
    const abs = join(rootAbs, path);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (prev.mtime === Math.round(st.mtimeMs)) continue; // mtime first — the cheap gate
    const hash = hashOf(readFileSync(abs));
    if (hash === prev.contentHash) {
      // mtime-only change: refresh the stored mtime, keep symbols/refs
      await store.touchFileMtime(rootAbs, path, Math.round(st.mtimeMs), st.size);
      continue;
    }
    touched = true;
    changed++;
    changedPaths.push(path);
    const text = readFileSync(abs).toString("utf8");
    const extracted = await extractFile({ path, content: text, mtime: Math.round(st.mtimeMs), size: st.size });
    if (!extracted) {
      await store.upsertFile(rootAbs, { path, language: "unknown", contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size, symbols: [], refs: [] });
      continue;
    }
    brokenRefIds.push(...(await store.upsertFile(rootAbs, {
      path, language: extracted.language, contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size,
      symbols: extracted.symbols, refs: extracted.refs,
    })).brokenRefIds);
  }

  if (!touched) return null;
  await resolveAffected(store, rootAbs, changedPaths, brokenRefIds);
  return { changed, deleted: deleted.length };
}
