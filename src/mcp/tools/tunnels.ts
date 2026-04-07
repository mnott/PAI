/**
 * MCP tool handler: memory_tunnels
 *
 * Finds "tunnels" — concepts that appear across multiple projects —
 * surfacing cross-project serendipitous connections in the PAI memory graph.
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend } from "../../storage/interface.js";
import type { ToolResult } from "./types.js";
import { findTunnels } from "../../memory/tunnels.js";

// ---------------------------------------------------------------------------
// Tool: memory_tunnels
// ---------------------------------------------------------------------------

export interface MemoryTunnelsParams {
  /** Minimum distinct projects a concept must appear in. Default 2. */
  min_projects?: number;
  /** Minimum total chunk occurrences across all projects. Default 3. */
  min_occurrences?: number;
  /** Maximum number of tunnels to return. Default 20. */
  limit?: number;
}

export async function toolMemoryTunnels(
  registryDb: Database,
  backend: StorageBackend,
  params: MemoryTunnelsParams
): Promise<ToolResult> {
  try {
    const result = await findTunnels(backend, registryDb, {
      min_projects: params.min_projects,
      min_occurrences: params.min_occurrences,
      limit: params.limit,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `memory_tunnels error: ${String(e)}` }],
      isError: true,
    };
  }
}
