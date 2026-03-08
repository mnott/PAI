/**
 * latent-ideas.ts — graph_latent_ideas and idea_materialize endpoint handlers
 *
 * "Latent ideas" are recurring themes in the vault that exist as embedding
 * clusters but have NO dedicated note written about them yet.  PAI surfaces
 * these by running the same agglomerative clustering used by graph_clusters /
 * zettelThemes and then filtering OUT any cluster whose label is well-matched
 * by an existing note title.
 *
 * The materialize endpoint writes a new Markdown note to the vault filesystem
 * and returns its content so the plugin can open it immediately.
 */

import type { Database } from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zettelThemes } from "../zettelkasten/themes.js";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphLatentIdeasParams {
  project_id: number;
  /** Minimum notes in a cluster (default: 3) */
  min_cluster_size?: number;
  /** Cap on returned ideas (default: 15) */
  max_ideas?: number;
  /** How far back to look in days (default: 180) */
  lookback_days?: number;
  /** Cosine similarity clustering threshold (default: 0.65) */
  similarity_threshold?: number;
}

export interface LatentIdeaSourceNote {
  vault_path: string;
  title: string;
  /** How strongly this note relates to the theme (0-1) */
  relevance: number;
}

export interface LatentIdea {
  id: number;
  /** Auto-generated cluster label from zettelThemes */
  label: string;
  /** Number of notes touching this theme */
  size: number;
  /** 0-1, how likely this is a real coherent idea */
  confidence: number;
  /** Notes that contribute to this theme */
  source_notes: LatentIdeaSourceNote[];
  /** Cleaned-up version of label for a potential note title */
  suggested_title: string;
  /** Most common folder among source notes */
  suggested_folder: string;
  /** Number of distinct session date-folders (e.g. "2026/03") touching this theme */
  sessions_count: number;
}

export interface GraphLatentIdeasResult {
  ideas: LatentIdea[];
  total_clusters_analyzed: number;
  /** How many clusters already have a matching note (excluded from results) */
  materialized_count: number;
}

// ---------------------------------------------------------------------------
// Materialize params / result
// ---------------------------------------------------------------------------

export interface IdeaMaterializeParams {
  idea_label: string;
  /** User-chosen title for the new note */
  title: string;
  /** Vault-relative folder path where the note should be created */
  folder: string;
  /** Vault-relative paths of the source notes to link from the new note */
  source_paths: string[];
  project_id: number;
}

export interface IdeaMaterializeResult {
  /** Vault-relative path of the created note */
  vault_path: string;
  /** Generated markdown content */
  content: string;
  /** Number of wikilinks inserted */
  links_created: number;
}

// ---------------------------------------------------------------------------
// Helper: check if a cluster already has a matching note
// ---------------------------------------------------------------------------

/**
 * Returns true when any existing vault note title closely matches the cluster
 * label — meaning a dedicated note already exists for this topic.
 *
 * Matching strategy (simple, fast, no embeddings needed):
 *   1. Lowercase both sides and split into words.
 *   2. Remove stop words from the label words.
 *   3. If ≥ 60% of the significant label words appear in a note title → match.
 */
const TITLE_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "has", "had", "have", "not", "this", "that", "my", "we", "our",
  "new", "note", "untitled", "page", "file", "doc",
]);

function labelMatchesTitle(label: string, title: string): boolean {
  const labelWords = label
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((w) => w.length > 2 && !TITLE_STOP_WORDS.has(w));

  if (labelWords.length === 0) return false;

  const titleLower = title.toLowerCase();
  const matchCount = labelWords.filter((w) => titleLower.includes(w)).length;
  return matchCount / labelWords.length >= 0.6;
}

/**
 * Check whether any note indexed in the vault has a title matching the label.
 * Queries vault_files.title directly for efficiency.
 */
