/**
 * moved.ts — reconnect a project to transcripts that moved out from under it.
 *
 * The registry records an `encoded_dir`: the name Claude Code gave the folder
 * holding a project's transcripts. It is written once, when the project is
 * added, and nothing updates it when the project moves. So a project that has
 * been relocated points at a directory that is empty or gone, and every lookup
 * — checkpoints, handovers, session digests — quietly returns nothing.
 *
 * `resolveTranscriptDir` already re-derives the name from the project's current
 * root path, which fixes the case where the encoding is stale but the path is
 * right. It cannot fix the case where the ENCODING RULE itself does not
 * reproduce the folder name: iCloud paths with `~` in them, emoji segments, or
 * a folder Claude Code created under a path the project no longer has.
 *
 * This module answers that case by asking the transcripts instead of guessing.
 * Every transcript entry records the `cwd` it was written in, so the mapping
 * from a project root to its transcript folder is a fact sitting on disk rather
 * than something to be inferred from a naming convention. Reading it is slower
 * than a string transform and it is right, which is the correct trade for a
 * repair that runs on demand.
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Where Claude Code keeps per-project transcript folders. */
export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Every transcript file for one project folder — live and archived.
 *
 * The archived half matters: `session-stop` moves all but the newest transcript
 * into `sessions/`, so a folder whose work is finished has an empty top level
 * and everything underneath. Counting only the top level reports a busy project
 * as unused, which is how an earlier audit of this same problem overstated the
 * breakage by a factor of three.
 */
export function transcriptFiles(projectDir: string): string[] {
  const out: string[] = [];
  for (const dir of [projectDir, join(projectDir, "sessions")]) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".jsonl")) out.push(join(dir, entry));
      }
    } catch {
      /* unreadable — treat as empty rather than failing the scan */
    }
  }
  return out;
}

/**
 * The working directory a transcript was recorded in.
 *
 * Reads only the head of the file. `cwd` is present on the first entry and does
 * not change within a session, so scanning further would cost time to learn
 * nothing. Returns null rather than throwing: a truncated or half-written
 * transcript is normal for a session that is still running.
 */
export function cwdOfTranscript(file: string, maxBytes = 64 * 1024): string | null {
  let head: string;
  try {
    const buf = readFileSync(file);
    head = buf.subarray(0, maxBytes).toString("utf-8");
  } catch {
    return null;
  }

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: string }).cwd;
      if (cwd) return cwd;
    } catch {
      // A partial final line is expected when the head is cut mid-entry.
      continue;
    }
  }
  return null;
}

export interface TranscriptFolder {
  /** Folder name under ~/.claude/projects. */
  name: string;
  /** Number of transcripts, live plus archived. */
  count: number;
  /** Newest transcript mtime, for choosing between candidates. */
  newest: number;
  /**
   * How many sampled transcripts in this folder began in the cwd being looked
   * up, and how many began somewhere else.
   *
   * One folder routinely holds transcripts for more than one directory: a
   * session started in a subdirectory can land in the parent's folder. So a
   * project appearing in a folder is not evidence the folder is ITS folder.
   * Measured 2026-08-02 — `apps/youdrill` held 5 transcripts for itself and 3
   * for `apps/youdrill/app`, and reconnecting `app` there would have attached a
   * subdirectory to its parent's history.
   */
  matching: number;
  total: number;
}

/**
 * Map every working directory seen on disk to the folders that hold its
 * transcripts.
 *
 * A directory can legitimately map to more than one folder — Claude Code's
 * encoding is lossy, so two different paths can collide, and a project moved
 * and moved back leaves both. Callers pick; this reports.
 */
