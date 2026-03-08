/**
 * trace.ts — graph_trace endpoint handler
 *
 * Given a topic/keyword query, searches vault notes for appearances of that topic
 * and returns a chronological timeline showing how the idea evolved over time.
 *
 * Algorithm:
 *   1. Search vault_name_index for title/alias matches.
 *   2. Fall back to memory_chunks FTS/LIKE search for content matches.
 *   3. Fetch vault_files metadata for all matched paths.
 *   4. Sort chronologically by indexed_at.
 *   5. Extract a context snippet showing the query keyword.
 *   6. Build temporal edges (consecutive entries) + wikilink edges.
 *   7. Cap at max_results and return.
 */

import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphTraceParams {
  /** Topic/keyword to trace through time */
  query: string;
  /** Numeric PAI project ID */
  project_id: number;
  /** Cap on timeline entries (default: 30) */
  max_results?: number;
  /** How far back to search in days (default: 365) */
  lookback_days?: number;
}

export interface TraceEntry {
  /** Vault-relative path, e.g. "Projects/PAI/idea-2024.md" */
  vault_path: string;
  /** Note title from frontmatter or H1 */
  title: string;
  /** Parent folder path derived from vault_path */
  folder: string;
  /** Unix timestamp (seconds) when this note was indexed — used for timeline ordering */
  indexed_at: number;
  /** Text excerpt showing the topic in context (100-200 chars) */
  snippet: string;
  /** Most common observation type for this note */
  dominant_type: string;
}

export interface TraceConnection {
  /** Earlier note's vault path */
  from_path: string;
  /** Later note's vault path */
  to_path: string;
  /** "temporal" = time-sequence connection, "wikilink" = explicit vault link exists */
  type: "temporal" | "wikilink";
}