function clusterHasMatchingNote(
  db: Database,
  label: string,
  notePaths: string[]
): boolean {
  // First check the notes already in the cluster themselves — if any cluster
  // member's title matches the label it IS the index note → materialized.
  const pathSet = new Set(notePaths);

  // Fetch all titles from vault_files (bounded — vault rarely > 50k notes)
  // We do a targeted check: get titles for the cluster paths first, then
  // do a broader scan for notes NOT in the cluster.
  const rows = db
    .prepare(
      `SELECT vault_path, title FROM vault_files WHERE title IS NOT NULL LIMIT 20000`
    )
    .all() as Array<{ vault_path: string; title: string }>;

  for (const row of rows) {
    if (!row.title) continue;
    // Skip notes already counted inside the cluster — they don't count as
    // "dedicated notes"; we only skip a cluster if a SEPARATE note exists.
    if (pathSet.has(row.vault_path)) continue;
    if (labelMatchesTitle(label, row.title)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helper: generate a clean suggested title
// ---------------------------------------------------------------------------

function toSuggestedTitle(label: string): string {
  // Remove leading/trailing whitespace, capitalize each word, remove stop words
  // that are all-lowercase at the start of the title.
  const words = label
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      // Drop leading stop words (but keep if they're the only word)
      if (i === 0 && TITLE_STOP_WORDS.has(lower) && label.trim().split(/\s+/).length > 1) {
        return "";
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .filter(Boolean);

  return words.join(" ") || label;
}

// ---------------------------------------------------------------------------
// Helper: find most common folder
// ---------------------------------------------------------------------------

function mostCommonFolder(vaultPaths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of vaultPaths) {
    const parts = p.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  let best = "";
  let bestCount = 0;
  for (const [folder, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = folder;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Helper: count distinct session date-folders
// ---------------------------------------------------------------------------

/**
 * Heuristic: vault notes are often stored in date-based folders like
 * "2026/03/15" or "Daily/2026-03".  We extract the first numeric path
 * segment that looks like a year (2020-2030) and group by year+month.
 *
 * Falls back to counting distinct top-level folders.
 */
function countDistinctSessions(vaultPaths: string[]): number {
  const sessions = new Set<string>();
  const yearMonthRe = /\b(202\d)\D?(0[1-9]|1[0-2])\b/;

  for (const p of vaultPaths) {
    const m = yearMonthRe.exec(p);
    if (m) {
      sessions.add(`${m[1]}-${m[2]}`);
    } else {
      // Fallback: use top-level folder as a proxy for "session bucket"
      const topFolder = p.split("/")[0];
      sessions.add(topFolder);
    }
  }
  return sessions.size;
}

// ---------------------------------------------------------------------------
// Helper: calculate confidence score
// ---------------------------------------------------------------------------

/**
 * Confidence combines:
 *  - Cluster size (normalized, capped at 20 for max contribution)
 *  - Folder diversity (0-1 already)
 *  - Sessions count (normalized, capped at 5)
 *
 * Formula: 0.4 * sizeScore + 0.35 * folderDiversity + 0.25 * sessionScore
 */
function calcConfidence(
  size: number,
  folderDiversity: number,
  sessionsCount: number
): number {
  const sizeScore = Math.min(size / 20, 1.0);
  const sessionScore = Math.min(sessionsCount / 5, 1.0);
  const raw = 0.4 * sizeScore + 0.35 * folderDiversity + 0.25 * sessionScore;
  return Math.round(raw * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main handler: graph_latent_ideas
// ---------------------------------------------------------------------------

export async function handleGraphLatentIdeas(
  db: Database,
  params: GraphLatentIdeasParams
): Promise<GraphLatentIdeasResult> {
  const minClusterSize = params.min_cluster_size ?? 3;
  const maxIdeas = params.max_ideas ?? 15;
  const lookbackDays = params.lookback_days ?? 180;
  const similarityThreshold = params.similarity_threshold ?? 0.65;

  const { project_id: vaultProjectId } = params;
  if (!vaultProjectId) {
    throw new Error(
      "graph_latent_ideas: project_id is required (pass the vault project's numeric ID)"
    );
  }

  // Run the same clustering algorithm used by graph_clusters
  const themeResult = await zettelThemes(db, {
    vaultProjectId,
    lookbackDays,
    minClusterSize,
    maxThemes: maxIdeas * 3, // Over-fetch — many will be filtered as materialized
    similarityThreshold,
  });

  const ideas: LatentIdea[] = [];
  let materializedCount = 0;

  for (const theme of themeResult.themes) {
    const notePaths = theme.notes.map((n) => n.path);

    // Check if a dedicated note already exists for this theme
    if (clusterHasMatchingNote(db, theme.label, notePaths)) {
      materializedCount++;
      continue;
    }

    // This is a latent idea — no dedicated note exists yet
    const suggestedFolder = mostCommonFolder(notePaths);
    const sessionsCount = countDistinctSessions(notePaths);
    const confidence = calcConfidence(theme.size, theme.folderDiversity, sessionsCount);

    // Build source notes with relevance scores
    // Relevance is approximated by position in cluster (centroid-closest first)
    // zettelThemes returns notes in no guaranteed order; assign uniform relevance
    // decreasing from 1.0 to 0.5 across the list.
    const sourceNotes: LatentIdeaSourceNote[] = theme.notes.map((n, idx) => ({
      vault_path: n.path,
      title: n.title ?? n.path.split("/").pop()?.replace(/\.md$/i, "") ?? n.path,
      relevance: Math.round((1.0 - (idx / Math.max(theme.notes.length - 1, 1)) * 0.5) * 100) / 100,
    }));

    ideas.push({
      id: theme.id,
      label: theme.label,
      size: theme.size,
      confidence,
      source_notes: sourceNotes,
      suggested_title: toSuggestedTitle(theme.label),
      suggested_folder: suggestedFolder,
      sessions_count: sessionsCount,
    });

    if (ideas.length >= maxIdeas) break;
  }

  // Sort by confidence descending
  ideas.sort((a, b) => b.confidence - a.confidence);

  return {
    ideas,
    total_clusters_analyzed: themeResult.themes.length + materializedCount,
    materialized_count: materializedCount,
  };
}

// ---------------------------------------------------------------------------
// Materialize handler: idea_materialize
// ---------------------------------------------------------------------------

export function handleIdeaMaterialize(
  params: IdeaMaterializeParams,
  vaultPath: string
): IdeaMaterializeResult {
  const { idea_label, title, folder, source_paths } = params;

  // Sanitize filename: replace characters illegal in filenames
  const safeTitle = title.replace(/[/\\:*?"<>|]/g, "-");
  const fileName = `${safeTitle}.md`;

  // Vault-relative path (forward slashes, no leading slash)
  const relFolder = folder.replace(/^\/+|\/+$/g, "");
  const vault_path = relFolder ? `${relFolder}/${fileName}` : fileName;

  // Absolute filesystem path
  const absPath = join(vaultPath, vault_path);
  const absDir = dirname(absPath);

  // Build wikilinks from source_paths
  const wikilinks = source_paths
    .map((p) => {
      // Derive a display name: filename without extension
      const name = p.split("/").pop()?.replace(/\.md$/i, "") ?? p;
      // Relative wikilink — use just the filename (Obsidian resolves by title)
      return `- [[${name}]]`;
    })
    .join("\n");

  const links_created = source_paths.length;

  const content = [
    `# ${title}`,
    "",
    `*Materialized from latent idea: "${idea_label}"*`,
    `*Sources: ${links_created} notes*`,
    "",
    "## Related Notes",
    "",
    wikilinks || "*(no source notes)*",
    "",
    "## Notes",
    "",
    "<!-- Add your thoughts about this idea here -->",
    "",
  ].join("\n");

  // Write the file (create parent directories as needed)
  mkdirSync(absDir, { recursive: true });
  writeFileSync(absPath, content, "utf-8");

  return {
    vault_path,
    content,
    links_created,
  };
}
