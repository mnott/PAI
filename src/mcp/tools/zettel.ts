/**
 * MCP tool handlers: zettel_explore, zettel_health, zettel_surprise,
 *                    zettel_suggest, zettel_converse, zettel_themes
 */

import type { StorageBackend } from "../../storage/interface.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool: zettel_explore
// ---------------------------------------------------------------------------

export interface ZettelExploreParams {
  start_note: string;
  depth?: number;
  direction?: string;
  mode?: string;
}

export async function toolZettelExplore(
  backend: StorageBackend,
  params: ZettelExploreParams
): Promise<ToolResult> {
  try {
    const { zettelExplore } = await import("../../zettelkasten/index.js");
    const result = await zettelExplore(backend, {
      startNote: params.start_note,
      depth: params.depth,
      direction: params.direction as "forward" | "backward" | "both" | undefined,
      mode: params.mode as "sequential" | "associative" | "all" | undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_explore error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: zettel_health
// ---------------------------------------------------------------------------

export interface ZettelHealthParams {
  scope?: string;
  project_path?: string;
  recent_days?: number;
  include?: string[];
}

export async function toolZettelHealth(
  backend: StorageBackend,
  params: ZettelHealthParams
): Promise<ToolResult> {
  try {
    const { zettelHealth } = await import("../../zettelkasten/index.js");
    const result = await zettelHealth(backend, {
      scope: params.scope as "full" | "recent" | "project" | undefined,
      projectPath: params.project_path,
      recentDays: params.recent_days,
      include: params.include as Array<"dead_links" | "orphans" | "disconnected" | "low_connectivity"> | undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_health error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: zettel_surprise
// ---------------------------------------------------------------------------

export interface ZettelSurpriseParams {
  reference_path: string;
  vault_project_id: number;
  limit?: number;
  min_similarity?: number;
  min_graph_distance?: number;
}

export async function toolZettelSurprise(
  backend: StorageBackend,
  params: ZettelSurpriseParams
): Promise<ToolResult> {
  try {
    const { zettelSurprise } = await import("../../zettelkasten/index.js");
    const results = await zettelSurprise(backend, {
      referencePath: params.reference_path,
      vaultProjectId: params.vault_project_id,
      limit: params.limit,
      minSimilarity: params.min_similarity,
      minGraphDistance: params.min_graph_distance,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_surprise error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: zettel_suggest
// ---------------------------------------------------------------------------

export interface ZettelSuggestParams {
  note_path: string;
  vault_project_id: number;
  limit?: number;
  exclude_linked?: boolean;
}

export async function toolZettelSuggest(
  backend: StorageBackend,
  params: ZettelSuggestParams
): Promise<ToolResult> {
  try {
    const { zettelSuggest } = await import("../../zettelkasten/index.js");
    const results = await zettelSuggest(backend, {
      notePath: params.note_path,
      vaultProjectId: params.vault_project_id,
      limit: params.limit,
      excludeLinked: params.exclude_linked,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_suggest error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: zettel_converse
// ---------------------------------------------------------------------------

export interface ZettelConverseParams {
  question: string;
  vault_project_id: number;
  depth?: number;
  limit?: number;
}

export async function toolZettelConverse(
  backend: StorageBackend,
  params: ZettelConverseParams
): Promise<ToolResult> {
  try {
    const { zettelConverse } = await import("../../zettelkasten/index.js");
    const result = await zettelConverse(backend, {
      question: params.question,
      vaultProjectId: params.vault_project_id,
      depth: params.depth,
      limit: params.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_converse error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: zettel_themes
// ---------------------------------------------------------------------------

export interface ZettelThemesParams {
  vault_project_id: number;
  lookback_days?: number;
  min_cluster_size?: number;
  max_themes?: number;
  similarity_threshold?: number;
}

export async function toolZettelThemes(
  backend: StorageBackend,
  params: ZettelThemesParams
): Promise<ToolResult> {
  try {
    const { zettelThemes } = await import("../../zettelkasten/index.js");
    const result = await zettelThemes(backend, {
      vaultProjectId: params.vault_project_id,
      lookbackDays: params.lookback_days,
      minClusterSize: params.min_cluster_size,
      maxThemes: params.max_themes,
      similarityThreshold: params.similarity_threshold,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `zettel_themes error: ${String(e)}` }],
      isError: true,
    };
  }
}
