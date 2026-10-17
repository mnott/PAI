/**
 * Shared types and constants for the session-cleanup command.
 */

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
  claude_notes_dir: string | null;
}

export interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status: string;
}

export type SessionClassification = "EMPTY" | "UNNAMED" | "NAMED" | "LEGACY_FORMAT";

export interface SessionCandidate {
  session: SessionRow | null; // null if file exists on disk but not in DB
  filename: string;
  filepath: string;
  sizeBytes: number;
  classification: SessionClassification;
  autoName?: string; // proposed name for UNNAMED sessions
  date: string;
  number: number;
}

export interface NotesDirPlan {
  notesDir: string;
  toDelete: SessionCandidate[];
  toRename: SessionCandidate[];
  toMove: SessionCandidate[]; // survivors that need moving to YYYY/MM/ within this dir
}

export interface CleanupPlan {
  project: ProjectRow;
  notesDirs: NotesDirPlan[]; // one entry per discovered Notes/ directory (up to 2)
  renumberMap: Map<number, number>; // old number → new number (global across both dirs)
}

// Template content indicators — if the file only contains these patterns, delete it.
export const TEMPLATE_INDICATORS = [
  "<!-- PAI will add completed work here during session -->",
  "<!-- PAI will add completed work here -->",
  "Session completed.",
  "Session started and ready for your instructions",
];

// Session filename patterns
export const MODERN_PATTERN = /^(\d{4}) - (\d{4}-\d{2}-\d{2}) - (.+)\.md$/;
export const LEGACY_PATTERN = /^(\d{4})_(\d{4}-\d{2}-\d{2})_(.+)\.md$/;
