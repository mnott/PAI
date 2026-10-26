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
    // All statuses (what `pai project list --all` reads); curated names come from
    // listNamedProjects for active rows and listAliasesForProject for the rest.
    const all = await registry.listProjectsWithSessionStats({ orderBy: "updated_desc" });
    const needle = normalize(params.query);

    const activeNames = new Map<number, string[]>();
    for (const r of await registry.listNamedProjects({ includeUnnamed: false })) {
      if (r.name) activeNames.set(r.id, [...(activeNames.get(r.id) ?? []), r.name]);
    }

    const matches = [];
    for (const p of all) {
      if (!needle) break;
      const names = p.status === "active" ? activeNames.get(p.id) ?? [] : await registry.listAliasesForProject(p.id);
      if ([p.slug, p.display_name, p.root_path, ...names].some((f) => normalize(f ?? "").includes(needle))) {
        matches.push({ ...p, names });
      }
    }
    // Active first, archived after; each group stays newest-first.
    const projects = [...matches.filter((p) => p.status === "active"), ...matches.filter((p) => p.status !== "active")].slice(0, 20);

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
      (p) => `${p.slug}  [${p.status === "archived" ? `archived${p.archived_at ? " " + new Date(p.archived_at).toISOString().slice(0, 10) : ""}` : p.status}]  names: ${p.names.length ? p.names.join(", ") : "-"}  ${p.root_path}`
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
