/**
 * MCP tool handlers: observation_search, observation_timeline
 */

import type { StorageBackend } from "../../storage/interface.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";
import {
  lookupProjectId,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool: observation_search
// ---------------------------------------------------------------------------

export interface ObservationSearchParams {
  query?: string;
  project?: string;
  type?: string;
  limit?: number;
}

/**
 * Search PAI observations by project, type, and optional text query.
 * Text matching is applied post-query against title and narrative fields.
 */
export async function toolObservationSearch(
  backend: StorageBackend,
  registry: RegistryBackend,
  params: ObservationSearchParams
): Promise<ToolResult> {
  try {
    let projectId: number | undefined;
    if (params.project) {
      const id = await lookupProjectId(registry, params.project);
      if (id == null) {
        return {
          content: [{ type: "text", text: `Project not found: ${params.project}` }],
          isError: true,
        };
      }
      projectId = id;
    }

    const rows = await backend.queryObservations({
      projectId,
      type: params.type,
      limit: (params.limit ?? 20) * (params.query ? 5 : 1), // over-fetch when filtering
    });

    // Apply text filter in-process (case-insensitive substring match)
    const filtered = params.query
      ? rows.filter((r) => {
          const q = params.query!.toLowerCase();
          return (
            r.title.toLowerCase().includes(q) ||
            (r.narrative ?? "").toLowerCase().includes(q)
          );
        }).slice(0, params.limit ?? 20)
      : rows.slice(0, params.limit ?? 20);

    if (filtered.length === 0) {
      return {
        content: [{ type: "text", text: "No observations found matching the given filters." }],
      };
    }

    const lines: string[] = [`Found ${filtered.length} observation(s):\n`];
    for (const obs of filtered) {
      lines.push(`[${obs.type.toUpperCase()}] ${obs.title}`);
      if (obs.project_slug) lines.push(`  project: ${obs.project_slug}`);
      if (obs.tool_name) lines.push(`  tool: ${obs.tool_name}`);
      lines.push(`  session: ${obs.session_id}`);
      lines.push(`  at: ${new Date(obs.created_at).toISOString()}`);
      if (obs.narrative) lines.push(`  ${obs.narrative}`);
      lines.push("");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `observation_search error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: observation_timeline
// ---------------------------------------------------------------------------

export interface ObservationTimelineParams {
  project?: string;
  session_id?: string;
  limit?: number;
}

/**
 * Return a chronological timeline of observations, grouped by session.
 * If session_id is provided, shows that session's observations in order.
 * If project is provided, shows recent observations for the project grouped by session.
 */
export async function toolObservationTimeline(
  backend: StorageBackend,
  registry: RegistryBackend,
  params: ObservationTimelineParams
): Promise<ToolResult> {
  try {
    const limit = params.limit ?? 50;

    if (params.session_id) {
      // Single session: chronological order
      const rows = await backend.querySessionObservations(params.session_id);
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No observations found for session: ${params.session_id}` }],
        };
      }

      const lines: string[] = [
        `Timeline for session ${params.session_id} (${rows.length} observations):\n`,
      ];
      for (const obs of rows) {
        const ts = new Date(obs.created_at).toISOString();
        lines.push(`${ts}  [${obs.type}]  ${obs.title}`);
        if (obs.narrative) lines.push(`    ${obs.narrative}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // Project-scoped or global: fetch recent, group by session
    let rows;
    if (params.project) {
      const id = await lookupProjectId(registry, params.project);
      if (id == null) {
        return {
          content: [{ type: "text", text: `Project not found: ${params.project}` }],
          isError: true,
        };
      }
      rows = await backend.queryRecentObservations(id, limit);
    } else {
      rows = await backend.queryObservations({ limit });
    }

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No observations found." }],
      };
    }

    // Group by session_id preserving encountered order (already DESC by created_at)
    const sessions = new Map<string, typeof rows>();
    for (const obs of rows) {
      const bucket = sessions.get(obs.session_id) ?? [];
      bucket.push(obs);
      sessions.set(obs.session_id, bucket);
    }

    const lines: string[] = [
      `Timeline: ${rows.length} observation(s) across ${sessions.size} session(s)\n`,
    ];

    for (const [sessionId, sessionObs] of sessions) {
      const firstObs = sessionObs[sessionObs.length - 1]; // oldest in bucket
      const slug = firstObs.project_slug ?? "unknown";
      lines.push(`--- Session ${sessionId} (project: ${slug}) ---`);
      // Show in chronological order within session
      const sorted = [...sessionObs].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      for (const obs of sorted) {
        const ts = new Date(obs.created_at).toISOString();
        lines.push(`  ${ts}  [${obs.type}]  ${obs.title}`);
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `observation_timeline error: ${String(e)}` }],
      isError: true,
    };
  }
}
