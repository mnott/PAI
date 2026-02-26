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
  // Connect transport and start serving
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive — the server runs until stdin closes
}
