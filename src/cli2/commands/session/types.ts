/**
 * Shared row types for the session command module.
 */

export interface SessionRow {
  id: number;
  project_id: number;
  number: number;
  date: string;
  slug: string;
  title: string;
  filename: string;
  status: string;
  claude_session_id: string | null;
  token_count: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  root_path: string;
  encoded_dir: string;
}
