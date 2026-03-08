/**
 * PAI Knowledge OS — MCP tool handlers (barrel re-export)
 *
 * All tool implementations have been split into domain modules under
 * src/mcp/tools/. This file re-exports everything so existing imports
 * (from "../mcp/tools.js") continue to work unchanged.
 *
 * Domain modules:
 *   tools/types.ts         — shared types + project-row helpers
 *   tools/memory.ts        — memory_search, memory_get
 *   tools/projects.ts      — project_info, project_list, project_detect,
 *                            project_health, project_todo
 *   tools/sessions.ts      — session_list, session_route
 *   tools/registry.ts      — registry_search
 *   tools/notifications.ts — notification_config
 *   tools/topics.ts        — topic_detect
 *   tools/zettel.ts        — zettel_explore, zettel_health, zettel_surprise,
 *                            zettel_suggest, zettel_converse, zettel_themes
 *   tools/observations.ts  — observation_search, observation_timeline
 */

export * from "./tools/index.js";
