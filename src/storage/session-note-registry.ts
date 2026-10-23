/**
 * Keeps the session registry in step with note files on disk: applies queued renames,
 * resolves a registry row to its file, and repairs rows whose file cannot be found.
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, appendFileSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RegistryBackend, Session } from "./registry-interface.js";
import { registryRenameQueuePath, type RegistryRenameEntry } from "../hooks/ts/lib/project-utils/session-notes.js";

const NOTE_RE = /^(\d{3,4}) - (\d{4}-\d{2}-\d{2}) - (.*)\.md$/;

/** Filename as stored in the registry: path relative to the Notes dir (YYYY/MM/<file> when filed, else flat). */
export function registryFilename(notesDir: string, notePath: string): string {
  return relative(notesDir, notePath).split(sep).join("/");
}

/** Every note file under a Notes tree (year/month folders and .archive), as paths. */
export function listNoteFiles(notesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 5) walk(join(dir, e.name), depth + 1);
      } else if (NOTE_RE.test(e.name)) out.push(join(dir, e.name));
    }
  };
  walk(notesDir, 0);
  return out;
}

function matchesNumberDate(file: string, number: number, date: string): boolean {
  const name = file.slice(file.lastIndexOf(sep) + 1);
  const m = NOTE_RE.exec(name);
  return !!m && Number(m[1]) === number && m[2] === date;
}

/** Note files in the tree carrying this number and date. */
export function findByNumberDate(notesDir: string, number: number, date: string): string[] {
  return listNoteFiles(notesDir).filter((f) => matchesNumberDate(f, number, date));
}

export interface NoteRef {
  number: number;
  date: string;
  filename: string;
}

/**
 * Where the note of a registry row lives: the stored filename, then Notes/YYYY/MM/<filename>,
 * then .archive, then a unique number+date match in the tree. Null when nothing (or more than one) matches.
 */
export function resolveSessionNote(notesDir: string | string[], row: NoteRef): string | null {
  return resolveStoredNote(notesDir, row) ?? uniqueByNumberDate(notesDir, row);
}

function uniqueByNumberDate(notesDir: string | string[], row: NoteRef): string | null {
  const hits = ([] as string[]).concat(notesDir).flatMap((d) => findByNumberDate(d, row.number, row.date));
  return hits.length === 1 ? hits[0]! : null;
}

/** The stored filename found as is, under YYYY/MM, or in .archive; null when the row points at nothing. */
export function resolveStoredNote(notesDir: string | string[], row: NoteRef): string | null {
  for (const d of ([] as string[]).concat(notesDir)) {
    const f = resolveStoredIn(d, row);
    if (f) return f;
  }
  return null;
}

function resolveStoredIn(notesDir: string, row: NoteRef): string | null {
  const [y, m] = row.date.split("-");
  const base = row.filename.split("/").pop() ?? row.filename;
  const candidates = [
    join(notesDir, row.filename),
    join(notesDir, y ?? "", m ?? "", base),
    join(notesDir, ".archive", row.filename),
    join(notesDir, ".archive", y ?? "", m ?? "", base),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Project's Notes dir from the encoded dir under ~/.claude/projects. */
function encodedDirOf(notesDir: string): string | null {
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/]Notes(?:[\\/]|$)/.exec(notesDir);
  return m ? m[1]! : null;
}

function notesRoot(notesDir: string): string {
  const i = notesDir.search(/[\\/]Notes(?:[\\/]|$)/);
  return i < 0 ? notesDir : notesDir.slice(0, i) + sep + "Notes";
}

/** Apply one rename to the matching registry row. True when a row was found and updated. */
export async function applyRename(backend: RegistryBackend, e: RegistryRenameEntry, claudeSessionId?: string): Promise<boolean> {
  const encoded = encodedDirOf(e.notesDir);
  const root = notesRoot(e.notesDir).replace(/[\\/](?:\.claude[\\/])?Notes$/, "");
  const project = (encoded ? await backend.getProjectByEncodedDir(encoded) : null) ?? (await backend.getProjectByRootPath(root));
  if (!project) return false;
  const rows = await backend.listSessionsForProject(project.id);
  let row: Session | undefined = claudeSessionId ? rows.find((r) => r.claude_session_id === claudeSessionId) : undefined;
  if (!row) {
    const hits = rows.filter((r) => r.number === e.number && r.date === e.date);
    row = hits.length === 1 ? hits[0] : hits.find((r) => r.filename.split("/").pop() === e.oldFilename);
  }
  if (!row) return false;
  const filename = registryFilename(notesRoot(e.notesDir), join(e.notesDir, e.newFilename));
  await backend.updateSessionMeta(row.id, { title: e.title, filename });
  return true;
}

/**
 * Apply every queued rename. Entries that cannot be applied because the registry is unreachable
 * stay queued; entries without a matching row are dropped. Never throws.
 */
export async function drainRenameQueue(getBackend: () => Promise<RegistryBackend>, queue = registryRenameQueuePath()): Promise<{ applied: number; kept: number; dropped: number }> {
  const result = { applied: 0, kept: 0, dropped: 0 };
  if (!existsSync(queue)) return result;
  const work = `${queue}.${process.pid}.work`;
  try {
    renameSync(queue, work);
  } catch {
    return result;
  }
  const entries: RegistryRenameEntry[] = [];
  for (const line of readFileSync(work, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RegistryRenameEntry);
    } catch {
      result.dropped++;
    }
  }
  const keep: RegistryRenameEntry[] = [];
  let backend: RegistryBackend | null = null;
  try {
    backend = await getBackend();
  } catch {
    backend = null;
  }
  for (const e of entries) {
    if (!backend) {
      keep.push(e);
      continue;
    }
    try {
      if (await applyRename(backend, e)) result.applied++;
      else result.dropped++;
    } catch {
      keep.push(e);
    }
  }
  result.kept = keep.length;
  try {
    if (keep.length) {
      mkdirSync(join(queue, ".."), { recursive: true });
      appendFileSync(queue, keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
  } finally {
    try { unlinkSync(work); } catch { /* already gone */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  project: string;
  rows: number;
  resolved: number;
  fixed: number;
  ambiguous: number;
  unmatched: number;
}

/**
 * For each row whose file does not resolve, match by number+date in the Notes tree and update
 * title+filename. Never deletes rows. `notesDirOf` maps a project to its Notes dir.
 */
export async function repairProject(
  backend: RegistryBackend,
  project: { id: number; slug: string },
  notesDirs: string[],
  dryRun: boolean,
): Promise<RepairOutcome> {
  const out: RepairOutcome = { project: project.slug, rows: 0, resolved: 0, fixed: 0, ambiguous: 0, unmatched: 0 };
  const rows = await backend.listSessionsForProject(project.id);
  out.rows = rows.length;
  const files = notesDirs.flatMap((d) => listNoteFiles(d).map((f) => ({ f, d })));
  for (const row of rows) {
    const found = resolveStoredNote(notesDirs, row);
    if (found) {
      out.resolved++;
      continue;
    }
    const hits = files.filter((x) => matchesNumberDate(x.f, row.number, row.date));
    if (hits.length === 0) {
      out.unmatched++;
      continue;
    }
    if (hits.length > 1) {
      out.ambiguous++;
      continue;
    }
    const { f, d } = hits[0]!;
    const m = NOTE_RE.exec(f.slice(f.lastIndexOf(sep) + 1))!;
    if (!dryRun) await backend.updateSessionMeta(row.id, { title: m[3]!, filename: registryFilename(d, f) });
    out.fixed++;
  }
  return out;
}
