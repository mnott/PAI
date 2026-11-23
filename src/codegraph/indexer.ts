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
import { looksBinary } from "./sanitize.js";
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

/** Extract symbols unless the file looks binary (NUL in the first 8 KB): those are indexed as a file row only. */
function extractSource(buf: Buffer, input: Parameters<typeof extractFile>[0]): ReturnType<typeof extractFile> {
  return looksBinary(buf) ? Promise.resolve(null) : extractFile(input);
}

/**
 * Index `root` into the store. Incremental: only files whose mtime differs and
 * whose sha256 then differs are re-extracted; files gone from disk are deleted
 * (their symbols/refs cascade). Resolution runs for every affected ref.
 *
 * `readFrom` reads and lists the tree from a different checkout than the rows'
 * key — a worker worktree indexes its own files into the parent repo's rows.
 */
export async function indexRoot(store: CodeGraphStore, root: string, opts: { force?: boolean } = {}, readFrom?: string): Promise<IndexCounts & { files: number }> {
  const rootAbs = resolve(root);
  const tree = readFrom ? resolve(readFrom) : rootAbs;
  const disk = listFiles(tree);
  const stored = await store.listFiles(rootAbs);
  const storedByPath = new Map(stored.map((f) => [f.path, f]));

  const diskSet = new Set(disk);
  const deleted: string[] = [];
  for (const f of stored) if (!diskSet.has(f.path)) deleted.push(f.path);

  let changed = 0;
  const brokenRefIds: number[] = [];
  const changedPaths: string[] = [];

  // --force re-reads every file anyway, so drop the repo's rows up front in
  // one set-based transaction instead of paying a per-file cascade inside
  // each upsert (the 11-minute forced reindex, 2026-11-18). This also covers
  // the deleted files — their refs are gone with the wipe, nothing to report.
  if (opts.force) {
    await store.clearRepo(rootAbs);
  } else if (deleted.length > 0) {
    // one batched delete, not one per file: on a large wipe the per-file path
    // is N cascade round-trips (see store-postgres deleteFiles)
    brokenRefIds.push(...(await store.deleteFiles(rootAbs, deleted)).brokenRefIds);
  }

  for (const path of disk) {
    const abs = join(tree, path);
    let st;
    try { st = statSync(abs); } catch { continue; } // listed but gone
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
    const extracted = await extractSource(content, { path, content: text, mtime: Math.round(st.mtimeMs), size: st.size });
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
 * nothing changed (the common case). `readFrom` reconciles against a different
 * checkout than the rows' key — a worker worktree against the parent repo's rows.
 *
 * // ponytail: file watcher daemon would replace per-query reconcile; upgrade path
 */
export async function reconcile(store: CodeGraphStore, root: string, readFrom?: string): Promise<IndexCounts | null> {
  const rootAbs = resolve(root);
  const tree = readFrom ? resolve(readFrom) : rootAbs;
  const disk = listFiles(tree);
  const stored = await store.listFiles(rootAbs);
  const storedByPath = new Map(stored.map((f) => [f.path, f]));
  const diskSet = new Set(disk);

  let touched = false;
  // a second checkout (a worker worktree over the parent's rows) never deletes:
  // files it does not carry are the main checkout's own. Deletions are reconciled
  // when querying the main tree, and indexRepo --force wipes+rebuilds anyway.
  const deleted: string[] = [];
  if (tree === rootAbs) for (const f of stored) if (!diskSet.has(f.path)) { deleted.push(f.path); touched = true; }

  const changedPaths: string[] = [];
  const brokenRefIds: number[] = [];
  if (deleted.length > 0) brokenRefIds.push(...(await store.deleteFiles(rootAbs, deleted)).brokenRefIds);

  let changed = 0;
  for (const path of disk) {
    const prev = storedByPath.get(path);
    if (!prev) { touched = true; continue; } // new file → full index needed
    const abs = join(tree, path);
    let st;
    try { st = statSync(abs); } catch { continue; }
    // mtime first — the cheap gate. Across two checkouts (a worker worktree over
    // the parent's rows) an equal mtime says nothing: a committed file keeps its
    // author's timestamp, so content must be hashed before it is skipped.
    if (prev.mtime === Math.round(st.mtimeMs) && tree === rootAbs) continue;
    const hash = hashOf(readFileSync(abs));
    if (hash === prev.contentHash) {
      // mtime-only change: refresh the stored mtime, keep symbols/refs
      await store.touchFileMtime(rootAbs, path, Math.round(st.mtimeMs), st.size);
      continue;
    }
    touched = true;
    changed++;
    changedPaths.push(path);
    const content = readFileSync(abs);
    const text = content.toString("utf8");
    const extracted = await extractSource(content, { path, content: text, mtime: Math.round(st.mtimeMs), size: st.size });
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

/**
 * Index exactly these repo-relative files (the dirty list, merged files): new and
 * changed ones are extracted, vanished ones deleted. No directory listing.
 */
/** `readFrom` reads the files from a different checkout than the rows' key (worktree freshness). */
export async function indexFiles(store: CodeGraphStore, root: string, paths: string[], readFrom?: string): Promise<IndexCounts> {
  const rootAbs = resolve(root);
  const tree = readFrom ? resolve(readFrom) : rootAbs;
  const stored = new Map((await store.listFiles(rootAbs)).map((f) => [f.path, f]));
  const brokenRefIds: number[] = [];
  const changedPaths: string[] = [];
  const vanished: string[] = [];
  let changed = 0;
  for (const path of [...new Set(paths)]) {
    if (skipped(path)) continue;
    const abs = join(tree, path);
    let st;
    try { st = statSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) {
      if (stored.has(path)) vanished.push(path);
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    const prev = stored.get(path);
    // same two-checkout rule as reconcile: across trees an equal mtime proves nothing
    if (prev && prev.mtime === Math.round(st.mtimeMs) && tree === rootAbs) continue;
    const content = readFileSync(abs);
    const hash = hashOf(content);
    if (prev && prev.contentHash === hash) { await store.touchFileMtime(rootAbs, path, Math.round(st.mtimeMs), st.size); continue; }
    const extracted = await extractSource(content, { path, content: content.toString("utf8"), mtime: Math.round(st.mtimeMs), size: st.size });
    const res = await store.upsertFile(rootAbs, extracted
      ? { path, language: extracted.language, contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size, symbols: extracted.symbols, refs: extracted.refs }
      : { path, language: "unknown", contentHash: hash, mtime: Math.round(st.mtimeMs), size: st.size, symbols: [], refs: [] });
    brokenRefIds.push(...res.brokenRefIds);
    if (extracted) changedPaths.push(path);
    changed++;
  }
  let deleted = 0;
  if (vanished.length > 0) {
    brokenRefIds.push(...(await store.deleteFiles(rootAbs, vanished)).brokenRefIds);
    deleted = vanished.length;
  }
  if (changed || deleted) await resolveAffected(store, rootAbs, changedPaths, brokenRefIds);
  return { changed, deleted };
}
