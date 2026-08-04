/**
 * Shared row types and interfaces for the project command module.
 * These mirror the SQLite schema and are used across all project sub-commands.
 */

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  type: string;
  status: string;
  session_config: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  title: string;
  status: string;
  closed_at: number | null;
}

export interface SessionConfig {
  permission?: string;  // preset name or 'custom'
  flags?: string;       // raw CLI flags, e.g. '--dangerously-skip-permissions'
  env?: Record<string, string>;  // env vars to set, e.g. { IS_SANDBOX: '1' }
  autoStart?: boolean;  // whether to auto-start with 'go' prompt
  prompt?: string;      // initial prompt, e.g. 'go' or 'continue'
  model?: string;       // model override, e.g. 'opus', 'sonnet'
}

export interface ConfigOption {
  key: string;
  type: 'string' | 'boolean' | 'object';
  description: string;
  examples: string[];
}

export interface HealthRow extends ProjectRow {
  session_count: number;
}

/**
 * Note that "active" here means THE PATH EXISTS ON DISK, not the registry's
 * `status` column. The two disagree: measured 2026-08-04, 124 paths present
 * against 99 registry-active, because 29 archived projects still have their
 * directory. Kept as-is for `--status` and JSON compatibility, but the printed
 * summary says "with the path present" for exactly this reason.
 */
export type HealthCategory = "active" | "stale" | "dead";

/**
 * WHY a project is unhealthy, which decides what to do about it.
 *
 * `category` alone collapsed four different situations into "dead", and offered
 * one remedy — archive — for all of them. Archiving a duplicate strands its
 * sessions; archiving a live directory registered under a wrong name fixes
 * nothing; and a worktree should never have been registered at all.
 */
export type HealthReason = "dead" | "duplicate" | "misnamed" | "ephemeral";

export interface ProjectHealth {
  project: HealthRow;
  category: HealthCategory;
  /** For stale: a similar directory found on disk near the recorded path */
  suggestedPath?: string;
  claudeNotesExists: boolean;
  orphanedNotesDirs: string[];
  /** Absent when the project is healthy. */
  reason?: HealthReason;
  /** The slug that owns this path. Only meaningful for `duplicate` and `misnamed`. */
  owner?: string;
  /** What to do about it — never a destructive command for a row holding sessions. */
  action?: string;
}
