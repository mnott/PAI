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

export type HealthCategory = "active" | "stale" | "dead";

export interface ProjectHealth {
  project: HealthRow;
  category: HealthCategory;
  /** For stale: a similar directory found on disk near the recorded path */
  suggestedPath?: string;
  claudeNotesExists: boolean;
  orphanedNotesDirs: string[];
}
