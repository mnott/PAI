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

/** Lowercase and drop everything but letters/digits, so case, emoji, spaces and dashes don't matter. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export async function toolRegistrySearch(
  registry: RegistryBackend,
  params: RegistrySearchParams
): Promise<ToolResult> {
  try {
    // Same query `pai project names --all` runs: one row per (project, alias).
    const rows = await registry.listNamedProjects({ includeUnnamed: true });
    const needle = normalize(params.query);

    const byId = new Map<number, { slug: string; status: string; root_path: string; display_name: string; names: string[] }>();
    for (const r of rows) {
      let p = byId.get(r.id);
      if (!p) {
        p = { slug: r.slug, status: r.status, root_path: r.root_path, display_name: r.display_name, names: [] };
        byId.set(r.id, p);
      }
      if (r.name) p.names.push(r.name);
    }

    const projects = needle
      ? [...byId.values()]
          .filter((p) => [p.slug, p.display_name, p.root_path, ...p.names].some((f) => normalize(f ?? "").includes(needle)))
          .slice(0, 20)
      : [];

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

    const lines = projects.map(
      (p) => `${p.slug}  [${p.status}]  names: ${p.names.length ? p.names.join(", ") : "-"}  ${p.root_path}`
    );

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
