/**
 * MCP tool handler: memory_taxonomy
 *
 * Returns the SHAPE of stored memory without requiring a query.
 * Answers "what do I know about?" not "what do I know about X?"
 */

import type { Database } from "better-sqlite3";
import type { StorageBackend } from "../../storage/interface.js";
import { getTaxonomy } from "../../memory/taxonomy.js";
import type { ToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool: memory_taxonomy
// ---------------------------------------------------------------------------

export interface MemoryTaxonomyParams {
  /** Include archived projects in the result. Default: false. */
  include_archived?: boolean;
  /** Maximum number of projects to return. Default: 50. */
  limit?: number;
}

export async function toolMemoryTaxonomy(
  registryDb: Database,
  storage: StorageBackend,
  params: MemoryTaxonomyParams = {}
): Promise<ToolResult> {
  try {
    const result = await getTaxonomy(registryDb, storage, {
      include_archived: params.include_archived,
      limit: params.limit,
    });

    // -----------------------------------------------------------------------
    // Format output as human-readable text
    // -----------------------------------------------------------------------

    const lines: string[] = [];

    // Totals header
    lines.push(
      `PAI Memory Taxonomy — ${result.totals.projects} project(s), ` +
        `${result.totals.sessions} session(s), ` +
        `${result.totals.notes} indexed file(s), ` +
        `${result.totals.chunks} chunk(s)`
    );
    lines.push("");

    // Per-project breakdown
    if (result.projects.length === 0) {
      lines.push("No active projects found.");
    } else {
      lines.push("Projects:");
      for (const p of result.projects) {
        const tagStr = p.top_tags.length > 0 ? ` [${p.top_tags.join(", ")}]` : "";
        const activityStr = p.last_activity ? ` last: ${p.last_activity}` : "";
        lines.push(
          `  ${p.slug} — ${p.display_name}` +
            `  sessions=${p.session_count}` +
            (p.note_count > 0 ? ` files=${p.note_count}` : "") +
            activityStr +
            tagStr
        );
      }
    }

    // Recent activity
    if (result.recent_activity.length > 0) {
      lines.push("");
      lines.push("Recent activity (last 10 sessions across all projects):");
      for (const a of result.recent_activity) {
        lines.push(`  ${a.timestamp}  ${a.project_slug}  ${a.action}`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `memory_taxonomy error: ${String(e)}` }],
      isError: true,
    };
  }
}
