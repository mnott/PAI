/**
 * Tool dispatcher — maps IPC method names to PAI tool functions.
 */

import {
  toolMemorySearch,
  toolMemoryGet,
  toolProjectInfo,
  toolProjectList,
  toolSessionList,
  toolRegistrySearch,
  toolProjectDetect,
  toolProjectHealth,
  toolProjectTodo,
  toolSessionRoute,
  toolMemoryWakeup,
  toolMemoryTaxonomy,
  toolMemoryFeedback,
  toolMemoryKgSearch,
} from "../../mcp/tools.js";
import { detectTopicShift } from "../../topics/detector.js";
import { registryBackend, storageBackend, daemonConfig } from "./state.js";

/**
 * Dispatch an IPC tool call to the appropriate tool function.
 * Returns the tool result or throws on unknown/failed methods.
 */
export async function dispatchTool(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  // Cast through unknown to satisfy TypeScript's strict overlap check on
  // Record<string, unknown> → specific param types. Runtime validation is
  // the responsibility of each tool function (they surface errors gracefully).
  const p = params as unknown;

  switch (method) {
    case "memory_search":
      return toolMemorySearch(registryBackend, storageBackend, p as Parameters<typeof toolMemorySearch>[2]);

    case "memory_get":
      return toolMemoryGet(registryBackend, p as Parameters<typeof toolMemoryGet>[1]);

    case "project_info":
      return toolProjectInfo(registryBackend, p as Parameters<typeof toolProjectInfo>[1]);

    case "project_list":
      return toolProjectList(registryBackend, p as Parameters<typeof toolProjectList>[1]);

    case "session_list":
      return toolSessionList(registryBackend, p as Parameters<typeof toolSessionList>[1]);

    case "registry_search":
      return toolRegistrySearch(registryBackend, p as Parameters<typeof toolRegistrySearch>[1]);

    case "project_detect":
      return toolProjectDetect(p as Parameters<typeof toolProjectDetect>[0]);

    case "project_health":
      return toolProjectHealth(registryBackend, p as Parameters<typeof toolProjectHealth>[1]);

    case "project_todo":
      return toolProjectTodo(registryBackend, p as Parameters<typeof toolProjectTodo>[1]);

    case "memory_wakeup":
      return toolMemoryWakeup(registryBackend, p as Parameters<typeof toolMemoryWakeup>[1]);

    case "memory_taxonomy":
      return toolMemoryTaxonomy(registryBackend, storageBackend, p as Parameters<typeof toolMemoryTaxonomy>[2]);

    case "topic_check":
      return detectTopicShift(
        registryBackend,
        storageBackend,
        p as Parameters<typeof detectTopicShift>[2]
      );

    case "session_auto_route":
      return toolSessionRoute(
        registryBackend,
        storageBackend,
        p as Parameters<typeof toolSessionRoute>[2]
      );

    case "zettel_explore":
    case "zettel_health":
    case "zettel_surprise":
    case "zettel_suggest":
    case "zettel_converse":
    case "zettel_themes":
    case "zettel_god_notes":
    case "zettel_communities": {
      const { toolZettelExplore, toolZettelHealth, toolZettelSurprise, toolZettelSuggest, toolZettelConverse, toolZettelThemes, toolZettelGodNotes, toolZettelCommunities } = await import("../../mcp/tools.js");

      switch (method) {
        case "zettel_explore": return toolZettelExplore(storageBackend, p as Parameters<typeof toolZettelExplore>[1]);
        case "zettel_health": return toolZettelHealth(storageBackend, p as Parameters<typeof toolZettelHealth>[1]);
        case "zettel_surprise": return toolZettelSurprise(storageBackend, p as Parameters<typeof toolZettelSurprise>[1]);
        case "zettel_suggest": return toolZettelSuggest(storageBackend, p as Parameters<typeof toolZettelSuggest>[1]);
        case "zettel_converse": return toolZettelConverse(storageBackend, p as Parameters<typeof toolZettelConverse>[1]);
        case "zettel_themes": return toolZettelThemes(storageBackend, p as Parameters<typeof toolZettelThemes>[1]);
        case "zettel_god_notes": return toolZettelGodNotes(storageBackend, p as Parameters<typeof toolZettelGodNotes>[1]);
        case "zettel_communities": return toolZettelCommunities(storageBackend, p as Parameters<typeof toolZettelCommunities>[1]);
      }
      break;
    }

    case "graph_clusters": {
      const { handleGraphClusters } = await import("../../graph/clusters.js");
      return handleGraphClusters(storageBackend, p as Parameters<typeof handleGraphClusters>[1]);
    }

    case "graph_neighborhood": {
      const { handleGraphNeighborhood } = await import("../../graph/neighborhood.js");
      return handleGraphNeighborhood(storageBackend, p as Parameters<typeof handleGraphNeighborhood>[1]);
    }

    case "graph_note_context": {
      const { handleGraphNoteContext } = await import("../../graph/note-context.js");
      return handleGraphNoteContext(storageBackend, p as Parameters<typeof handleGraphNoteContext>[1]);
    }

    case "graph_trace": {
      const { handleGraphTrace } = await import("../../graph/trace.js");
      return handleGraphTrace(storageBackend, p as Parameters<typeof handleGraphTrace>[1]);
    }

    case "graph_latent_ideas": {
      const { handleGraphLatentIdeas } = await import("../../graph/latent-ideas.js");
      return handleGraphLatentIdeas(storageBackend, p as Parameters<typeof handleGraphLatentIdeas>[1]);
    }

    case "idea_materialize": {
      const { handleIdeaMaterialize } = await import("../../graph/latent-ideas.js");
      if (!daemonConfig.vaultPath) {
        throw new Error("idea_materialize requires vaultPath to be configured in the daemon config");
      }
      return handleIdeaMaterialize(
        p as Parameters<typeof handleIdeaMaterialize>[0],
        daemonConfig.vaultPath
      );
    }

    case "kg_add":
    case "kg_query":
    case "kg_invalidate":
    case "kg_contradictions": {
      const { toolKgAdd, toolKgQuery, toolKgInvalidate, toolKgContradictions } = await import("../../mcp/tools.js");
      if (!storageBackend.supportsPostgresFeatures) {
        throw new Error(`${method} requires a Postgres storage backend`);
      }
      switch (method) {
        case "kg_add":           return toolKgAdd(storageBackend, p as Parameters<typeof toolKgAdd>[1]);
        case "kg_query":         return toolKgQuery(storageBackend, p as Parameters<typeof toolKgQuery>[1]);
        case "kg_invalidate":    return toolKgInvalidate(storageBackend, p as Parameters<typeof toolKgInvalidate>[1]);
        case "kg_contradictions": return toolKgContradictions(storageBackend, p as Parameters<typeof toolKgContradictions>[1]);
      }
      break;
    }

    case "memory_tunnels": {
      const { toolMemoryTunnels } = await import("../../mcp/tools.js");
      return toolMemoryTunnels(registryBackend, storageBackend, p as Parameters<typeof toolMemoryTunnels>[2]);
    }

    case "memory_feedback": {
      // MR2: feedback weight loop — relevance_score/feedback_weight go through
      // the StorageBackend, so this works on either backend.
      return await toolMemoryFeedback(storageBackend, p as Parameters<typeof toolMemoryFeedback>[1]);
    }

    case "memory_kg_search": {
      // MR1: graph-completion retrieval — active storage backend for KG triple expansion
      if (!storageBackend.supportsPostgresFeatures) {
        throw new Error("memory_kg_search requires a Postgres storage backend for KG triple expansion");
      }
      return await toolMemoryKgSearch(storageBackend, p as Parameters<typeof toolMemoryKgSearch>[1]);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
