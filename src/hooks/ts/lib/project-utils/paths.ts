/**
 * Path utilities — encoding, Notes/Sessions directory discovery and creation.
 */

import { existsSync, mkdirSync, readdirSync, linkSync, copyFileSync } from 'fs';
import { join, basename } from 'path';
import { PAI_DIR } from '../pai-paths.js';

// Re-export PAI_DIR for consumers
export { PAI_DIR };
export const PROJECTS_DIR = join(PAI_DIR, 'projects');

/**
 * Directories known to be automated health-check / probe sessions.
 * Hooks should exit early for these to avoid registry clutter and wasted work.
 */
const PROBE_CWD_PATTERNS = [
  '/CodexBar/ClaudeProbe',
  '/ClaudeProbe',
];

/**
 * Check if the current working directory belongs to a probe/health-check session.
 * Returns true if hooks should skip this session entirely.
 */
export function isProbeSession(cwd?: string): boolean {
  const dir = cwd || process.cwd();
  return PROBE_CWD_PATTERNS.some(pattern => dir.includes(pattern));
}

/**
 * Encode a path the same way Claude Code does:
 * - Replace / with -
 * - Replace . with -
 * - Replace space with -
 */
export function encodePath(path: string): string {
  return path
    .replace(/\//g, '-')
    .replace(/\./g, '-')
    .replace(/ /g, '-');
}

/** Get the project directory for a given working directory. */
export function getProjectDir(cwd: string): string {
  const encoded = encodePath(cwd);
  return join(PROJECTS_DIR, encoded);
}

/** Get the Notes directory for a project (central location). */
export function getNotesDir(cwd: string): string {
  return join(getProjectDir(cwd), 'Notes');
}

/**
 * Find Notes directory — checks local first, falls back to central.
 * Does NOT create the directory.
 */
export function findNotesDir(cwd: string): { path: string; isLocal: boolean } {
  const cwdBasename = basename(cwd).toLowerCase();
  if (cwdBasename === 'notes' && existsSync(cwd)) {
    return { path: cwd, isLocal: true };
  }

  const localPaths = [
    join(cwd, 'Notes'),
    join(cwd, 'notes'),
    join(cwd, '.claude', 'Notes'),
  ];

  for (const path of localPaths) {
    if (existsSync(path)) {
      return { path, isLocal: true };
    }
  }

  return { path: getNotesDir(cwd), isLocal: false };
}

/** Get the sessions/ directory for a project (stores .jsonl transcripts). */
export function getSessionsDir(cwd: string): string {
  return join(getProjectDir(cwd), 'sessions');
}

/** Get the sessions/ directory from a project directory path. */
export function getSessionsDirFromProjectDir(projectDir: string): string {
  return join(projectDir, 'sessions');
}

// ---------------------------------------------------------------------------
// Directory creation helpers
// ---------------------------------------------------------------------------

/** Ensure the Notes directory exists for a project. @deprecated Use ensureNotesDirSmart() */
export function ensureNotesDir(cwd: string): string {
  const notesDir = getNotesDir(cwd);
  if (!existsSync(notesDir)) {
    mkdirSync(notesDir, { recursive: true });
    console.error(`Created Notes directory: ${notesDir}`);
  }
  return notesDir;
}

/**
 * Smart Notes directory handling:
 * - If local Notes/ exists → use it (don't create anything new)
 * - If no local Notes/ → ensure central exists and use that
 */
export function ensureNotesDirSmart(cwd: string): { path: string; isLocal: boolean } {
  const found = findNotesDir(cwd);
  if (found.isLocal) return found;
  if (!existsSync(found.path)) {
    mkdirSync(found.path, { recursive: true });
    console.error(`Created central Notes directory: ${found.path}`);
  }
  return found;
}

/** Ensure the sessions/ directory exists for a project. */
export function ensureSessionsDir(cwd: string): string {
  const sessionsDir = getSessionsDir(cwd);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    console.error(`Created sessions directory: ${sessionsDir}`);
  }
  return sessionsDir;
}

/** Ensure the sessions/ directory exists (from project dir path). */
export function ensureSessionsDirFromProjectDir(projectDir: string): string {
  const sessionsDir = getSessionsDirFromProjectDir(projectDir);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
    console.error(`Created sessions directory: ${sessionsDir}`);
  }
  return sessionsDir;
}

