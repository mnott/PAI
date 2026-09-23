/**
 * MCP tool handler: registry_search
 */

import type { RegistryBackend } from "../../storage/registry-interface.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool: registry_search
// ---------------------------------------------------------------------------

export interface RegistrySearchParams {
  query: string;
}

export async function toolRegistrySearch(
  registry: RegistryBackend,
  params: RegistrySearchParams
): Promise<ToolResult> {
  try {
    const projects = await registry.searchProjects(params.query, 20);

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
