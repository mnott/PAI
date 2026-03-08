/** Shared types for the obsidian sync sub-modules. */

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  status: string;
  obsidian_link: string | null;
  claude_notes_dir: string | null;
}

export interface SessionStats {
  session_count: number;
  last_active: number | null;
}

export interface TagRow {
  name: string;
}

export interface SyncStats {
  created: number;
  updated: number;
  removed: number;
  stubbed: number;
  errors: string[];
}

export interface SessionFile {
  /** Absolute path on disk (inside the symlink target, resolved). */
  absPath: string;
  /** Relative path from the vault project dir (e.g. "notes/2026/02/0001 - ..."). */
  vaultRelPath: string;
  /** Wikilink target — relative to the vault project dir, no .md extension. */
  wikilinkTarget: string;
  /** YYYY/MM extracted from path or filename. */
  yearMonth: string;
  /** Basename without .md. */
  basename: string;
}
