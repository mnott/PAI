/**
 * PAI Knowledge OS — MCP Server (Phase 3)
 *
 * Exposes PAI registry and memory as MCP tools callable by Claude Code.
 *
 * Tools:
 *   memory_search   — BM25 search across indexed memory/notes
 *   memory_get      — Read a specific file or lines from a project
 *   project_info    — Get details for a project (by slug or current dir)
 *   project_list    — List projects with optional filters
 *   session_list    — List sessions for a project
 *   registry_search — Full-text search over project slugs/names/paths
 *   project_detect  — Detect which project a path belongs to
 *   project_health  — Audit all projects for moved/deleted directories
 *   session_route   — Auto-route session to project (path/marker/topic)
 *
 * NOTE: All tool logic lives in tools.ts (shared with the daemon).
 * This file wires MCP schema definitions to those pure functions.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openRegistry } from "../registry/db.js";
import { openFederation } from "../memory/db.js";
import {
  toolMemorySearch,
  toolMemoryGet,
  toolProjectInfo,
  toolProjectList,
  toolSessionList,
  toolRegistrySearch,
  toolProjectDetect,
  toolProjectHealth,
  toolNotificationConfig,
  toolTopicDetect,
  toolSessionRoute,
  toolZettelExplore,
  toolZettelHealth,
  toolZettelSurprise,
  toolZettelSuggest,
  toolZettelConverse,
  toolZettelThemes,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Database singletons (opened lazily, once per MCP server process)
// ---------------------------------------------------------------------------

let _registryDb: ReturnType<typeof openRegistry> | null = null;
let _federationDb: ReturnType<typeof openFederation> | null = null;

function getRegistryDb() {
  if (!_registryDb) _registryDb = openRegistry();
  return _registryDb;
}

function getFederationDb() {
  if (!_federationDb) _federationDb = openFederation();
  return _federationDb;
}

// ---------------------------------------------------------------------------
// MCP server startup
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "pai",
    version: "0.1.0",
  });

  // -------------------------------------------------------------------------
  // Tool: memory_search
  // -------------------------------------------------------------------------

  server.tool(
    "memory_search",
    [
      "Search PAI federated memory using BM25 full-text ranking, semantic similarity, or a hybrid of both.",
      "",
      "Use this BEFORE answering questions about past work, decisions, dates, people,",
      "preferences, project status, todos, technical choices, or anything that might",
      "have been recorded in session notes or memory files.",
      "",
      "Modes:",
      "  keyword  — BM25 full-text search (default, fast, no embeddings required)",
      "  semantic — Cosine similarity over vector embeddings (requires prior embed run)",
      "  hybrid   — Normalized combination of BM25 + cosine (best quality)",
      "",
      "Reranking is ON by default — results are re-scored with a cross-encoder model for better relevance.",
      "Set rerank=false to skip reranking (faster but less accurate ordering).",
      "",
      "Returns ranked snippets with project slug, file path, line range, and score.",
      "Higher score = more relevant.",
    ].join("\n"),
    {
      query: z
        .string()
        .describe("Free-text search query. Multiple words are ORed together — any matching word returns a result, ranked by relevance."),
      project: z
        .string()
        .optional()
        .describe(
          "Scope search to a single project by slug. Omit to search all projects."
        ),
      all_projects: z
        .boolean()
        .optional()
        .describe(
          "Explicitly search all projects (default behaviour when project is omitted)."
        ),
      sources: z
        .array(z.enum(["memory", "notes"]))
        .optional()
        .describe("Restrict to specific source types: 'memory' or 'notes'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum results to return. Default: 10."),
      mode: z
        .enum(["keyword", "semantic", "hybrid"])
        .optional()
        .describe(
          "Search mode: 'keyword' (BM25, default), 'semantic' (vector cosine), or 'hybrid' (both combined)."
        ),
      rerank: z
        .boolean()
        .optional()
        .describe(
          "Rerank results using a cross-encoder model for better relevance. Default: true. Set to false to skip reranking for faster but less accurate results."
        ),
    },
    async (args) => {
      const result = await toolMemorySearch(
        getRegistryDb(),
        getFederationDb(),
        args
      );
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: memory_get
  // -------------------------------------------------------------------------

  server.tool(
    "memory_get",
    [
      "Read the content of a specific file from a registered PAI project.",
      "",
      "Use this to read a full memory file, session note, or document after finding",
      "it via memory_search. Optionally restrict to a line range.",
      "",
      "The path must be a relative path within the project root (no ../ traversal).",
    ].join("\n"),
    {
      project: z
        .string()
        .describe("Project slug identifying which project's files to read from."),
      path: z
        .string()
        .describe(
          "Relative path within the project root (e.g. 'Notes/0001 - 2026-01-01 - Example.md')."
        ),
      from: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Starting line number (1-based, inclusive). Default: 1."),
      lines: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of lines to return. Default: entire file."),
    },
    async (args) => {
      const result = toolMemoryGet(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: project_info
  // -------------------------------------------------------------------------

  server.tool(
    "project_info",
    [
      "Get detailed information about a PAI registered project.",
      "",
      "Use this to look up a project's root path, type, status, tags, session count,",
      "and last active date. If no slug is provided, attempts to detect the current",
      "project from the caller's working directory.",
    ].join("\n"),
    {
      slug: z
        .string()
        .optional()
        .describe(
          "Project slug. Omit to auto-detect from the current working directory."
        ),
    },
    async (args) => {
      const result = toolProjectInfo(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: project_list
  // -------------------------------------------------------------------------

  server.tool(
    "project_list",
    [
      "List registered PAI projects with optional filters.",
      "",
      "Use this to browse all known projects, find projects by status or tag,",
      "or get a quick overview of the PAI registry.",
    ].join("\n"),
    {
      status: z
        .enum(["active", "archived", "migrating"])
        .optional()
        .describe("Filter by project status. Default: all statuses."),
      tag: z
        .string()
        .optional()
        .describe("Filter by tag name (exact match)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of projects to return. Default: 50."),
    },
    async (args) => {
      const result = toolProjectList(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: session_list
  // -------------------------------------------------------------------------

  server.tool(
    "session_list",
    [
      "List session notes for a PAI project.",
      "",
      "Use this to find what sessions exist for a project, see their dates and titles,",
      "and identify specific session notes to read via memory_get.",
    ].join("\n"),
    {
      project: z.string().describe("Project slug to list sessions for."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum sessions to return. Default: 10 (most recent first)."),
      status: z
        .enum(["open", "completed", "compacted"])
        .optional()
        .describe("Filter by session status."),
    },
    async (args) => {
      const result = toolSessionList(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: registry_search
  // -------------------------------------------------------------------------

  server.tool(
    "registry_search",
    [
      "Search PAI project registry by slug, display name, or path.",
      "",
      "Use this to find the slug for a project when you know its name or path,",
      "or to check if a project is registered. Returns matching project entries.",
    ].join("\n"),
    {
      query: z
        .string()
        .describe(
          "Search term matched against project slugs, display names, and root paths (case-insensitive substring match)."
        ),
    },
    async (args) => {
      const result = toolRegistrySearch(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: project_detect
  // -------------------------------------------------------------------------

  server.tool(
    "project_detect",
    [
      "Detect which registered PAI project a filesystem path belongs to.",
      "",
      "Use this at session start to auto-identify the current project from the",
      "working directory, or to map any path back to its registered project.",
      "",
      "Returns: slug, display_name, root_path, type, status, match_type (exact|parent),",
      "relative_path (if the given path is inside a project), and session stats.",
      "",
      "match_type 'exact' means the path IS the project root.",
      "match_type 'parent' means the path is a subdirectory of the project root.",
    ].join("\n"),
    {
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to detect project for. Defaults to the MCP server's process.cwd()."
        ),
    },
    async (args) => {
      const result = toolProjectDetect(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: project_health
  // -------------------------------------------------------------------------

  server.tool(
    "project_health",
    [
      "Audit all registered PAI projects to find moved or deleted directories.",
      "",
      "Returns a JSON report categorising every project as:",
      "  active  — root_path exists on disk",
      "  stale   — root_path missing, but a directory with the same name was found nearby",
      "  dead    — root_path missing, no candidate found",
      "",
      "Use this to diagnose orphaned sessions or missing project paths.",
    ].join("\n"),
    {
      category: z
        .enum(["active", "stale", "dead", "all"])
        .optional()
        .describe("Filter results to a specific health category. Default: all."),
    },
    async (args) => {
      const result = await toolProjectHealth(getRegistryDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: notification_config
  // -------------------------------------------------------------------------

  server.tool(
    "notification_config",
    [
      "Query or update the PAI unified notification configuration.",
      "",
      "Actions:",
      "  get  — Return the current notification mode, active channels, and routing table.",
      "  set  — Change the notification mode or update channel/routing config.",
      "  send — Send a notification through the configured channels.",
      "",
      "Notification modes:",
      "  auto      — Use the per-event routing table (default)",
      "  voice     — All events sent as WhatsApp voice (TTS)",
      "  whatsapp  — All events sent as WhatsApp text",
      "  ntfy      — All events sent to ntfy.sh",
      "  macos     — All events sent as macOS notifications",
      "  cli       — All events written to CLI output only",
      "  off       — Suppress all notifications",
      "",
      "Event types for send: error | progress | completion | info | debug",
      "",
      "Examples:",
      '  { "action": "get" }',
      '  { "action": "set", "mode": "voice" }',
      '  { "action": "send", "event": "completion", "message": "Done!" }',
    ].join("\n"),
    {
      action: z
        .enum(["get", "set", "send"])
        .describe("Action: 'get' (read config), 'set' (update config), 'send' (send notification)."),
      mode: z
        .enum(["auto", "voice", "whatsapp", "ntfy", "macos", "cli", "off"])
        .optional()
        .describe("For action=set: new notification mode."),
      channels: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "For action=set: partial channel config overrides as a JSON object. " +
          'E.g. { "whatsapp": { "enabled": true }, "macos": { "enabled": false } }'
        ),
      routing: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "For action=set: partial routing overrides as a JSON object. " +
          'E.g. { "error": ["whatsapp", "macos"], "progress": ["cli"] }'
        ),
      event: z
        .enum(["error", "progress", "completion", "info", "debug"])
        .optional()
        .describe("For action=send: event type. Default: 'info'."),
      message: z
        .string()
        .optional()
        .describe("For action=send: the notification message body."),
      title: z
        .string()
        .optional()
        .describe("For action=send: optional notification title (used by macOS and ntfy)."),
    },
    async (args) => {
      const result = await toolNotificationConfig(args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: topic_detect
  // -------------------------------------------------------------------------

  server.tool(
    "topic_detect",
    [
      "Detect whether recent conversation context has shifted to a different project.",
      "",
      "Call this when the conversation may have drifted away from the initially-routed project.",
      "Provide a short summary of the recent context (last few messages or tool call results).",
      "",
      "Returns:",
      "  shifted          — true if a topic shift was detected",
      "  current_project  — the project the session is currently routed to",
      "  suggested_project — the project that best matches the context",
      "  confidence       — [0,1] fraction of memory mass held by suggested_project",
      "  chunks_scored    — number of memory chunks that contributed to scoring",
      "  top_matches      — top-3 projects with their confidence percentages",
      "",
      "A shift is reported when confidence >= threshold (default 0.6) and the",
      "best-matching project differs from current_project.",
      "",
      "Use cases:",
      "  - Call at session start to confirm routing is correct",
      "  - Call periodically when working across multiple concerns",
      "  - Integrate with pre-tool hooks for automatic drift detection",
    ].join("\n"),
    {
      context: z
        .string()
        .describe(
          "Recent conversation context: a few sentences summarising what the session has been discussing. " +
          "Can include file paths, feature names, commands run, or any relevant text."
        ),
      current_project: z
        .string()
        .optional()
        .describe(
          "The project slug this session is currently routed to. " +
          "If omitted, the tool still returns the best-matching project but shifted will always be false."
        ),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Minimum confidence [0,1] to declare a shift. Default: 0.6. " +
          "Increase to reduce false positives. Decrease to catch subtle drifts."
        ),
    },
    async (args) => {
      const result = await toolTopicDetect(args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: session_route
  // -------------------------------------------------------------------------

  server.tool(
    "session_route",
    [
      "Automatically detect which project this session belongs to.",
      "",
      "Call this at session start (e.g., from CLAUDE.md or a session-start hook)",
      "to route the session to the correct project automatically.",
      "",
      "Detection strategy (in priority order):",
      "  1. path   — exact or parent-directory match in the project registry",
      "  2. marker — walk up from cwd looking for Notes/PAI.md marker files",
      "  3. topic  — BM25 keyword search against memory (only if context provided)",
      "",
      "Returns:",
      "  slug         — the matched project slug",
      "  display_name — human-readable project name",
      "  root_path    — absolute path to the project root",
      "  method       — how it was detected: 'path', 'marker', or 'topic'",
      "  confidence   — 1.0 for path/marker matches, BM25 fraction for topic",
      "",
      "If no match is found, returns a message explaining what was tried.",
      "Run 'pai project add .' to register the current directory.",
    ].join("\n"),
    {
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory to detect from. Defaults to process.cwd(). " +
          "Pass the session's actual working directory for accurate detection."
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Optional conversation context for topic-based fallback routing. " +
          "A few sentences summarising what the session will work on. " +
          "Only used if path and marker detection both fail."
        ),
    },
    async (args) => {
      const result = await toolSessionRoute(getRegistryDb(), getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_explore
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_explore",
    [
      "Explore the vault's knowledge graph using Luhmann's Folgezettel traversal.",
      "Follow trains of thought forward, backward, or both from a starting note.",
      "Classifies links as sequential (same-folder) or associative (cross-folder).",
    ].join("\n"),
    {
      start_note: z
        .string()
        .describe("Path or title of the note to start traversal from."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many link hops to traverse. Default: 3."),
      direction: z
        .enum(["forward", "backward", "both"])
        .optional()
        .describe("Traversal direction: 'forward' (outlinks), 'backward' (backlinks), or 'both'. Default: both."),
      mode: z
        .enum(["sequential", "associative", "all"])
        .optional()
        .describe("Link type filter: 'sequential' (same-folder), 'associative' (cross-folder), or 'all'. Default: all."),
    },
    async (args) => {
      const result = await toolZettelExplore(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_health
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_health",
    [
      "Audit the structural health of the Obsidian vault.",
      "Reports dead links, orphan notes, disconnected clusters, low-connectivity files, and an overall health score.",
    ].join("\n"),
    {
      scope: z
        .enum(["full", "recent", "project"])
        .optional()
        .describe("Audit scope: 'full' (entire vault), 'recent' (recently modified), or 'project' (specific path). Default: full."),
      project_path: z
        .string()
        .optional()
        .describe("Absolute path to the project/folder to audit when scope='project'."),
      recent_days: z
        .number()
        .int()
        .optional()
        .describe("Number of days to look back when scope='recent'. Default: 30."),
      include: z
        .array(z.enum(["dead_links", "orphans", "disconnected", "low_connectivity"]))
        .optional()
        .describe("Specific checks to include. Omit to run all checks."),
    },
    async (args) => {
      const result = await toolZettelHealth(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_surprise
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_surprise",
    [
      "Find surprising connections — notes that are semantically similar to a reference note but far away in the link graph.",
      "High surprise = unexpected relevance.",
    ].join("\n"),
    {
      reference_path: z
        .string()
        .describe("Path to the reference note to find surprising connections for."),
      vault_project_id: z
        .number()
        .int()
        .describe("Project ID of the vault to search within."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of surprising notes to return. Default: 10."),
      min_similarity: z
        .number()
        .optional()
        .describe("Minimum semantic similarity [0,1] for a note to be considered. Default: 0.5."),
      min_graph_distance: z
        .number()
        .int()
        .optional()
        .describe("Minimum link hops away from the reference note. Default: 3."),
    },
    async (args) => {
      const result = await toolZettelSurprise(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_suggest
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_suggest",
    [
      "Suggest new connections for a note using semantic similarity, shared tags, and graph neighborhood (friends-of-friends).",
    ].join("\n"),
    {
      note_path: z
        .string()
        .describe("Path to the note to generate link suggestions for."),
      vault_project_id: z
        .number()
        .int()
        .describe("Project ID of the vault to search within."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of suggestions to return. Default: 10."),
      exclude_linked: z
        .boolean()
        .optional()
        .describe("Exclude notes already linked from this note. Default: true."),
    },
    async (args) => {
      const result = await toolZettelSuggest(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_converse
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_converse",
    [
      "Use the vault as a Zettelkasten communication partner.",
      "Ask a question, get relevant notes with cross-domain connections and a synthesis prompt for generating new insights.",
    ].join("\n"),
    {
      question: z
        .string()
        .describe("The question or topic to explore in the vault."),
      vault_project_id: z
        .number()
        .int()
        .describe("Project ID of the vault to query."),
      depth: z
        .number()
        .int()
        .optional()
        .describe("How many link hops to follow from seed notes. Default: 2."),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of relevant notes to retrieve. Default: 10."),
    },
    async (args) => {
      const result = await toolZettelConverse(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: zettel_themes
  // -------------------------------------------------------------------------

  server.tool(
    "zettel_themes",
    [
      "Detect emerging themes by clustering recent notes with similar embeddings.",
      "Reveals forming idea clusters and suggests index notes for unlinked clusters.",
    ].join("\n"),
    {
      vault_project_id: z
        .number()
        .int()
        .describe("Project ID of the vault to analyse."),
      lookback_days: z
        .number()
        .int()
        .optional()
        .describe("Number of days of recent notes to cluster. Default: 30."),
      min_cluster_size: z
        .number()
        .int()
        .optional()
        .describe("Minimum notes required to form a theme cluster. Default: 3."),
      max_themes: z
        .number()
        .int()
        .optional()
        .describe("Maximum number of theme clusters to return. Default: 10."),
      similarity_threshold: z
        .number()
        .optional()
        .describe("Minimum cosine similarity to group notes into a cluster [0,1]. Default: 0.7."),
    },
    async (args) => {
      const result = await toolZettelThemes(getFederationDb(), args);
      return {
        content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
        isError: result.isError,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Connect transport and start serving
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive — the server runs until stdin closes
}
