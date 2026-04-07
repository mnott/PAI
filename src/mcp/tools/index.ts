/**
 * MCP tool handler barrel — re-exports all tool functions and types.
 *
 * Domain modules:
 *   types.ts         — shared types (ToolContent, ToolResult, ProjectRow) and helpers
 *   memory.ts        — memory_search, memory_get
 *   projects.ts      — project_info, project_list, project_detect, project_health, project_todo
 *   sessions.ts      — session_list, session_route
 *   registry.ts      — registry_search
 *   notifications.ts — notification_config
 *   topics.ts        — topic_detect
 *   zettel.ts        — zettel_explore, zettel_health, zettel_surprise, zettel_suggest,
 *                      zettel_converse, zettel_themes, zettel_god_notes, zettel_communities
 *   observations.ts  — observation_search, observation_timeline
 *   wakeup.ts        — memory_wakeup (L0+L1 wake-up context)
 *   taxonomy.ts      — memory_taxonomy (structural overview of stored memory)
 *   tunnels.ts       — memory_tunnels (cross-project concept connections)
 */

export * from "./types.js";
export * from "./memory.js";
export * from "./projects.js";
export * from "./sessions.js";
export * from "./registry.js";
export * from "./notifications.js";
export * from "./topics.js";
export * from "./zettel.js";
export * from "./observations.js";
export * from "./kg.js";
export * from "./wakeup.js";
export * from "./taxonomy.js";
export * from "./tunnels.js";
