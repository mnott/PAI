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
import { registryDb, storageBackend, daemonConfig } from "./state.js";
import type { PostgresBackendWithPool } from "./types.js";

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
      return toolMemorySearch(registryDb, storageBackend, p as Parameters<typeof toolMemorySearch>[2]);

    case "memory_get":
      return toolMemoryGet(registryDb, p as Parameters<typeof toolMemoryGet>[1]);

    case "project_info":
      return toolProjectInfo(registryDb, p as Parameters<typeof toolProjectInfo>[1]);

    case "project_list":
      return toolProjectList(registryDb, p as Parameters<typeof toolProjectList>[1]);

    case "session_list":
      return toolSessionList(registryDb, p as Parameters<typeof toolSessionList>[1]);

    case "registry_search":
      return toolRegistrySearch(registryDb, p as Parameters<typeof toolRegistrySearch>[1]);

    case "project_detect":
      return toolProjectDetect(registryDb, p as Parameters<typeof toolProjectDetect>[1]);

    case "project_health":
      return toolProjectHealth(registryDb, p as Parameters<typeof toolProjectHealth>[1]);

    case "project_todo":
      return toolProjectTodo(registryDb, p as Parameters<typeof toolProjectTodo>[1]);

    case "memory_wakeup":
      return toolMemoryWakeup(registryDb, p as Parameters<typeof toolMemoryWakeup>[1]);

    case "memory_taxonomy":
      return toolMemoryTaxonomy(registryDb, storageBackend, p as Parameters<typeof toolMemoryTaxonomy>[2]);

    case "topic_check":
      return detectTopicShift(
        registryDb,
        storageBackend,
        p as Parameters<typeof detectTopicShift>[2]
      );

    case "session_auto_route":
      return toolSessionRoute(
        registryDb,
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
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;
      return handleGraphClusters(pgPool, storageBackend, p as Parameters<typeof handleGraphClusters>[2]);
    }

    case "graph_neighborhood": {
      const { handleGraphNeighborhood } = await import("../../graph/neighborhood.js");
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;
      return handleGraphNeighborhood(pgPool, storageBackend, p as Parameters<typeof handleGraphNeighborhood>[2]);
    }

    case "graph_note_context": {
      const { handleGraphNoteContext } = await import("../../graph/note-context.js");
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;
      return handleGraphNoteContext(pgPool, storageBackend, p as Parameters<typeof handleGraphNoteContext>[2]);
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
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;
      if (!pgPool) {
        throw new Error(`${method} requires a Postgres storage backend`);
      }
      switch (method) {
        case "kg_add":           return toolKgAdd(pgPool, p as Parameters<typeof toolKgAdd>[1]);
        case "kg_query":         return toolKgQuery(pgPool, p as Parameters<typeof toolKgQuery>[1]);
        case "kg_invalidate":    return toolKgInvalidate(pgPool, p as Parameters<typeof toolKgInvalidate>[1]);
        case "kg_contradictions": return toolKgContradictions(pgPool, p as Parameters<typeof toolKgContradictions>[1]);
      }
      break;
    }

    case "memory_tunnels": {
      const { toolMemoryTunnels } = await import("../../mcp/tools.js");
      return toolMemoryTunnels(registryDb, storageBackend, p as Parameters<typeof toolMemoryTunnels>[2]);
    }

    case "memory_feedback": {
      // MR2: feedback weight loop — requires SQLite federation db
      const federationDb = (storageBackend as { getSqliteDb?: () => import("better-sqlite3").Database }).getSqliteDb?.();
      if (!federationDb) {
        throw new Error("memory_feedback requires a SQLite federation backend (getSqliteDb not available)");
      }
      return toolMemoryFeedback(federationDb, p as Parameters<typeof toolMemoryFeedback>[1]);
    }

    case "memory_kg_search": {
      // MR1: graph-completion retrieval — requires SQLite federation db + Postgres pool
      const federationDb = (storageBackend as { getSqliteDb?: () => import("better-sqlite3").Database }).getSqliteDb?.();
      if (!federationDb) {
        throw new Error("memory_kg_search requires a SQLite federation backend (getSqliteDb not available)");
      }
      const pgPool = (storageBackend as PostgresBackendWithPool).getPool?.() ?? null;
      if (!pgPool) {
        throw new Error("memory_kg_search requires a Postgres storage backend for KG triple expansion");
      }
      return toolMemoryKgSearch(federationDb, pgPool, p as Parameters<typeof toolMemoryKgSearch>[2]);
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
