/**
 * Persisted mtime index for the registry scan.
 *
 * A scan used to walk every ~/.claude/projects entry (thousands, mostly
 * worker worktrees) and re-upsert every project on every run. The index
 * remembers, per entry, the directory mtime and a Notes/ signature from the
 * last time it was fully processed; an entry whose signature is unchanged is
 * skipped without decoding its path or touching the registry.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodeDir } from "../../lib/utils.js";
import { paiHomePath } from "../../../config/pai-home.js";

export interface ScanIndexEntry {
  /** Project dir mtime (ms) when last processed. */
  m: number;
  /** Notes signature when last processed (see notesSignature). */
  n: string;
  /** Registered root path, so a skip can confirm the registry row still exists. */
  root: string;
}

export interface ScanIndex {
  version: 1;
  /** Keyed by encoded dir. */
  projects: Record<string, ScanIndexEntry>;
  /** Project-root Notes/ signatures, keyed by root path. */
  notes: Record<string, string>;
}

export function scanIndexPath(): string {
  return paiHomePath("registry-scan-index.json");
}

export function emptyScanIndex(): ScanIndex {
  return { version: 1, projects: {}, notes: {} };
}

export function loadScanIndex(file = scanIndexPath()): ScanIndex {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ScanIndex;
    if (parsed.version === 1 && parsed.projects && parsed.notes) return parsed;
  } catch {
    // missing or corrupt: start over, the next scan rebuilds it
  }
  return emptyScanIndex();
}

export function saveScanIndex(index: ScanIndex, file = scanIndexPath()): void {
  try {
    mkdirSync(paiHomePath(), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(index), "utf8");
    renameSync(tmp, file);
  } catch {
    // Non-fatal: without an index the next scan is just a full one.
  }
}

export function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Cheap change signature of a Notes tree: mtimes of the dir and its
 * YYYY/MM subdirs (adding a note changes its parent dir's mtime).
 * Empty string when there is no Notes dir.
 */
export function notesSignature(dir: string): string {
  if (!existsSync(dir)) return "";
  const parts: string[] = [String(mtimeOf(dir))];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\d{4}$/.test(e.name)) continue;
      const year = join(dir, e.name);
      parts.push(`${e.name}:${mtimeOf(year)}`);
      for (const mo of readdirSync(year, { withFileTypes: true })) {
        if (mo.isDirectory() && /^\d{2}$/.test(mo.name)) {
          parts.push(`${e.name}/${mo.name}:${mtimeOf(join(year, mo.name))}`);
        }
      }
    }
  } catch {
    // unreadable subtree: signature of what was readable
  }
  return parts.join("|");
}

/**
 * Encoded-dir spellings of the path fragments `unregistrableReason` refuses
 * (agent worktrees, worker logs/worktrees, temp dirs). Claude encodes `/`, `.`,
 * space and `-` all as `-`, so these are matched on the name alone, with no
 * disk access.
 */
const ENCODED_EPHEMERAL = ["-claude-worktrees-", "-logs-workers-", "-private-tmp-", "-var-folders-"];

/** Reason an encoded project dir name can never be a project, decided from the name only. */
export function encodedDirRefusedReason(encoded: string, worktreesRoot?: string): string | undefined {
  const padded = encoded.endsWith("-") ? encoded : `${encoded}-`;
  for (const f of ENCODED_EPHEMERAL) if (padded.includes(f)) return "a worker, agent-worktree or temp path";
  if (padded.startsWith("-tmp-")) return "a system temp directory";
  if (worktreesRoot) {
    const enc = encodeDir(worktreesRoot);
    if (encoded === enc || encoded.startsWith(`${enc}-`)) return "a worker worktree";
  }
  return undefined;
}

/** Let timers, sockets and IPC run between batches of synchronous scan work. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
