/**
 * Path utilities — encoding, Notes/Sessions directory discovery and creation.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
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
 * Move all .jsonl session files from project root to sessions/ subdirectory.
 * Returns the number of files moved.
 */
export function moveSessionFilesToSessionsDir(
  projectDir: string,
  excludeFile?: string,
  silent = false
): number {
  const sessionsDir = ensureSessionsDirFromProjectDir(projectDir);

  if (!existsSync(projectDir)) return 0;

  const files = readdirSync(projectDir);
  let movedCount = 0;

  for (const file of files) {
    if (file.endsWith('.jsonl') && file !== excludeFile) {
      const sourcePath = join(projectDir, file);
      const destPath = join(sessionsDir, file);
      try {
        renameSync(sourcePath, destPath);
        if (!silent) console.error(`Moved ${file} → sessions/`);
        movedCount++;
      } catch (error) {
        if (!silent) console.error(`Could not move ${file}: ${error}`);
      }
    }
  }

  return movedCount;
}

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