/**
 * Publish every project-root .jsonl into sessions/ as well, WITHOUT removing it.
 *
 * This used to renameSync, and that is how PAI destroyed its users' sessions.
 *
 * `claude --resume <uuid>` finds a transcript only at the project root. Move it
 * into sessions/ and the session becomes permanently unresumable — measured
 * 2026-08-04: `claude --resume b3462801` (867 KB of real work, sessions/ only)
 * answers "No conversation found with session ID", while a top-level id is found
 * fine. Nothing warned; the id still looked valid everywhere PAI displayed it.
 *
 * The damage was not occasional. This ran from a UserPromptSubmit hook excluding
 * only the CURRENT session, so every prompt anyone typed unresumed every other
 * session in the project. One PAI project measured 1 transcript at top level
 * against 52 underneath. Among the casualties was 046bb712 — the exact id PAI's
 * own handover tells the user to resume.
 *
 * A hardlink satisfies both sides, which is why this is a two-line fix rather
 * than a redesign: the archive genuinely has consumers that read sessions/
 * (session-summary-worker, registry/moved, session/autosave), and `--resume`
 * needs the root path. One inode, two names, no copy, no window where the file
 * is missing from either place.
 *
 * Never unlink the source. Tidying up another tool's store was the whole
 * mistake; a stale duplicate is free, a lost session is not. Every caller of
 * `transcriptFiles()` was checked before choosing this — they all test emptiness
 * (`.length > 0`), never count, so the duplicate cannot skew a project's stats.
 *
 * `excludeFile` keeps a hook from archiving the transcript it is itself watching
 * being written. It is not a "finished sessions only" guard and must not be read
 * as one: it excludes exactly one file, the caller's own, so with two sessions
 * live in one project each still archives the other mid-turn. A consumer that
 * needs "finished only" has to enforce that itself — this function cannot know
 * what is live.
 *
 * Returns the number of files newly archived.
 */
export function archiveSessionFilesToSessionsDir(
  projectDir: string,
  excludeFile?: string,
  silent = false
): number {
  const sessionsDir = ensureSessionsDirFromProjectDir(projectDir);

  if (!existsSync(projectDir)) return 0;

  const files = readdirSync(projectDir);
  let archivedCount = 0;

  for (const file of files) {
    if (!file.endsWith('.jsonl') || file === excludeFile) continue;

    const sourcePath = join(projectDir, file);
    const destPath = join(sessionsDir, file);

    // Already archived — including by an earlier rename, before this was a
    // hardlink. Those are the sessions that need restoring to the root, which is
    // a separate repair and not this function's job.
    if (existsSync(destPath)) continue;

    try {
      linkSync(sourcePath, destPath);
      if (!silent) console.error(`Archived ${file} → sessions/ (still resumable)`);
      archivedCount++;
    } catch (error) {
      // Cross-device (EXDEV) is the realistic failure: sessions/ on another
      // volume. Copy instead, and still leave the original alone.
      try {
        copyFileSync(sourcePath, destPath);
        if (!silent) console.error(`Copied ${file} → sessions/ (hardlink unavailable)`);
        archivedCount++;
      } catch {
        if (!silent) console.error(`Could not archive ${file}: ${error}`);
      }
    }
  }

  return archivedCount;
}

/**
 * @deprecated Renamed to `archiveSessionFilesToSessionsDir`, which is what it
 * now does. Kept so an out-of-tree caller fails loudly at the type level rather
 * than silently keeping the old destructive name for a non-destructive action.
 */
export const moveSessionFilesToSessionsDir = archiveSessionFilesToSessionsDir;

// ---------------------------------------------------------------------------
// CLAUDE.md / TODO.md discovery
// ---------------------------------------------------------------------------

/** Find TODO.md — check local first, fallback to central. */
export function findTodoPath(cwd: string): string {
  const localPaths = [
    join(cwd, 'TODO.md'),
    join(cwd, 'notes', 'TODO.md'),
    join(cwd, 'Notes', 'TODO.md'),
    join(cwd, '.claude', 'TODO.md'),
  ];

  for (const path of localPaths) {
    if (existsSync(path)) return path;
  }

  return join(getNotesDir(cwd), 'TODO.md');
}

/** Find CLAUDE.md — returns the FIRST found path. */
export function findClaudeMdPath(cwd: string): string | null {
  const paths = findAllClaudeMdPaths(cwd);
  return paths.length > 0 ? paths[0] : null;
}

/**
 * Find ALL CLAUDE.md files in local locations in priority order.
 */
export function findAllClaudeMdPaths(cwd: string): string[] {
  const foundPaths: string[] = [];

  const localPaths = [
    join(cwd, '.claude', 'CLAUDE.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, 'Notes', 'CLAUDE.md'),
    join(cwd, 'notes', 'CLAUDE.md'),
    join(cwd, 'Prompts', 'CLAUDE.md'),
    join(cwd, 'prompts', 'CLAUDE.md'),
  ];

  for (const path of localPaths) {
    if (existsSync(path)) foundPaths.push(path);
  }

  return foundPaths;
}
