/**
 * Auto-route: automatic project routing suggestion on session start.
 *
 * Given a working directory (and optional conversation context), determine
 * which registered project the session belongs to.
 *
 * Strategy (in priority order):
 *   1. Path match   — exact or parent-directory match in the project registry
 *   2. Marker walk  — walk up from cwd looking for Notes/PAI.md, resolve slug
 *   3. Topic match  — BM25 keyword search against memory (requires context text)
 *
 * The function is stateless and works with direct DB access (no daemon
 * required), making it fast and safe to call during session startup.
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend } from "../storage/interface.js";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readPaiMarker } from "../registry/pai-marker.js";
import { detectProject } from "../cli/commands/detect.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoRouteMethod = "path" | "marker" | "topic";

export interface AutoRouteResult {
  /** Project slug */
  slug: string;
  /** Human-readable project name */
  display_name: string;
  /** Absolute path to the project root */
  root_path: string;
  /** How the project was detected */
  method: AutoRouteMethod;
  /** Confidence [0,1]: 1.0 for path/marker matches, BM25 fraction for topic */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Determine which project a session should be routed to.
 *
 * @param registryDb  Open PAI registry database
 * @param federation  Memory storage backend (needed only for topic fallback)
 * @param cwd         Working directory to detect from (defaults to process.cwd())
 * @param context     Optional conversation text for topic-based fallback
 * @returns           Best project match, or null if nothing matched
 */
export async function autoRoute(
  registryDb: Database,
  federation: Database | StorageBackend,
  cwd?: string,
  context?: string
): Promise<AutoRouteResult | null> {
  const target = resolve(cwd ?? process.cwd());

  // -------------------------------------------------------------------------
  // Strategy 1: Path match via registry
  // -------------------------------------------------------------------------

  const pathMatch = detectProject(registryDb, target);

  if (pathMatch) {
    return {
      slug: pathMatch.slug,
      display_name: pathMatch.display_name,
      root_path: pathMatch.root_path,
      method: "path",
      confidence: 1.0,
    };
  }

  // -------------------------------------------------------------------------
  // Strategy 2: PAI.md marker file walk
  //
  // Walk up from cwd, checking <dir>/Notes/PAI.md at each level.
  // Once found, resolve the slug against the registry to get full project info.
  // -------------------------------------------------------------------------

  const markerResult = findMarkerUpward(registryDb, target);
  if (markerResult) {
    return markerResult;
  }

  // -------------------------------------------------------------------------
  // Strategy 3: Topic detection (requires context text)
  // -------------------------------------------------------------------------

  if (context && context.trim().length > 0) {
    // Lazy import to avoid bundler pulling in daemon/index.mjs at module load time
    const { detectTopicShift } = await import("../topics/detector.js");
    const topicResult = await detectTopicShift(registryDb, federation, {
      context,
      threshold: 0.5, // Lower threshold for initial routing (vs shift detection)
    });

    if (topicResult.suggestedProject && topicResult.confidence > 0) {
      // Look up the full project info from the registry
      const projectRow = registryDb
        .prepare(
          "SELECT slug, display_name, root_path FROM projects WHERE slug = ? AND status != 'archived'"
        )
        .get(topicResult.suggestedProject) as
        | { slug: string; display_name: string; root_path: string }
        | undefined;

      if (projectRow) {
        return {
          slug: projectRow.slug,
          display_name: projectRow.display_name,
          root_path: projectRow.root_path,
          method: "topic",
          confidence: topicResult.confidence,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Marker walk helper
// ---------------------------------------------------------------------------

/**
 * Walk up the directory tree from `startDir`, checking each level for a
 * `Notes/PAI.md` file. If found, read the slug and look up the project.
 *
 * Stops at the filesystem root or after 20 levels (safety guard).
 */
function findMarkerUpward(
  registryDb: Database,
  startDir: string
): AutoRouteResult | null {
  let current = startDir;
  let depth = 0;

  while (depth < 20) {
    const markerPath = `${current}/Notes/PAI.md`;

    if (existsSync(markerPath)) {
      const marker = readPaiMarker(current);

      if (marker && marker.status !== "archived") {
        // Resolve slug to full project info in the registry
        const projectRow = registryDb
          .prepare(
            "SELECT slug, display_name, root_path FROM projects WHERE slug = ? AND status != 'archived'"
          )
          .get(marker.slug) as
          | { slug: string; display_name: string; root_path: string }
          | undefined;

        if (projectRow) {
          return {
            slug: projectRow.slug,
            display_name: projectRow.display_name,
            root_path: projectRow.root_path,
            method: "marker",
            confidence: 1.0,
          };
        }
      }
    }

    const parent = dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
    depth++;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format an AutoRouteResult as a human-readable string for CLI output.
 */
export function formatAutoRoute(result: AutoRouteResult): string {
  const lines: string[] = [
    `slug:         ${result.slug}`,
    `display_name: ${result.display_name}`,
    `root_path:    ${result.root_path}`,
    `method:       ${result.method}`,
    `confidence:   ${(result.confidence * 100).toFixed(0)}%`,
  ];
  return lines.join("\n");
}

/**
 * Format an AutoRouteResult as JSON for machine consumption.
 */
export function formatAutoRouteJson(result: AutoRouteResult): string {
  return JSON.stringify(result, null, 2);
}