export interface GraphTraceResult {
  /** The query that was traced */
  query: string;
  /** Timeline entries sorted oldest-first */
  entries: TraceEntry[];
  /** Edges connecting entries: temporal sequence + any wikilinks */
  connections: TraceConnection[];
  /** Unix timestamp range covered by the results */
  time_span: { from: number; to: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function folderFromPath(vaultPath: string): string {
  const lastSlash = vaultPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash);
}

/**
 * Extract a snippet of text showing the query keyword in context.
 * Returns up to ~160 chars centered around the first occurrence.
 */
function extractSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    // Query not found in text — return the opening of the note
    return text.slice(0, 160).trimEnd() + (text.length > 160 ? "…" : "");
  }

  const CONTEXT = 70; // chars before/after the match
  const start = Math.max(0, idx - CONTEXT);
  const end = Math.min(text.length, idx + query.length + CONTEXT);

  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";

  return snippet;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGraphTrace(
  db: Database,
  params: GraphTraceParams
): Promise<GraphTraceResult> {
  const query = (params.query ?? "").trim();
  if (!query) {
    return { query: "", entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  const maxResults = params.max_results ?? 30;
  const lookbackDays = params.lookback_days ?? 365;
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  // ---------------------------------------------------------------------------
  // Step 1: Collect matching vault paths via multiple search strategies
  // ---------------------------------------------------------------------------

  const matchedPaths = new Map<string, string>(); // path → best snippet text

  // Strategy A: title / alias match in vault_name_index
  type NameIndexRow = { vault_path: string };
  try {
    const nameRows = db
      .prepare(
        `SELECT DISTINCT vault_path
         FROM vault_name_index
         WHERE lower(name) LIKE lower('%' || ? || '%')
         LIMIT 100`
      )
      .all(query) as NameIndexRow[];

    for (const row of nameRows) {
      if (!matchedPaths.has(row.vault_path)) {
        matchedPaths.set(row.vault_path, "");
      }
    }
  } catch {
    // vault_name_index may not exist in all schema versions — silently skip
  }

  // Strategy B: content search in memory_chunks using LIKE
  type ChunkRow = { path: string; text: string };
  try {
    const chunkRows = db
      .prepare(
        `SELECT DISTINCT mc.path, mc.text
         FROM memory_chunks mc
         WHERE mc.project_id = ?
           AND lower(mc.text) LIKE lower('%' || ? || '%')
         LIMIT 200`
      )
      .all(params.project_id, query) as ChunkRow[];

    for (const row of chunkRows) {
      if (!matchedPaths.has(row.path)) {
        // Store snippet text for this path; prefer chunk that actually contains the keyword
        matchedPaths.set(row.path, row.text);
      } else if (!matchedPaths.get(row.path)) {
        matchedPaths.set(row.path, row.text);
      }
    }
  } catch {
    // memory_chunks may not have project_id — try without it
    try {
      const chunkRows = db
        .prepare(
          `SELECT DISTINCT mc.path, mc.text
           FROM memory_chunks mc
           WHERE lower(mc.text) LIKE lower('%' || ? || '%')
           LIMIT 200`
        )
        .all(query) as ChunkRow[];

      for (const row of chunkRows) {
        if (!matchedPaths.has(row.path)) {
          matchedPaths.set(row.path, row.text);
        }
      }
    } catch {
      // Best-effort — continue with what we have
    }
  }

  if (matchedPaths.size === 0) {
    return {
      query,
      entries: [],
      connections: [],
      time_span: { from: 0, to: 0 },
    };
  }

  // ---------------------------------------------------------------------------
  // Step 2: Fetch vault_files metadata for all matched paths
  // ---------------------------------------------------------------------------

  const allPaths = Array.from(matchedPaths.keys());

  type VaultFileRow = {
    vault_path: string;
    title: string | null;
    indexed_at: number;
  };

  // SQLite IN clause with parameterised placeholders
  const placeholders = allPaths.map(() => "?").join(", ");
  let fileRows: VaultFileRow[] = [];
  try {
    fileRows = db
      .prepare(
        `SELECT vault_path, title, indexed_at
         FROM vault_files
         WHERE vault_path IN (${placeholders})
           AND indexed_at >= ?
         ORDER BY indexed_at ASC`
      )
      .all(...allPaths, cutoffTimestamp) as VaultFileRow[];
  } catch {
    // vault_files may not exist — return empty
    return { query, entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  // ---------------------------------------------------------------------------
  // Step 3: Build TraceEntry array
  // ---------------------------------------------------------------------------

  const entries: TraceEntry[] = fileRows.slice(0, maxResults).map((row) => {
    const fileName = row.vault_path.split("/").pop() ?? row.vault_path;
    const title = row.title ?? fileName.replace(/\.md$/i, "");
    const chunkText = matchedPaths.get(row.vault_path) ?? "";
    const snippet = extractSnippet(chunkText, query);

    return {
      vault_path: row.vault_path,
      title,
      folder: folderFromPath(row.vault_path),
      indexed_at: row.indexed_at,
      snippet,
      dominant_type: "unknown", // observation type enrichment not available in SQLite schema
    };
  });

  if (entries.length === 0) {
    return { query, entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  // ---------------------------------------------------------------------------
  // Step 4: Build connections
  // ---------------------------------------------------------------------------

  const connections: TraceConnection[] = [];
  const entryPathSet = new Set(entries.map((e) => e.vault_path));

  // Temporal edges: consecutive entries (oldest → next)
  for (let i = 0; i < entries.length - 1; i++) {
    connections.push({
      from_path: entries[i].vault_path,
      to_path: entries[i + 1].vault_path,
      type: "temporal",
    });
  }

  // Wikilink edges: any explicit vault_links between entries in the result set
  type LinkRow = { source_path: string; target_path: string | null };
  try {
    const linkRows = db
      .prepare(
        `SELECT source_path, target_path
         FROM vault_links
         WHERE source_path IN (${placeholders})
           AND target_path IS NOT NULL`
      )
      .all(...entries.map((e) => e.vault_path)) as LinkRow[];

    const wikiEdgeKeys = new Set<string>();
    for (const row of linkRows) {
      if (!row.target_path) continue;
      if (!entryPathSet.has(row.target_path)) continue;

      // Avoid adding the same wikilink twice
      const key = `${row.source_path}|||${row.target_path}`;
      if (wikiEdgeKeys.has(key)) continue;
      wikiEdgeKeys.add(key);

      // Only add if it's not already covered by a temporal edge in the same direction
      connections.push({
        from_path: row.source_path,
        to_path: row.target_path,
        type: "wikilink",
      });
    }
  } catch {
    // vault_links may not exist — temporal edges are sufficient
  }

  // ---------------------------------------------------------------------------
  // Step 5: Compute time span
  // ---------------------------------------------------------------------------

  const timestamps = entries.map((e) => e.indexed_at).filter((t) => t > 0);
  const timeFrom = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const timeTo = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  return {
    query,
    entries,
    connections,
    time_span: { from: timeFrom, to: timeTo },
  };
}
