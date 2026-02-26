/**
 * Topic shift detection engine.
 *
 * Accepts a context summary (recent conversation text) and determines whether
 * the conversation has drifted away from the currently-routed project.
 *
 * Algorithm:
 *   1. Run keyword memory_search against the context text (no project filter)
 *   2. Score results by project — sum of BM25 scores per project
 *   3. Compare the top-scoring project against the current project
 *   4. If a different project dominates by more than the confidence threshold,
 *      report a topic shift.
 *
 * Design decisions:
 *   - Keyword search only (no semantic) — fast, no embedding requirement
 *   - Works with or without an active daemon (direct DB access path)
 *   - Stateless: callers supply currentProject; detector has no session memory
 *   - Minimal: returns a plain result object, not MCP content arrays
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend } from "../storage/interface.js";
import { searchMemory, populateSlugs } from "../memory/search.js";
import type { SearchResult } from "../memory/search.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopicCheckParams {
  /** Recent conversation context (a few sentences or tool call summaries) */
  context: string;
  /** The project slug the session is currently routed to. May be null/empty. */
  currentProject?: string;
  /**
   * Minimum confidence [0,1] to declare a shift. Default: 0.6.
   * Higher = less sensitive, fewer false positives.
   */
  threshold?: number;
  /**
   * Maximum results to draw from memory search (candidates). Default: 20.
   * More candidates = more accurate scoring, slightly slower.
   */
  candidates?: number;
}

export interface TopicCheckResult {
  /** Whether a significant topic shift was detected. */
  shifted: boolean;
  /** The project slug the session is currently routed to (echoed from input). */
  currentProject: string | null;
  /** The project slug that best matches the context, or null if no clear match. */
  suggestedProject: string | null;
  /**
   * Confidence score for the suggested project [0,1].
   * Represents the fraction of total score mass held by the top project.
   * 1.0 = all matching chunks belong to one project.
   * 0.5 = two projects are equally matched.
   */
  confidence: number;
  /** Number of memory chunks that contributed to scoring. */
  chunkCount: number;
  /** Top-3 scoring projects with their normalised scores (for debugging). */
  topProjects: Array<{ slug: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/**
 * Detect whether the provided context text best matches a different project
 * than the session's current routing.
 *
 * Works with either a raw SQLite Database or a StorageBackend.
 * For the StorageBackend path, keyword search is used.
 * For the raw Database path (legacy/direct), searchMemory() is called.
 */
export async function detectTopicShift(
  registryDb: Database,
  federation: Database | StorageBackend,
  params: TopicCheckParams
): Promise<TopicCheckResult> {
  const threshold = params.threshold ?? 0.6;
  const candidates = params.candidates ?? 20;
  const currentProject = params.currentProject?.trim() || null;

  if (!params.context || params.context.trim().length === 0) {
    return {
      shifted: false,
      currentProject,
      suggestedProject: null,
      confidence: 0,
      chunkCount: 0,
      topProjects: [],
    };
  }

  // -------------------------------------------------------------------------
  // Run memory search across ALL projects (no project filter)
  // -------------------------------------------------------------------------

  let results: SearchResult[];

  const isBackend = (x: Database | StorageBackend): x is StorageBackend =>
    "backendType" in x;

  if (isBackend(federation)) {
    results = await federation.searchKeyword(params.context, {
      maxResults: candidates,
    });
  } else {
    results = searchMemory(federation, params.context, {
      maxResults: candidates,
    });
  }

  if (results.length === 0) {
    return {
      shifted: false,
      currentProject,
      suggestedProject: null,
      confidence: 0,
      chunkCount: 0,
      topProjects: [],
    };
  }

  // Populate project slugs from the registry
  const withSlugs = populateSlugs(results, registryDb);

  // -------------------------------------------------------------------------
  // Score projects by summing BM25 scores of matching chunks
  // -------------------------------------------------------------------------

  const projectScores = new Map<string, number>();

  for (const r of withSlugs) {
    const slug = r.projectSlug;
    if (!slug) continue;
    projectScores.set(slug, (projectScores.get(slug) ?? 0) + r.score);
  }

  if (projectScores.size === 0) {
    return {
      shifted: false,
      currentProject,
      suggestedProject: null,
      confidence: 0,
      chunkCount: withSlugs.length,
      topProjects: [],
    };
  }

  // Sort by total score descending
  const ranked = Array.from(projectScores.entries())
    .sort((a, b) => b[1] - a[1]);

  const totalScore = ranked.reduce((sum, [, s]) => sum + s, 0);

  // Top-3 for reporting (normalised to [0,1] fraction of total mass)
  const topProjects = ranked.slice(0, 3).map(([slug, score]) => ({
    slug,
    score: totalScore > 0 ? score / totalScore : 0,
  }));

  const topSlug = ranked[0][0];
  const topRawScore = ranked[0][1];
  const confidence = totalScore > 0 ? topRawScore / totalScore : 0;

  // -------------------------------------------------------------------------
  // Determine if a shift occurred
  // -------------------------------------------------------------------------

  // A shift is detected when:
  //   1. confidence >= threshold (the top project dominates)
  //   2. The top project is different from currentProject
  //   3. There is a currentProject to compare against
  //      (if no current project, we still return the best match but no "shift")

  const isDifferent =
    currentProject !== null &&
    topSlug !== currentProject;

  const shifted = isDifferent && confidence >= threshold;

  return {
    shifted,
    currentProject,
    suggestedProject: topSlug,
    confidence,
    chunkCount: withSlugs.length,
    topProjects,
  };
}
