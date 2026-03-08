/**
 * Session checkpoint command — appends a timestamped block to the active
 * session note. Designed for use in hooks; fast, silent, rate-limited.
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

function findNotesDirForCwd(): string | null {
  const cwd = process.cwd();
  const claudeProjectsDir = join(homedir(), ".claude", "projects");

  if (!existsSync(claudeProjectsDir)) return null;

  const expectedEncoded = cwd.replace(/[/\s.\-]/g, "-");
  let encodedDir: string | null = null;

  try {
    const entries = readdirSync(claudeProjectsDir);

    if (entries.includes(expectedEncoded)) {
      encodedDir = expectedEncoded;
    } else {
      for (const entry of entries) {
        const full = join(claudeProjectsDir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        const candidate = entry.replace(/-+$/, "");
        const expected = expectedEncoded.replace(/-+$/, "");
        if (candidate === expected) {
          encodedDir = entry;
          break;
        }
      }
    }
  } catch {
    return null;
  }

  if (!encodedDir) return null;
  const notesDir = join(claudeProjectsDir, encodedDir, "Notes");
  return existsSync(notesDir) ? notesDir : null;
}

function findLatestNoteFile(notesDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(notesDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((e) => e.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  let latestPath: string | null = null;
  let latestMtime = 0;

  for (const file of mdFiles) {
    const full = join(notesDir, file);
    try {
      const { mtimeMs } = statSync(full);
      if (mtimeMs > latestMtime) {
        latestMtime = mtimeMs;
        latestPath = full;
      }
    } catch {
      // skip unreadable files
    }
  }

  return latestPath;
}

function checkpointTooRecent(notesDir: string, minGapSeconds: number): boolean {
  const safeKey = notesDir.replace(/[^a-zA-Z0-9]/g, "-").slice(-80);
  const tmpFile = join(tmpdir(), `pai-checkpoint-${safeKey}`);
  if (!existsSync(tmpFile)) return false;
  try {
    const { mtimeMs } = statSync(tmpFile);
    return Date.now() - mtimeMs < minGapSeconds * 1000;
  } catch {
    return false;
  }
}

function touchCheckpointSentinel(notesDir: string): void {
  const safeKey = notesDir.replace(/[^a-zA-Z0-9]/g, "-").slice(-80);
  const tmpFile = join(tmpdir(), `pai-checkpoint-${safeKey}`);
  try {
    writeFileSync(tmpFile, String(Date.now()), "utf8");
  } catch {
    // Non-fatal — rate limiting is best-effort
  }
}

export function cmdCheckpoint(
  message: string,
  opts: { minGap?: string }
): void {
  const minGapSeconds = parseInt(opts.minGap ?? "300", 10);

  const notesDir = findNotesDirForCwd();
  if (!notesDir) process.exit(0);

  if (checkpointTooRecent(notesDir, minGapSeconds)) process.exit(0);

  const notePath = findLatestNoteFile(notesDir);
  if (!notePath) process.exit(0);

  const timestamp = new Date().toISOString();
  const block = `\n## Checkpoint — ${timestamp}\n${message}\n`;

  const tmpPath = `${notePath}.checkpoint.tmp`;
  try {
    const existing = readFileSync(notePath, "utf8");
    writeFileSync(tmpPath, existing + block, "utf8");
    renameSync(tmpPath, notePath);
  } catch {
    try {
      if (existsSync(tmpPath)) renameSync(tmpPath, tmpPath + ".dead");
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  touchCheckpointSentinel(notesDir);
  process.exit(0);
}
