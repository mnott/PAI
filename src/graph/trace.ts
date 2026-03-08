/**
 * trace.ts — graph_trace endpoint handler
 *
 * Given a topic/keyword query, searches vault notes for appearances of that topic
 * and returns a chronological timeline showing how the idea evolved over time.
 */

import type { StorageBackend } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Public param / result types
// ---------------------------------------------------------------------------

export interface GraphTraceParams {
  query: string;
  project_id: number;
  max_results?: number;
  lookback_days?: number;
}

export interface TraceEntry {
  vault_path: string;
  title: string;
  folder: string;
  indexed_at: number;
  snippet: string;
  dominant_type: string;
}

export interface TraceConnection {
  from_path: string;
  to_path: string;
  type: "temporal" | "wikilink";
}

export interface GraphTraceResult {
  query: string;
  entries: TraceEntry[];
  connections: TraceConnection[];
  time_span: { from: number; to: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function folderFromPath(vaultPath: string): string {
  const lastSlash = vaultPath.lastIndexOf("/");
  return lastSlash === -1 ? "" : vaultPath.slice(0, lastSlash);
}

function extractSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    return text.slice(0, 160).trimEnd() + (text.length > 160 ? "…" : "");
  }

  const CONTEXT = 70;
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
  backend: StorageBackend,
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
  try {
    const namePaths = await backend.searchVaultNameIndex(query, 100);
    for (const vaultPath of namePaths) {
      if (!matchedPaths.has(vaultPath)) {
        matchedPaths.set(vaultPath, "");
      }
    }
  } catch {
    // vault_name_index may not exist in all schema versions
  }

  // Strategy B: content search in memory_chunks
  try {
    const chunkRows = await backend.searchChunksByText(params.project_id, query, 200);
    for (const row of chunkRows) {
      if (!matchedPaths.has(row.path)) {
        matchedPaths.set(row.path, row.text);
      } else if (!matchedPaths.get(row.path)) {
        matchedPaths.set(row.path, row.text);
      }
    }
  } catch {
    // Best-effort — continue with what we have
  }

  if (matchedPaths.size === 0) {
    return { query, entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  // ---------------------------------------------------------------------------
  // Step 2: Fetch vault_files metadata for all matched paths, filtered by cutoff
  // ---------------------------------------------------------------------------

  const allPaths = Array.from(matchedPaths.keys());
  let fileRows: Array<{ vaultPath: string; title: string | null; indexedAt: number }> = [];
  try {
    fileRows = await backend.getVaultFilesByPathsAfter(allPaths, cutoffTimestamp * 1000);
    // Sort chronologically
    fileRows.sort((a, b) => a.indexedAt - b.indexedAt);
  } catch {
    return { query, entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  if (fileRows.length === 0) {
    return { query, entries: [], connections: [], time_span: { from: 0, to: 0 } };
  }

  // ---------------------------------------------------------------------------
  // Step 3: Build TraceEntry array
  // ---------------------------------------------------------------------------

  const entries: TraceEntry[] = fileRows.slice(0, maxResults).map((row) => {
    const fileName = row.vaultPath.split("/").pop() ?? row.vaultPath;
    const title = row.title ?? fileName.replace(/\.md$/i, "");
    const chunkText = matchedPaths.get(row.vaultPath) ?? "";
    const snippet = extractSnippet(chunkText, query);

    return {
      vault_path: row.vaultPath,
      title,
      folder: folderFromPath(row.vaultPath),
      indexed_at: row.indexedAt,
      snippet,
      dominant_type: "unknown",
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

  // Wikilink edges
  try {
    const entryPaths = entries.map(e => e.vault_path);
    const linkRows = await backend.getVaultLinksFromPaths(entryPaths);

    const wikiEdgeKeys = new Set<string>();
    for (const row of linkRows) {
      if (!row.targetPath) continue;
      if (!entryPathSet.has(row.targetPath)) continue;

      const key = `${row.sourcePath}|||${row.targetPath}`;
      if (wikiEdgeKeys.has(key)) continue;
      wikiEdgeKeys.add(key);

      connections.push({
        from_path: row.sourcePath,
        to_path: row.targetPath,
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
