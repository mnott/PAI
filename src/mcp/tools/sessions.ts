/**
 * MCP tool handlers: session_list, session_route
 */

import type { StorageBackend } from "../../storage/interface.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";
import {
  lookupProjectId,
  type ToolResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool: session_list
// ---------------------------------------------------------------------------

export interface SessionListParams {
  project: string;
  limit?: number;
  status?: "open" | "completed" | "compacted";
}

export async function toolSessionList(
  registry: RegistryBackend,
  params: SessionListParams
): Promise<ToolResult> {
  try {
    const projectId = await lookupProjectId(registry, params.project);
    if (projectId == null) {
      return {
        content: [
          { type: "text", text: `Project not found: ${params.project}` },
        ],
        isError: true,
      };
    }

    const limit = params.limit ?? 10;
    const sessions = await registry.listSessions({
      projectId,
      status: params.status,
      limit,
    });

    if (sessions.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No sessions found for project: ${params.project}`,
          },
        ],
      };
    }

    const lines = sessions.map(
      (s) =>
        `#${String(s.number).padStart(4, "0")}  ${s.date}  [${s.status}]  ${s.title}\n        file: Notes/${s.filename}`
    );

    return {
      content: [
        {
          type: "text",
          text: `${sessions.length} session(s) for ${params.project}:\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `session_list error: ${String(e)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: session_route
// ---------------------------------------------------------------------------

export interface SessionRouteParams {
  /** Working directory to route from (defaults to process.cwd()) */
  cwd?: string;
  /** Optional conversation context for topic-based fallback routing */
  context?: string;
}

/**
 * Automatically suggest which project a session belongs to.
 *
 * Strategy (in priority order):
 *   1. path   — exact or parent-directory match in the project registry
 *   2. marker — walk up from cwd looking for Notes/PAI.md
 *   3. topic  — BM25 keyword search against memory (requires context)
 *
 * Call this at session start (e.g., from CLAUDE.md or a session-start hook)
 * to automatically route the session to the correct project.
 */
export async function toolSessionRoute(
  registry: RegistryBackend,
  federation: StorageBackend,
  params: SessionRouteParams
): Promise<ToolResult> {
  try {
    const { autoRoute, formatAutoRouteJson } = await import("../../session/auto-route.js");

    const result = await autoRoute(
      registry,
      federation,
      params.cwd,
      params.context
    );

    if (!result) {
      const target = params.cwd ?? process.cwd();
      return {
        content: [
          {
            type: "text",
            text: [
              `No project match found for: ${target}`,
              "",
              "Tried: path match, PAI.md marker walk" +
                (params.context ? ", topic detection" : ""),
              "",
              "Run 'pai project add .' to register this directory,",
              "or provide conversation context for topic-based routing.",
            ].join("\n"),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: formatAutoRouteJson(result) }],
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: `session_route error: ${String(e)}` }],
      isError: true,
    };
  }
}
