/**
 * MCP tool handler: registry_search
 */

import type { Database } from "better-sqlite3";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool: registry_search
// ---------------------------------------------------------------------------

export interface RegistrySearchParams {
  query: string;
}

export function toolRegistrySearch(
  registryDb: Database,
  params: RegistrySearchParams
): ToolResult {
  try {
    const q = `%${params.query}%`;
    const projects = registryDb
      .prepare(
        `SELECT id, slug, display_name, root_path, type, status, updated_at
         FROM projects
         WHERE slug LIKE ?
            OR display_name LIKE ?
            OR root_path LIKE ?
         ORDER BY updated_at DESC
         LIMIT 20`
      )
      .all(q, q, q) as Array<{
      id: number;
      slug: string;
      display_name: string;
      root_path: string;
      type: string;
      status: string;
      updated_at: number;
    }>;

    if (projects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No projects found matching: "${params.query}"`,
          },
        ],
      };
    }

    const lines = projects.map((p) => `${p.slug}  [${p.status}]  ${p.root_path}`);

    return {
      content: [
        {
          type: "text",
          text: `${projects.length} match(es) for "${params.query}":\n\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [
        { type: "text", text: `registry_search error: ${String(e)}` },
      ],
      isError: true,
    };
  }
}
