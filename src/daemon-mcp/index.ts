#!/usr/bin/env node
/**
 * PAI Daemon MCP Shim
 *
 * A thin MCP server that proxies all PAI tool calls to the PAI daemon via IPC.
 * One shim instance runs per Claude Code session (spawned by Claude Code's MCP
 * mechanism). All shims share the single daemon process, which holds the
 * database connections and embedding model singleton.
 *
 * Tool definitions are static (unlike Coogle which discovers tools dynamically).
 * The 9 PAI tools are: memory_search, memory_get, project_info, project_list,
 * session_list, registry_search, project_detect, project_health, project_todo.
 *
 * If the daemon is not running, tool calls return a helpful error message
 * rather than crashing — this allows the legacy direct MCP (dist/mcp/index.mjs)
 * to serve as fallback.
 *
 * Architecture:
 *   instructions — thin routing table (~1KB). Always in context.
 *   prompts      — full skill workflows fetched on demand (20 skills).
 *   resources    — reference docs read when needed (guides, constitution).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaiClient } from "../daemon/ipc-client.js";
import { loadConfig } from "../daemon/config.js";
import { PAI_INSTRUCTIONS } from "./instructions.js";
import {
  review,
  journal,
  plan,
  share,
  sessions,
  route,
  searchHistory,
  name,
  observability,
  research,
  art,
  createskill,
  storyExplanation,
  vaultContext,
  vaultConnect,
  vaultEmerge,
  vaultOrphans,
  vaultTrace,
} from "./prompts/index.js";
import {
  aesthetic,
  constitution,
  prompting,
  prosodyGuide,
  prosodyAgentTemplate,
  voice,
  skillSystem,
  hookSystem,
  historySystem,
  terminalTabs,
  mcpDevGuide,
} from "./resources/index.js";

// ---------------------------------------------------------------------------
// IPC client singleton
// ---------------------------------------------------------------------------

let _client: PaiClient | null = null;

function getClient(): PaiClient {
  if (!_client) {
    const config = loadConfig();
    _client = new PaiClient(config.socketPath);
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Helper: proxy a tool call to daemon, returning MCP-compatible content
// ---------------------------------------------------------------------------

async function proxyTool(
  method: string,
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await getClient().call(method, params);
    // The daemon returns ToolResult objects (content + isError)
    const toolResult = result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    return {
      content: toolResult.content.map((c) => ({
        type: "text" as const,
        text: c.text,
      })),
      isError: toolResult.isError,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [
        {
          type: "text" as const,
          text: `PAI daemon error: ${msg}\n\nIs the daemon running? Start it with: pai daemon serve`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

async function startShim(): Promise<void> {
  const server = new McpServer(
    {
      name: "pai",
      version: "0.1.0",
    },
    {
      instructions: PAI_INSTRUCTIONS,
    }
  );

  // -------------------------------------------------------------------------
  // Prompts — one per skill workflow (fetched on demand)
  // -------------------------------------------------------------------------

  const SKILL_PROMPTS: Record<string, { description: string; content: string }> = {
    "review": review,
    "journal": journal,
    "plan": plan,
    "share": share,
    "sessions": sessions,
    "route": route,
    "search-history": searchHistory,
    "name": name,
    "observability": observability,
    "research": research,
    "art": art,
    "createskill": createskill,
    "story-explanation": storyExplanation,
    "vault-context": vaultContext,
    "vault-connect": vaultConnect,
    "vault-emerge": vaultEmerge,
    "vault-orphans": vaultOrphans,
    "vault-trace": vaultTrace,
  };

  for (const [promptName, skill] of Object.entries(SKILL_PROMPTS)) {
    server.prompt(
      promptName,
      skill.description,
      () => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: skill.content,
            },
          },
        ],
      })
    );
  }

  // -------------------------------------------------------------------------
  // Resources — reference docs (read on demand)
  // -------------------------------------------------------------------------

  const resources: Array<{
    name: string;
    uri: string;
    description: string;
    content: string;
  }> = [
    aesthetic,
    prosodyGuide,
    prosodyAgentTemplate,
    voice,
    skillSystem,
    hookSystem,
    historySystem,
    terminalTabs,
    mcpDevGuide,
    constitution,
    prompting,
  ];

  for (const resource of resources) {
    server.resource(
      resource.name,
      resource.uri,
      { mimeType: "text/markdown", description: resource.description },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: "text/markdown",
            text: resource.content,
          },
        ],
      })
    );
  }

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
      "Recency boost optionally down-weights older results (recency_boost=90 means scores halve every 90 days).",
      "",
      "Defaults come from ~/.config/pai/config.json (search section). Per-call parameters override config defaults.",
      "",
      "Returns ranked snippets with project slug, file path, line range, and score.",
      "Higher score = more relevant.",
      "",
      "Token-efficient workflow: use format='compact' first (~50 tokens/result),",
      "then memory_get on interesting results for full content. ~10x token savings.",
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
          "Rerank results using a cross-encoder model for better relevance. Default: true."
        ),
      recency_boost: z
        .number()
        .int()
        .min(0)
        .max(365)
        .optional()
        .describe(
          "Apply recency boost: score halves every N days. 0 = off. Default from config (typically 90). Applied after reranking."
        ),
      format: z
        .enum(["full", "compact"])
        .optional()
        .describe(
          "Output format. 'full' (default) includes snippets. 'compact' returns IDs + metadata only (~10x fewer tokens). Use compact first, then memory_get for full details on interesting results."
        ),
    },
    async (args) => proxyTool("memory_search", args)
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
    async (args) => proxyTool("memory_get", args)
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
    async (args) => proxyTool("project_info", args)
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
    async (args) => proxyTool("project_list", args)
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
    async (args) => proxyTool("session_list", args)
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
    async (args) => proxyTool("registry_search", args)
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
    ].join("\n"),
    {
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to detect project for. Defaults to the MCP server's process.cwd()."
        ),
    },
    async (args) => proxyTool("project_detect", args)
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
      "Each active project entry also includes a 'todo' field indicating whether",
      "a TODO.md was found and whether it has a ## Continue section.",
    ].join("\n"),
    {
      category: z
        .enum(["active", "stale", "dead", "all"])
        .optional()
        .describe("Filter results to a specific health category. Default: all."),
    },
    async (args) => proxyTool("project_health", args)
  );

  // -------------------------------------------------------------------------
  // Tool: project_todo
  // -------------------------------------------------------------------------

  server.tool(
    "project_todo",
    [
      "Read a project's TODO.md without needing to know the exact file path.",
      "",
      "Use this at session start or when resuming work to get the project's current",
      "task list and continuation prompt. If a '## Continue' section is present,",
      "it will be surfaced at the top of the response for quick context recovery.",
      "",
      "Searches these locations in order:",
      "  1. <project_root>/Notes/TODO.md",
      "  2. <project_root>/.claude/Notes/TODO.md",
      "  3. <project_root>/tasks/todo.md",
      "  4. <project_root>/TODO.md",
      "",
      "If no project slug is provided, auto-detects from the current working directory.",
    ].join("\n"),
    {
      project: z
        .string()
        .optional()
        .describe(
          "Project slug. Omit to auto-detect from the current working directory."
        ),
    },
    async (args) => proxyTool("project_todo", args)
  );

  // -------------------------------------------------------------------------
  // Tool: memory_wakeup
  // -------------------------------------------------------------------------

  server.tool(
    "memory_wakeup",
    [
      "Load the 4-layer wake-up context for the current (or specified) project.",
      "",
      "Returns a progressive context block with:",
      "  L0 Identity     — user identity from ~/.pai/identity.txt (~100 tokens, always included)",
      "  L1 Essential Story — recent session note highlights: Work Done, Key Decisions, Next Steps",
      "                       (~500-800 tokens, auto-extracted from the most recent notes)",
      "",
      "Use this at session start to quickly re-orient: who the user is, what they were doing,",
      "and what decisions were made recently — without loading the full memory index.",
      "",
      "For deeper on-demand recall, use memory_search (L2/L3).",
      "",
      "Inspired by the mempalace progressive context loading pattern.",
    ].join("\n"),
    {
      project: z
        .string()
        .optional()
        .describe(
          "Project slug or absolute root path. Omit to auto-detect from the current working directory."
        ),
      token_budget: z
        .number()
        .int()
        .min(100)
        .max(4000)
        .optional()
        .describe(
          "Maximum tokens for the L1 essential story block. Default: 800 (~3200 chars)."
        ),
    },
    async (args) => proxyTool("memory_wakeup", args)
  );

  // -------------------------------------------------------------------------
  // Tool: memory_taxonomy
  // -------------------------------------------------------------------------

  server.tool(
    "memory_taxonomy",
    [
      "Return the SHAPE of stored memory without requiring a search query.",
      "",
      "Answers 'what do I know about?' rather than 'what do I know about X?'",
      "",
      "Returns:",
      "  - All active projects with session count, indexed file count, last activity date, and tags",
      "  - Global totals (projects, sessions, indexed files, chunks)",
      "  - Recent activity — last 10 sessions across all projects",
      "",
      "Use this at session start for a quick orientation, before memory_search for a",
      "specific topic, or when you want to know which projects have recorded memory.",
      "",
      "Inspired by mempalace's mempalace_get_taxonomy tool.",
    ].join("\n"),
    {
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived projects in the result. Default: false."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum number of projects to return. Default: 50."),
    },
    async (args) => proxyTool("memory_taxonomy", args)
  );

  // -------------------------------------------------------------------------
  // Tool: memory_tunnels
  // -------------------------------------------------------------------------

  server.tool(
    "memory_tunnels",
    [
      "Find 'tunnels' — concepts that appear across multiple projects in PAI memory.",
      "",
      "A tunnel is a shared term or phrase that appears in chunks from at least two",
      "distinct projects, surfacing serendipitous cross-project connections in your",
      "knowledge graph (inspired by the memory palace / palace graph concept).",
      "",
      "Results are sorted by project breadth (most cross-cutting first), then by",
      "raw occurrence count. Each tunnel includes the concept, which projects contain",
      "it, total occurrences, and first/last seen timestamps.",
    ].join("\n"),
    {
      min_projects: z
        .number()
        .int()
        .min(2)
        .optional()
        .describe("Minimum distinct projects a concept must appear in. Default: 2."),
      min_occurrences: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Minimum total chunk occurrences across all projects. Default: 3."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of tunnels to return. Default: 20."),
    },
    async (args) => proxyTool("memory_tunnels", args)
  );

  // -------------------------------------------------------------------------
  // Connect transport and start serving
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startShim().catch((e) => {
  process.stderr.write(`PAI MCP shim fatal error: ${String(e)}\n`);
  process.exit(1);
});