export function scanTranscriptFolders(
  projectsDir = claudeProjectsDir(),
  sampleFilesPerFolder = 8
): Map<string, TranscriptFolder[]> {
  const byCwd = new Map<string, TranscriptFolder[]>();
  if (!existsSync(projectsDir)) return byCwd;

  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return byCwd;
  }

  for (const name of entries) {
    const dir = join(projectsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const files = transcriptFiles(dir);
    if (files.length === 0) continue;

    // Newest first: a moved project's most recent transcripts carry its current
    // path, and older ones may still carry the old one.
    const mtimes = new Map<string, number>();
    for (const f of files) {
      try {
        mtimes.set(f, statSync(f).mtimeMs);
      } catch {
        mtimes.set(f, 0);
      }
    }
    const ordered = files.sort((a, b) => (mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0));
    const newest = mtimes.get(ordered[0]) ?? 0;

    // Count how many sampled transcripts began in each cwd, so a caller can
    // tell "this folder is that project's" from "that project appears in this
    // folder" — which are very different claims.
    const tally = new Map<string, number>();
    let sampled = 0;
    for (const f of ordered.slice(0, sampleFilesPerFolder)) {
      const cwd = cwdOfTranscript(f);
      if (!cwd) continue;
      sampled++;
      tally.set(cwd, (tally.get(cwd) ?? 0) + 1);
    }

    for (const [cwd, matching] of tally) {
      const record: TranscriptFolder = {
        name,
        count: files.length,
        newest,
        matching,
        total: sampled,
      };
      const list = byCwd.get(cwd);
      if (list) list.push(record);
      else byCwd.set(cwd, [record]);
    }
  }

  return byCwd;
}

export interface MovedProject {
  id: number;
  slug: string;
  rootPath: string;
  /** What the registry currently claims. Null when it has never been set. */
  storedDir: string | null;
  /** The folder that actually holds this project's transcripts. */
  correctDir: string;
  transcripts: number;
  /** Sessions the registry believes exist — how much is currently unreachable. */
  sessions: number;
}

export interface RegistryProjectRow {
  id: number;
  slug: string;
  root_path: string;
  encoded_dir: string | null;
  sessions: number;
}

/**
 * Which projects point at the wrong transcript folder, and where they belong.
 *
 * A project is only reported when its stored folder yields nothing AND its root
 * path is recorded as a `cwd` somewhere else. Both halves matter: without the
 * first this would rewrite entries that work, and without the second it would
 * have nothing better to offer than the value already there.
 *
 * `resolvesNow` is supplied by the caller so this module does not have to
 * duplicate the resolver's fallback logic — a project the shipped resolver
 * already handles is not broken and must not be "repaired".
 */
export function findMovedProjects(
  rows: RegistryProjectRow[],
  byCwd: Map<string, TranscriptFolder[]>,
  resolvesNow: (row: RegistryProjectRow) => boolean
): MovedProject[] {
  const out: MovedProject[] = [];

  for (const row of rows) {
    if (resolvesNow(row)) continue;

    const candidates = byCwd.get(row.root_path);
    if (!candidates || candidates.length === 0) continue;

    // Only a folder this project DOMINATES. A folder where most transcripts
    // began somewhere else belongs to that somewhere else, and attaching a
    // subdirectory to its parent's folder would hand it a history that is
    // mostly not its own — then the no-session-id fallback, which takes the
    // newest transcript in the folder, would read a sibling's work as this
    // project's. A missed repair costs nothing; a wrong one is silent and
    // wrong in the direction of confidently reporting someone else's data.
    const owned = candidates.filter((c) => c.matching * 2 > c.total);
    if (owned.length === 0) continue;

    // Most transcripts wins, newest breaks a tie: the folder with the most
    // history is the one worth reconnecting to, and recency separates a live
    // folder from an abandoned duplicate.
    const best = [...owned].sort((a, b) => b.count - a.count || b.newest - a.newest)[0];

    if (best.name === row.encoded_dir) continue;

    out.push({
      id: row.id,
      slug: row.slug,
      rootPath: row.root_path,
      storedDir: row.encoded_dir,
      correctDir: best.name,
      transcripts: best.count,
      sessions: row.sessions,
    });
  }

  // Most sessions first: those are the projects where the breakage costs most.
  return out.sort((a, b) => b.sessions - a.sessions || b.transcripts - a.transcripts);
}
