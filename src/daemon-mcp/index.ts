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
 * The 10 PAI tools are: memory_search, memory_get, memory_outline, project_info, project_list,
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

import { buildNext, buildsDir, listBuilds, renderBuildQueue } from "../builds/queue.js";
import { poolSlots } from "../builds/config.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaiClient } from "../daemon/ipc-client.js";
import { loadConfig } from "../daemon/config.js";
import { issueClaim, issueClaims, issueStale } from "../session/issue-claims.js";
import { formatCheck, initProject, isGitProject, projectChecks } from "../session/project-setup.js";
import { PAI_INSTRUCTIONS } from "./instructions.js";
import { batteryStatus, daemonService, memoryRun, modelRuntime, poolStatus, release, routerService, testsAudit, testsPrune, workerGc, workerKill, updateCheck, workerMerge } from "./tools/ops.js";
import { dropItermBundleId } from "../utils/env.js";

dropItermBundleId();
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
  reconstruct,
  whisper,
  consolidate,
  advisor,
  tasks,
  worker,
  providers,
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
  workerSetup,
} from "./resources/index.js";
import { CAPABILITY_NAME_RE, MODEL_CAPABILITIES, readWorkersSection } from "../workers/config.js";
import { workersLogDir, ledgerPath } from "../workers/paths.js";
import { ledgerSummary } from "../workers/ledger.js";
import {
  addProvider,
  classTargetText,
  describeProviders,
  removeProvider,
  setProviderCap,
  holdProvider,
  releaseProvider,
  holdText,
  setClass,
  setProviderEnabled,
  setWorkersEnabled,
  unsetClass,
  updateProvider,
  useProvider,
} from "../workers/providers.js";
import { testProvider, runWorker } from "../workers/run.js";
import { probeLoopback } from "../workers/local-provider.js";
import { resolveTarget, withTarget } from "../workers/target.js";
import { CONFIG_FILE } from "../daemon/config.js";
import { fallbackOn, fallbackOff, fallbackStatus, fallbackStatusText } from "../workers/fallback.js";
import { runChain } from "../workers/chain.js";
import { resolveWorkerRunPrompt, workerRunShape } from "./tools/worker-run-args.js";
import { psOutput, replayOutput } from "../workers/viewer.js";
import { ageOf, loadStatus, loadStatuses, isLive, nowStamp, reconcileStatuses, setWorkerLabel } from "../workers/status.js";
import { setWorkerPaused, setWorkerPriority } from "../workers/engine-control.js";
import { queueRows, reorderQueue } from "../workers/capacity.js";
import { schedulerLines, schedulerView } from "../workers/scheduler.js";
import { providerCaps } from "../cli/commands/worker.js";
import { deadlineLabel } from "../workers/deadline.js";
import { endLabel } from "../workers/endreason.js";
import { sayToWorker } from "../workers/operator.js";
import { handoffFromInside, readInbox } from "../workers/handoff.js";
import { workerModel } from "./tools/worker-model.js";
import { realSessionProfileDeps, sessionProfileGet, sessionProfileSet } from "./tools/session-profile.js";
import { configList, configGet, configSet, configUnset } from "./tools/config.js";
import { workerCapability } from "./tools/worker-capability.js";
import { candidates as apCandidates, conflicts as apConflicts, label as apLabel, listPatterns as apList, parseSince as apSince, promote as apPromote, retire as apRetire, setMode as apSetMode, setParam as apSetParam, stats as apStats } from "../antipatterns/govern.js";
import { currentLocalStatus } from "../workers/local-provider.js";
import { localStatusReport } from "../workers/local-status.js";
import { currentInventory, inventoryRows, INVENTORY_HEADERS } from "../workers/model-inventory.js";
import {
  planAmend, planRun, planSave, planStatusText, planStop, queueAccept, queueAdd, queueAgain, queueReject, queueReview, queueRun,
  realDelegationDeps,
} from "./tools/delegation.js";

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
/** where / model / now: the same three optional arguments on every delegation tool (workers/target.ts). */
const whereArgs = {
  where: z.string().optional().describe("Where it runs: \"local\" (PAI picks the running local server), \"cloud\" (the session's cloud provider) or a provider name. Omit for default routing."),
  model: z.string().optional().describe("\"default\", \"fast\" or a model id."),
  now: z.boolean().optional().describe("true: ahead of the runs already waiting."),
  force_local: z.boolean().optional().describe("true: stay local even when the route classifier says infra/install/device/external work belongs in the cloud."),
};


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
    // These four were exported and stubbed but never registered here, so
    // `prompts/get` could not reach them. The stub generator reads the barrel,
    // which is why the drift went unnoticed.
    "reconstruct": reconstruct,
    "whisper": whisper,
    "consolidate": consolidate,
    "advisor": advisor,
    "tasks": tasks,
    "worker": worker,
    "providers": providers,
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
    workerSetup,
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
      "Defaults come from ~/.pai/config.yaml (search section). Per-call parameters override config defaults.",
      "",
      "Returns ranked snippets with project slug, file path, line range, and score.",
      "Higher score = more relevant.",
      "",
      "Token-efficient workflow: use format='compact' first (~50 tokens/result),",
      "then memory_get on interesting results for full content (memory_outline lists a file's sections). ~10x token savings.",
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
          "Output format. 'full' (default) includes snippets. 'compact' returns IDs + metadata only (~10x fewer tokens). Use compact first, then memory_get for full details on interesting results. Each result includes 'id=<chunk_id>' which can be passed to memory_feedback."
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
      "it via memory_search. Optionally restrict to a line range (see memory_outline for section line ranges).",
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
  // Tool: memory_outline
  // -------------------------------------------------------------------------

  server.tool(
    "memory_outline",
    [
      "Heading tree of one project file: level, title, line range, ~tokens per section.",
      "No text. Pick a section, then read just those lines with memory_get (from, lines).",
      "Same project/path rules as memory_get.",
    ].join("\n"),
    {
      project: z
        .string()
        .describe("Project slug identifying which project's files to read from."),
      path: z
        .string()
        .describe("Relative path within the project root (e.g. 'Notes/TODO.md')."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Limit nesting depth (1 = top-level headings only). Default: all."),
    },
    async (args) => proxyTool("memory_outline", args)
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
    async (args) => {
      const r = await proxyTool("project_health", args);
      if (isGitProject(process.cwd())) {
        const checks = await projectChecks(process.cwd());
        r.content.push({ type: "text" as const, text: `Project checks (${process.cwd()}):\n${checks.map(formatCheck).join("\n")}` });
      }
      return r;
    }
  );

  server.tool(
    "project_setup",
    "Set up the current project for PAI workers: writes .pai/project.yaml (status sink from the origin kind) and a starter .pai/worker.md, never overwriting without force, then runs the project checks. Same as `pai project init`.",
    {
      anchor: z.number().int().positive().optional().describe("Forge anchor issue number (sink forge only)"),
      marker: z.string().optional().describe("Marker text that must occur in the anchor body"),
      force: z.boolean().optional().describe("Overwrite existing files (old copies kept as .bak)"),
      dry_run: z.boolean().optional().describe("Report what would be written; write nothing"),
    },
    async (args) => {
      try {
        const r = initProject(process.cwd(), { anchor: args.anchor, marker: args.marker, force: args.force, dryRun: args.dry_run });
        const checks = (await projectChecks(r.root)).map(formatCheck);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...r, checks }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `project_setup error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
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
  // Tools: issue_claim / issue_release / issue_claims (run locally, not via the daemon)
  // -------------------------------------------------------------------------

  const issueTool = (f: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(f(), null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `issue error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };
  for (const [name, add] of [["issue_claim", true], ["issue_release", false]] as const) {
    server.tool(
      name,
      `${add ? "Claim" : "Release"} a forge issue of the current project (assignee claude + label in-progress). Never closes issues. Inside a worker the claim is recorded and released when the worker ends (unless it reports r=~).`,
      { issue: z.number().int().positive().describe("Issue number"), dry_run: z.boolean().optional().describe("Return the requests that would be sent; send none") },
      async (args) => issueTool(() => issueClaim(process.cwd(), args.issue, add, { dryRun: args.dry_run }))
    );
  }
  server.tool(
    "issue_claims",
    "List open issues of the current project carrying the in-progress label.",
    {},
    async () => issueTool(() => issueClaims(process.cwd()))
  );

  server.tool(
    "issue_stale",
    "List open issues of the current project that landed in the integration branch or are idle >= days. Report only; never closes.",
    { days: z.number().int().min(0).optional().describe("Idle threshold in days (default 7)") },
    async (args) => issueTool(() => issueStale(process.cwd(), args.days ?? 7))
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
  // Tool: memory_lessons
  // -------------------------------------------------------------------------

  server.tool(
    "memory_lessons",
    "Read the curated, review-gated lessons (corrections, gotchas, conventions). Lists approved lessons by default; read-only.",
    {
      action: z.enum(["list", "get"]).describe("list: lessons filtered by state/project; get: one lesson by id."),
      state: z.enum(["candidate", "approved", "rejected", "superseded"]).optional().describe("State filter for list. Default: approved."),
      project: z.string().optional().describe('Project slug or "global" filter for list.'),
      id: z.string().optional().describe("Lesson id (required for get)."),
    },
    async (args) => proxyTool("memory_lessons", args)
  );

  // -------------------------------------------------------------------------
  // Tools: antipatterns_* (governance of the anti-pattern directory)
  // -------------------------------------------------------------------------

  const apTool = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, run: (args: any) => unknown): void => {
    server.tool(name, description, shape, async (args: any) => {
      try {
        const r = run(args);
        return { content: [{ type: "text" as const, text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `${name} error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    });
  };
  apTool("antipatterns_list", "List anti-patterns with status, mode and version (shell rules and the other categories).", { category: z.string().optional(), status: z.enum(["experimental", "test", "stable", "deprecated"]).optional() }, (a) => apList({ category: a.category, status: a.status }));
  apTool(
    "antipatterns_stats",
    "Per pattern: firings, last fired, per model, actions, outcome mix, false-positive rate, flags (false-positive suspect, model-quirk, retire candidate).",
    { since: z.string().optional().describe("e.g. 12h, 7d, 2w"), model: z.string().optional() },
    (a) => apStats({ sinceMs: a.since ? apSince(a.since) : undefined, model: a.model }),
  );
  apTool("antipatterns_candidates", "Cases a guard stopped that no pattern covers, waiting for review.", {}, () => apCandidates());
  apTool("antipatterns_promote", "Promote a candidate into the user directory (status test, mode monitor).", { id: z.string() }, (a) => apPromote(a.id));
  apTool("antipatterns_mode", "Switch a pattern between enforce and monitor (writes a user override).", { id: z.string(), mode: z.enum(["enforce", "monitor"]) }, (a) => apSetMode(a.id, a.mode).path);
  apTool("antipatterns_retire", "Retire a pattern: status deprecated via a user override; shipped files are never deleted.", { id: z.string(), reason: z.string().optional() }, (a) => apRetire(a.id, a.reason).path);
  apTool(
    "antipatterns_set",
    "Change one detector parameter of a pattern (user override, version bump, changes entry, governance log). Unknown params and type mismatches are refused.",
    { id: z.string(), param: z.string(), value: z.union([z.number(), z.boolean(), z.string()]), reason: z.string(), model: z.string().optional().describe("Scope the change to this model (per_model entry) instead of the global param") },
    (a) => apSetParam(a.id, a.param, a.value, a.reason, { model: a.model }),
  );
  apTool("antipatterns_label", "Label a firing (by ts) or all firings of a pattern (by id) tp, fp or benign_tp.", { target: z.string(), disposition: z.enum(["tp", "fp", "benign_tp", "undetermined"]) }, (a) => ({ labelled: apLabel(a.target, a.disposition) }));
  apTool("antipatterns_conflicts", "Duplicate ids and active patterns matching each other's fixtures with different actions.", {}, () => apConflicts());

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
  // Tool: memory_feedback (MR2 — feedback weight loop)
  // -------------------------------------------------------------------------

  server.tool(
    "memory_feedback",
    [
      "Apply relevance feedback to memory chunks to improve future search ranking.",
      "",
      "After reading search results, rate their relevance to adjust the EMA-based",
      "feedback weights. Higher-rated chunks will score better in future searches",
      "via the multiplier: final_score *= (0.5 + relevance_score).",
      "",
      "Also updates feedback weights on KG entities mentioned in those chunks.",
      "",
      "Rating scale: 1 = not relevant, 3 = somewhat relevant, 5 = highly relevant.",
      "",
      "Use chunk IDs from memory_search compact format results.",
    ].join("\n"),
    {
      chunk_ids: z
        .array(z.string())
        .describe("Array of chunk IDs to apply feedback to (from memory_search results)."),
      rating: z
        .number()
        .min(1)
        .max(5)
        .describe("Relevance rating from 1 (not relevant) to 5 (highly relevant)."),
      tenant_id: z
        .string()
        .optional()
        .describe("Tenant ID for entity feedback scoping. Default: 'default'."),
    },
    async (args) => proxyTool("memory_feedback", args)
  );

  // -------------------------------------------------------------------------
  // Tool: memory_kg_search (MR1 — graph-completion retrieval)
  // -------------------------------------------------------------------------

  server.tool(
    "memory_kg_search",
    [
      "Graph-completion search: combines vector search with knowledge-graph neighborhood expansion.",
      "",
      "Algorithm:",
      "  Phase 1: Wide vector search (seed chunks) using the query embedding",
      "  Phase 2: Extract entity mentions from seed chunks (matched against kg_entities)",
      "  Phase 3: BFS neighborhood expansion in kg_triples (1-2 hops from matched entities)",
      "  Phase 4: Re-rank all collected triples against the query embedding",
      "",
      "Returns ranked KG triples with relevance scores, surfacing graph-derived context",
      "that pure vector search would miss — relationships, facts, and entity connections.",
      "",
      "Requires Postgres backend with a populated kg_triples table.",
      "Use kg_add to populate the knowledge graph, or rely on automatic extraction.",
      "",
      "Parameters:",
      "  query              — Free-text query (converted to embedding for Phase 1)",
      "  project_id         — Restrict seed search to a specific project (optional)",
      "  wide_k             — Number of seed chunks from Phase 1 (default: 50)",
      "  neighborhood_depth — BFS hop depth for KG expansion (default: 1, max: 2)",
      "  top_k              — Maximum triples to return after re-ranking (default: 20)",
    ].join("\n"),
    {
      query: z
        .string()
        .describe("Free-text search query — used to generate embedding for Phase 1 vector search."),
      project_id: z
        .number()
        .int()
        .optional()
        .describe("Restrict seed vector search to a specific project ID. Omit to search all projects."),
      wide_k: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Number of seed chunks to fetch in Phase 1 vector search. Default: 50."),
      neighborhood_depth: z
        .number()
        .int()
        .min(1)
        .max(2)
        .optional()
        .describe("BFS hop depth for KG neighborhood expansion. Default: 1. Max: 2."),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum KG triples to return after re-ranking. Default: 20."),
      tenant_id: z
        .string()
        .optional()
        .describe("Tenant ID for entity lookup scoping. Default: 'default'."),
    },
    async (args) => proxyTool("memory_kg_search", args)
  );

  // -------------------------------------------------------------------------
  // Tools: worker_* — subagent routing (direct library calls, no daemon IPC:
  // these only read/write the config file and the workers log dir)
  // -------------------------------------------------------------------------

  const workerText = (s: string) => ({
    content: [{ type: "text" as const, text: s }],
  });
  const workerError = (e: unknown) => ({
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true as const,
  });

  server.tool(
    "worker_status",
    [
      "Show the worker system state: on/off, active provider, configured providers,",
      "roles, today's run tally from the ledger, and the running workers with",
      "their inbox counts (◆N = handoffs waiting).",
      "",
      "Use this before delegating with `pai worker run` to see what routing will choose.",
    ].join("\n"),
    {},
    async () => {
      try {
        const { workers } = readWorkersSection();
        const s = ledgerSummary(ledgerPath(workersLogDir(workers)), "all", 10);
        const tally = s
          ? [
              `runs ${s.scope}: ${s.started} started, ${s.endedOk} ok, ${s.endedFailed} failed`,
              `agent hook: ${s.denied} denied, ${s.allowed} allowed, ${s.reroutes} reroutes`,
            ]
          : ["no runs recorded yet"];
        const logDir = workersLogDir(workers);
        reconcileStatuses(logDir);
        const running = loadStatuses(logDir).filter((w) => isLive(w));
        const runningLines = running.length
          ? [
              "",
              `running (${running.length}):`,
              ...running.map(
                (w) =>
                  `  ${w.id} ${w.label}${w.parent ? ` (sub-worker of ${w.parent})` : ""} · ${w.last}` +
                  (deadlineLabel(w) ? ` · ${deadlineLabel(w)}` : "") +
                  (w.parentComm ? ` · parent: ${w.parentComm}` : "") +
                  (readInbox(logDir, w.id).length ? ` · ◆${readInbox(logDir, w.id).length}` : "")
              ),
            ]
          : [];
        const ended = loadStatuses(logDir)
          .filter((w) => w.state !== "running" && w.state !== "queued" && w.endReason)
          .slice(-5);
        if (ended.length)
          runningLines.push("", "recently ended:", ...ended.map((w) => `  ${w.id} ${w.state} · ${endLabel(w)}${w.endNote ? ` (${w.endNote})` : ""}`));
        return workerText(
          [
            `workers: ${workers.enabled ? "on" : "off"}`,
            `active provider: ${workers.active ?? "(none)"}`,
            ...describeProviders(workers),
            "",
            ...tally,
            ...runningLines,
          ].join("\n")
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_providers",
    [
      "Manage worker providers (list, add, update, remove, use, enable, disable, test).",
      "",
      "action=list (default) shows providers (with cost tier and tags), classes and routing.",
      "Every loopback (local) provider is marked running or not running by an HTTP",
      "probe (GET /v1/models): an enabled provider that is not running is not usable — never pick a",
      "local provider by name; pass where: \"local\" to the delegation tools instead.",
      "action=add needs name, model — and either key_file or key, plus:",
      "  base_url (anthropic protocol) or upstream_url (protocol=openai, runs",
      "  through the local PAI proxy). A raw key is written to",
      "  ~/.pai/keys/<name> (mode 0600); only the path lands in the config.",
      "  engine=codex runs the Codex CLI instead of Claude Code; engine=opencode runs",
      "  the OpenCode CLI (any model PAI routes to, through the PAI router); engine=image POSTs",
      "  straight to {base_url}/images/generations instead of spawning a process —",
      "  pair it with a worker_capability image preference to run it.",
      "action=update changes cost_tier / tags of an existing provider.",
      "action=cap shows (no cap arg) or sets a provider's parallel cap (cap: integer >= 1, or \"default\" to unset),",
      "  writes maxConcurrent to workers.yaml and answers the effective cap and its source.",
      "action=test runs a one-word pong probe through the provider",
      "  (reports 'codex not installed' when that engine's CLI is missing).",
    ].join("\n"),
    {
      action: z
        .enum(["list", "add", "update", "remove", "use", "enable", "disable", "test", "cap", "hold", "release"])
        .optional()
        .describe("Default: list."),
      name: z.string().optional().describe("Provider name (required for every action but list)."),
      base_url: z.string().optional().describe("Anthropic-compatible API base URL (add)."),
      upstream_url: z.string().optional().describe("Chat Completions base URL (add, protocol=openai)."),
      protocol: z.enum(["anthropic", "openai"]).optional().describe("Protocol (add). Default: anthropic."),
      engine: z.enum(["claude", "codex", "opencode", "image"]).optional().describe("Runner engine (add). Default: claude."),
      context_window: z.number().int().positive().optional().describe("Context window for the meter (add). No default: unset hides the meter unless the init event announces one."),
      key_file: z.string().optional().describe("File holding the API token, 0600 (add)."),
      key: z.string().optional().describe("Raw API token (add) — parked in ~/.pai/keys/<name>."),
      model: z.string().optional().describe("Default model id (add)."),
      fast_model: z.string().optional().describe("Cheaper model for spotchecks (add, optional)."),
      env: z.record(z.string(), z.string()).optional().describe("Extra env for runs (add, optional)."),
      note: z.string().optional().describe("Human note shown in listings (add, optional)."),
      quota_probe: z.string().optional().describe("URL whose JSON first number is the quota percent (add, optional)."),
      cost_tier: z.number().int().min(1).max(5).optional().describe("Cost tier 1 (cheapest) … 5 (most expensive). Default 3. (add, update)"),
      tags: z.array(z.enum(["code", "vision", "image-gen", "long-context", "fast", "reasoning"])).optional().describe("Capability tags (add, update)."),
      cap: z.union([z.number().int().min(1), z.literal("default")]).optional().describe("Parallel cap (cap): integer >= 1, or \"default\" to unset. Omit to show."),
      reason: z.string().optional().describe("Why the provider is held (hold): new work queues, running work continues; benchmark-labelled runs pass."),
      slots: z.union([z.number().int().min(1), z.literal("default")]).optional().describe("Conversation-cache slots of the engine (cap): admitted workers stay one below it; \"default\" unsets."),
    },
    async (args) => {
      try {
        const action = args.action ?? "list";
        if (action === "list") {
          const { workers } = readWorkersSection();
          return workerText(describeProviders(workers, CONFIG_FILE, await probeLoopback(workers)).join("\n"));
        }
        if (!args.name) return workerError(new Error("name is required for this action"));
        if (action === "cap") {
          const { effective } = setProviderCap(args.name, args.cap, undefined, args.slots);
          return workerText(`provider ${args.name}: ${effective}`);
        }
        if (action === "hold") {
          if (!args.reason) return workerError(new Error("hold needs reason"));
          const p = holdProvider(args.name, args.reason);
          return workerText(`provider ${args.name}: ${holdText(p.hold!)}`);
        }
        if (action === "release") {
          releaseProvider(args.name);
          return workerText(`provider ${args.name}: released`);
        }
        if (action === "update") {
          if (args.cost_tier === undefined && args.tags === undefined) {
            return workerError(new Error("update needs cost_tier and/or tags"));
          }
          updateProvider(args.name, {
            ...(args.cost_tier !== undefined ? { costTier: args.cost_tier } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
          });
          const { workers: updated } = readWorkersSection();
          return workerText(
            [`provider ${args.name} updated`, ...describeProviders(updated, CONFIG_FILE, await probeLoopback(updated))].join("\n")
          );
        }
        if (action === "add") {
          if (!args.model) return workerError(new Error("add needs model"));
          if (args.protocol !== "openai" && !args.base_url) {
            return workerError(new Error("add needs base_url (only protocol=openai goes without it)"));
          }
          const workers = addProvider({
            name: args.name,
            baseUrl: args.base_url ?? "",
            keyFile: args.key_file ?? null,
            ...(args.key !== undefined ? { key: args.key } : {}),
            model: args.model,
            ...(args.fast_model ? { fastModel: args.fast_model } : {}),
            env: args.env ?? {},
            ...(args.note ? { note: args.note } : {}),
            ...(args.protocol ? { protocol: args.protocol } : {}),
            ...(args.upstream_url ? { upstreamUrl: args.upstream_url } : {}),
            ...(args.engine ? { engine: args.engine } : {}),
            ...(args.context_window ? { contextWindow: args.context_window } : {}),
            ...(args.quota_probe ? { quotaProbe: args.quota_probe } : {}),
            ...(args.cost_tier !== undefined ? { costTier: args.cost_tier } : {}),
            ...(args.tags?.length ? { tags: args.tags } : {}),
          });
          return workerText(
            [`provider ${args.name} added; active: ${workers.active ?? "(none)"}; workers ${workers.enabled ? "on" : "off"}`, ...describeProviders(workers, CONFIG_FILE, await probeLoopback(workers))].join("\n")
          );
        }
        if (action === "remove") {
          removeProvider(args.name);
          return workerText(`provider ${args.name} removed`);
        }
        if (action === "use") {
          const { repointed } = useProvider(args.name);
          return workerText(
            `active provider: ${args.name}${repointed ? `; ${repointed} class(es) re-pointed` : ""}`
          );
        }
        if (action === "enable" || action === "disable") {
          setProviderEnabled(args.name, action === "enable");
          return workerText(`provider ${args.name} ${action}d`);
        }
        // test
        const { workers } = readWorkersSection();
        const p = workers.providers[args.name];
        if (!p) return workerError(new Error(`no provider named "${args.name}"`));
        const r = await testProvider(args.name, p, workersLogDir(workers), undefined);
        if (r.skipped) {
          return workerText(
            `${r.provider} ${r.model}  ${r.skipped}\nreply: ${r.result.slice(0, 200)}`
          );
        }
        return workerText(
          `${r.provider} ${r.model}  ${(r.latencyMs / 1000).toFixed(1)}s\nreply: ${r.result.slice(0, 200)}\n${r.ok ? "OK" : "FAILED"}`
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_fallback",
    [
      "Machine-wide fallback: switch every NEW Claude Code process on this",
      "machine (interactive, task-bus, daemon summarizer) to a worker provider,",
      "or back to the Anthropic login.",
      "",
      "action=on switches (provider optional, default: active) by writing the",
      "provider's env into ~/.claude/settings.json — the token is read from its",
      "key file and then sits in settings.json until off. action=off restores",
      "settings.json exactly. action=status (default) shows on/off, provider,",
      "running sessions and the FALLBACK-ACTIVE.md note. Running sessions keep",
      "their provider until restarted. CLAUDE_SETTINGS_PATH retargets settings",
      "for dry runs. Subagent routing is unchanged while on.",
    ].join("\n"),
    {
      action: z.enum(["on", "off", "status"]).optional().describe("Default: status."),
      provider: z.string().optional().describe("Provider to switch to (on). Default: active."),
    },
    async (args) => {
      try {
        const action = args.action ?? "status";
        if (action === "status") {
          return workerText(fallbackStatusText(fallbackStatus()).join("\n"));
        }
        if (action === "on") {
          const r = fallbackOn(args.provider);
          return workerText(
            [
              r.alreadyOn
                ? `fallback already on — provider ${r.provider}, env re-applied`
                : `fallback on — provider ${r.provider}; every new Claude Code process uses it`,
              `settings.json env: ${r.envKeys.join(", ")}`,
              `model pin: ${r.model}`,
              "running sessions keep their current provider until restarted",
            ].join("\n")
          );
        }
        const r = fallbackOff();
        return workerText(
          `fallback off — provider ${r.provider} released, settings.json restored (${r.envKeys.join(", ")})`
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_classes",
    [
      "Manage worker classes (list, set, unset).",
      "",
      "A class maps a task class to a provider, optionally its fast model:",
      "implement=glm, research=glm, spotcheck=glm/fast.",
      "set can instead give routing constraints only (max_cost_tier,",
      "require_tags) — auto-routing then picks a qualifying provider.",
      "Runs pick the provider via --class first, then the active provider.",
    ].join("\n"),
    {
      action: z.enum(["list", "set", "unset"]).optional().describe("Default: list."),
      class: z.string().optional().describe("Class name (set/unset), e.g. implement, spotcheck."),
      target: z.string().optional().describe("Provider or provider/fast (set)."),
      max_cost_tier: z.number().int().min(1).max(5).optional().describe("Auto-routing considers only providers up to this cost tier (set)."),
      require_tags: z.array(z.enum(["code", "vision", "image-gen", "long-context", "fast", "reasoning"])).optional().describe("Auto-routing needs these tags (set)."),
    },
    async (args) => {
      try {
        const action = args.action ?? "list";
        if (action === "list") {
          const { workers } = readWorkersSection();
          const entries = Object.entries(workers.classes);
          return workerText(
            entries.length
              ? entries.map(([cls, t]) => `${cls}: ${classTargetText(t)}`).join("\n")
              : "no classes set"
          );
        }
        if (!args.class) return workerError(new Error("class is required for this action"));
        if (action === "set") {
          const hasConstraints = args.max_cost_tier !== undefined || args.require_tags !== undefined;
          if (!args.target && !hasConstraints) {
            return workerError(new Error("set needs target provider[/fast] and/or max_cost_tier/require_tags"));
          }
          const target =
            args.target !== undefined && !hasConstraints
              ? args.target
              : {
                  ...(args.target ? { provider: args.target.split("/")[0] } : {}),
                  ...(args.max_cost_tier !== undefined ? { maxCostTier: args.max_cost_tier } : {}),
                  ...(args.require_tags !== undefined ? { requireTags: args.require_tags } : {}),
                };
          setClass(args.class, target);
          return workerText(`class ${args.class} → ${classTargetText(target)}`);
        }
        unsetClass(args.class);
        return workerText(`class ${args.class} removed`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_model",
    [
      "Show or set a provider's model ids (the config behind `pai worker model`).",
      "",
      "action=get (default): the model ids of one provider (provider given,",
      "default: the active one) or of every provider when provider is omitted.",
      "action=set needs model; capability picks which one — the set is open",
      `(well-known: ${MODEL_CAPABILITIES.join(", ")}; any other ^[a-z][a-z0-9-]*$ name works too).`,
    ].join("\n"),
    {
      action: z.enum(["get", "set"]).optional().describe("Default: get."),
      provider: z.string().optional().describe("Provider to read or change (default: the active one)."),
      capability: z
        .string()
        .regex(CAPABILITY_NAME_RE)
        .optional()
        .describe(`Which model capability to set (open set; well-known: ${MODEL_CAPABILITIES.join(", ")}). Default: default.`),
      slot: z
        .enum(["default", "fast"])
        .optional()
        .describe("Deprecated pre-capability alias of `capability`."),
      model: z.string().optional().describe("The new model id (required for set)."),
    },
    async (args) => workerModel(args)
  );

  const profileTarget = z.object({ provider: z.string(), model: z.string().optional().describe("default | fast | a model id") });
  server.tool(
    "session_profile_get",
    "Show a session's model profile: chat model, worker provider/model, budget fallback list, parallel_min, and where the next worker spawn would run (with the reason). Default: this session.",
    { name: z.string().optional().describe("Session name (default: this session).") },
    async (args) => sessionProfileGet(args, await realSessionProfileDeps())
  );

  server.tool(
    "session_profile_set",
    [
      "Change a session's model profile (partial update; null clears a part). Default: this session.",
      "workers {provider, model}: where its workers run; takes effect on the next spawn.",
      "fallback [{provider, model?}]: ordered targets when the workers' provider runs out of budget.",
      "parallel_min: in batch fan-outs skip fallback targets whose concurrency cap is lower.",
      "max_parallel: most of this session's workers running at once, on any provider; 1 = one after the other, null/0 = parallel again.",
      "routes {class: [models]}: override routing rows for this session only (e.g. {implement: [\"anthropic/sonnet\"]}); null/[] for a class clears it, routes null clears all. Reason: cloud before local for context width and reasoning.",
      "chat {provider, model}: the session's default chat model, applied when it next starts; apply_now sends /model into the running session.",
    ].join("\n"),
    {
      name: z.string().optional().describe("Session name (default: this session)."),
      chat: profileTarget.nullable().optional(),
      workers: profileTarget.nullable().optional(),
      fallback: z.array(profileTarget).nullable().optional(),
      parallel_min: z.number().int().min(0).nullable().optional(),
      max_parallel: z.number().int().min(0).nullable().optional(),
      routes: z.record(z.string(), z.array(z.string()).nullable()).nullable().optional(),
      apply_now: z.boolean().optional().describe("With chat: also send /model <m> into the running session."),
    },
    async (args) => sessionProfileSet(args, await realSessionProfileDeps())
  );

  server.tool(
    "worker_capability",
    [
      "Which provider(s) serve a capability across the whole config (the",
      "config behind `pai worker capability`) — distinct from worker_model,",
      "which sets a model id on one provider's own table.",
      "",
      "action=list (default): every preference and what it resolves to now.",
      "action=set needs capability, providers (first usable one wins).",
      "action=unset needs capability. E.g. set capability=image,",
      "providers=[\"pictures\"] to run worker_run with capability=image against",
      "an engine=image provider named \"pictures\".",
    ].join("\n"),
    {
      action: z.enum(["list", "set", "unset"]).optional().describe("Default: list."),
      capability: z.string().optional().describe("Capability name, e.g. image (required for set, unset)."),
      providers: z.array(z.string()).optional().describe("Preference list, first usable one wins (required for set)."),
    },
    async (args) => workerCapability(args)
  );

  server.tool(
    "local_status",
    "Which local model is running now, its model, and which local providers are down or disabled (the daemon's answer, refreshed every 30 s). Never probe ports or start model servers; worker_run with local: true runs on the running one.",
    {},
    async () => {
      const r = localStatusReport(await currentLocalStatus());
      return { content: [{ type: "text" as const, text: `${r.text}\n${JSON.stringify(r.json)}` }] };
    }
  );

  server.tool(
    "models_list",
    "Every local model runtime on this machine (loopback worker providers, ollama, Docker Model Runner): status, loaded and installed models, kind, memory, who uses each and the port, plus a duplicates hint when two runtimes serve the same job. Read-only, the daemon's 30 s answer; never loads a model.",
    {},
    async () => {
      const inv = await currentInventory();
      const rows = inventoryRows(inv).map((r) => r.join(" | "));
      const text = [INVENTORY_HEADERS.join(" | "), ...rows, ...inv.duplicates.map((d) => `duplicates: ${d}`)].join("\n");
      return { content: [{ type: "text" as const, text: `${text}\n${JSON.stringify(inv)}` }] };
    }
  );

  server.tool(
    "worker_run",
    [
      "Start a worker (or a chain) and return its id immediately.",
      "",
      "This is the chat-side face of `pai worker run`: label is required, and",
      "exactly one of prompt/specPath (the -p value, or a file/stdin '-' to read",
      "it from — avoids quoting long prompts through JSON-RPC). chain (e.g.",
      "\"draft,implement\") runs spec-first stages, class picks the provider",
      "(default: active); capability=image runs an engine=image provider",
      "directly instead, writing a PNG rather than spawning claude.",
      "Check on it with worker_ps / worker_replay, talk to it with worker_say.",
    ].join("\n"),
    workerRunShape,
    async (args) => {
      try {
        const cwd = args.cwd ?? process.cwd();
        let promptText: string;
        let specPath: string | undefined;
        try {
          ({ promptText, specPath } = resolveWorkerRunPrompt(args, cwd));
        } catch (e) {
          return workerError(e);
        }
        const claudeArgs = [
          "-p", promptText,
          ...(args.allowed_tools ? ["--allowedTools", args.allowed_tools] : []),
        ];
        // the id resolves the moment the worker (or chain) exists; config
        // errors surface through the same channel as an empty id
        let startedIdResolve!: (id: string) => void;
        let startupFailure: unknown = null;
        const idArrived = new Promise<string>((resolve) => {
          startedIdResolve = resolve;
        });
        const background = async (): Promise<number> => {
          if (args.chain) {
            return runChain({
              stages: args.chain.split(","),
              className: args.class,
              label: args.label,
              ...(args.no_pool ? { noPool: true } : {}),
              ...(args.priority ? { queuePriority: args.priority } : {}),
              mcpFlag: args.mcp,
              specPath,
              brief: promptText,
              claudeArgs,
              ...(args.cwd ? { cwd: args.cwd } : {}),
              onChainStart: (id) => startedIdResolve(id),
              quiet: true,
            });
          }
          return runWorker({
            className: args.class,
            capabilityFlag: args.capability,
            label: args.label,
            ...(args.no_pool ? { noPool: true } : {}),
            ...(args.priority ? { queuePriority: args.priority } : {}),
            mcpFlag: args.mcp,
            specPath,
            claudeArgs,
            ...(args.cwd ? { cwd: args.cwd } : {}),
            onWorkerStart: (wid) => startedIdResolve(wid),
            quiet: true,
          });
        };
        background().catch((e) => {
          startupFailure = e;
          startedIdResolve("");
        });
        const id = await Promise.race([
          idArrived,
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("worker did not start within 15s")), 15_000)
          ),
        ]);
        if (!id) {
          return workerError(startupFailure ?? new Error("worker failed to start"));
        }
        return workerText(
          `${id} started${args.chain ? ` (chain: ${args.chain})` : ""} — check on it with worker_ps, worker_replay, worker_say`
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_handoff",
    [
      "From inside a worker: send a handoff up to the parent worker.",
      "",
      "kind: proposal (do this instead of me), question, blocker, or result",
      "(results are sent for you when you finish — only send one yourself for",
      "mid-run findings). The handoff lands in the parent's inbox and is said to",
      "it when it is still running. Outside a worker this fails — there is no",
      "sideways or downward path.",
    ].join("\n"),
    {
      kind: z.enum(["proposal", "result", "question", "blocker"]).describe("What the handoff carries."),
      text: z.string().min(1).describe("The message body, one paragraph."),
      data: z.record(z.string(), z.unknown()).optional().describe("Structured payload (optional)."),
      local: z.boolean().optional().describe("Same as where: \"local\"."),
      ...whereArgs,
    },
    async (args) => {
      try {
        // where/model/now ride up in the payload: the parent's delegation tools
        // take them with the same meaning (resolveTarget); resolved here too so
        // the result says where the proposal would run
        const asked = args.local === true || args.where || args.model || args.now === true;
        const where = args.where ?? (args.local === true ? "local" : undefined);
        const target = asked ? await resolveTarget({ where, model: args.model, now: args.now }) : undefined;
        const h = await handoffFromInside(
          workersLogDir(readWorkersSection().workers),
          process.env,
          asked ? { ...args, data: { ...(args.data ?? {}), ...(where ? { where } : {}), ...(args.model ? { model: args.model } : {}), ...(args.now ? { now: true } : {}) } } : args
        );
        return workerText(withTarget(target, `ok → ${h.to} (${h.kind}); the parent sees it in its inbox`));
      } catch (e) {
        return workerError(e);
      }
    }
  );

  // Delegation tools for tier 0 (direct library calls, see tools/delegation.ts)
  const localArg = z.boolean().optional().describe("Same as where: \"local\".");
  const delegation = realDelegationDeps();
  const project = z.string().min(1).describe("Project slug or checkout folder.");
  const planName = z.string().min(1).describe("Plan name (folder under <project>/.pai/plans/).");
  const idsArg = z.array(z.string().min(1)).min(1).describe("Queue item ids, e.g. [\"q3\"].");

  server.tool(
    "plan_save",
    "Save a plan you wrote (units of parts, each with a spec, files, proof, depends_on, overlap; a gate for the merged tree), validate it and get the schedule in plain words. Use for larger jobs. Mark parts that do not depend on the part before them with overlap: true so the local model does not idle during that part's gate and merge.",
    {
      project,
      name: planName,
      plan: z.object({
        gate: z.string().describe("Shell command that must pass on the merged tree."),
        provider: z.string().optional().describe("Provider name; prefer where. Never pick a local provider by name — use where: \"local\"."),
        local: localArg,
        ...whereArgs,
        max_parallel: z.number().int().min(1).optional(),
        preamble: z.string().optional().describe("Text prepended to every part spec."),
        units: z.array(z.object({
          id: z.string(),
          preamble: z.string().optional(),
          unit_check: z.string().optional().describe("Command run after the unit's last part merged."),
          parts: z.array(z.object({
            id: z.string(),
            spec: z.string().describe("The task text for the worker."),
            files: z.array(z.string()).optional().describe("Paths the part touches; parts sharing a file never run together."),
            proof: z.string().optional().describe("Command the worker must run and show passing."),
            depends_on: z.array(z.string()).optional(),
            risky: z.boolean().optional(),
            overlap: z.boolean().optional().describe("Default false. Mark a part that is independent of the part before it: its worker starts as soon as that part's worker has ended, while the gate and merge still run (the local engine serves one worker at a time, this fills its idle time). Rejected if it depends on that part; its merge waits for it."),
          })).min(1),
        })).min(1),
      }),
    },
    async (args) => planSave(args, delegation)
  );
  server.tool(
    "plan_run",
    "Start a saved plan in the background and return at once; merged parts are skipped on a re-run. Follow with plan_status.",
    { project, name: planName, escalate: z.boolean().optional().describe("After the local retry, run one Sonnet worker instead of stopping at needs-decision."), local: localArg, ...whereArgs },
    async (args) => planRun(args, delegation)
  );
  server.tool(
    "plan_status",
    "Plain-language status of a plan: done, running, waiting, needs-decision with the failure tail, wall time, escalations.",
    { project, name: planName },
    async (args) => planStatusText(args, delegation)
  );
  server.tool(
    "plan_stop",
    "Stop a running plan gracefully: no new part starts, the in-flight parts finish and merge, then the run ends. plan_run resumes it.",
    { project, name: planName },
    async (args) => planStop(args, delegation)
  );
  server.tool(
    "plan_amend",
    "Append a clarification to a part's spec (what you do at a needs-decision); the next plan_run resumes. A part's overlap flag (start its worker while the previous part is gated) is set in plan_save, not here.",
    { project, name: planName, part: z.string().min(1), spec_append: z.string().min(1) },
    async (args) => planAmend(args, delegation)
  );
  server.tool(
    "queue_add",
    "Queue one small change described in a sentence (plus likely files, optional screenshot). Use for small changes; then queue_run.",
    {
      project,
      sentence: z.string().min(1),
      files: z.array(z.string()).optional(),
      image: z.string().optional(),
      local: localArg,
      ...whereArgs,
    },
    async (args) => queueAdd(args, delegation)
  );
  server.tool(
    "queue_run",
    "Start the pending queue items on the local provider in the background and return at once; nothing is merged.",
    {
      project,
      escalate: z.boolean().optional().describe("Run the items marked cloud on Sonnet instead."),
      local: localArg,
      ...whereArgs,
    },
    async (args) => queueRun(args, delegation)
  );
  server.tool("queue_review", "Ready queue items with diff stat, gate result and proof path, in plain words.", { project }, async (args) => queueReview(args, delegation));
  server.tool("queue_accept", "Merge ready queue items with the project's gate.", { project, ids: idsArg }, async (args) => queueAccept(args, delegation));
  server.tool("queue_reject", "Drop queue items.", { project, ids: idsArg, why: z.string().optional() }, async (args) => queueReject(args, delegation));
  server.tool(
    "queue_again",
    "Re-queue an item with what is still wrong; after two rounds it is marked for the cloud.",
    { project, id: z.string().min(1), note: z.string().min(1) },
    async (args) => queueAgain(args, delegation)
  );

  server.tool(
    "worker_toggle",
    [
      "Turn worker routing on or off.",
      "",
      "off: the Agent-tool hook stops denying, subagents run on Anthropic.",
      "on: subagents are denied and rewritten to `pai worker run`.",
    ].join("\n"),
    {
      enabled: z.boolean().describe("true = route subagents to workers, false = Anthropic."),
    },
    async (args) => {
      try {
        const workers = setWorkersEnabled(args.enabled);
        return workerText(
          `workers ${workers.enabled ? "on" : "off"} — Agent subagents ${workers.enabled ? "denied and rewritten to `pai worker run`" : "run on Anthropic"}`
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_ps",
    [
      "List workers: running (id, provider, age, turns, current tool) and the last finished.",
      "",
      "Use this to check on delegated `pai worker run` calls; worker_replay shows",
      "the transcript of one worker.",
    ].join("\n"),
    {
      all: z.boolean().optional().describe("Show workers of all sessions (default: this one's)."),
    },
    async (args) => {
      try {
        const { workers } = readWorkersSection();
        return workerText(psOutput(workersLogDir(workers), args.all === true, {}, false));
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_queue",
    [
      "The provider capacity queue: workers waiting for a provider slot.",
      "",
      "action=list (default) shows the grant order per provider; action=next",
      "(alias front) makes a waiting worker run next, action=up moves it one place up.",
      "Only the order of the WAITING ones changes — a running worker is never interrupted.",
    ].join("\n"),
    {
      action: z.enum(["list", "next", "front", "up"]).optional().describe("list (default), next (alias front) or up."),
      id: z.string().optional().describe("Worker id to pull forward (with next/up)."),
    },
    async (args) => {
      try {
        const { workers } = readWorkersSection();
        const logDir = workersLogDir(workers);
        const action = args.action ?? "list";
        if (action === "list") {
          const rows = queueRows(logDir, providerCaps(workers));
          if (!rows.length) return workerText(["nothing waiting", ...schedulerLines(schedulerView(logDir, workers))].join("\n"));
          let prov = "";
          const lines: string[] = [];
          for (const r of rows) {
            if (r.provider !== prov) {
              prov = r.provider;
              lines.push(`${prov}${r.cap !== undefined ? ` (cap ${r.cap})` : ""}:`);
            }
            const s = r.status;
            lines.push(
              `  ${r.position}. ${r.id}` +
                (r.priority && r.priority !== "normal" ? `  [${r.priority} priority]` : "") +
                (s ? `  ${s.label}  ${s.cwd.split("/").pop() ?? s.cwd}  waited ${r.since === undefined ? ageOf(s.updated) : ageOf(nowStamp(new Date(r.since)))}` : "") +
                `  position ${r.position} of ${r.queued}`
            );
          }
          lines.push(...schedulerLines(schedulerView(logDir, workers)));
          return workerText(lines.join("\n"));
        }
        if (!args.id) return workerError(new Error("id is required for next/up"));
        const status = loadStatus(logDir, args.id);
        if (!status) return workerError(new Error(`no worker named "${args.id}"`));
        const order = reorderQueue(logDir, status.provider, args.id, action === "up" ? "up" : "front");
        return workerText(`${args.id} is now position ${order.indexOf(args.id) + 1} of ${order.length} on ${status.provider}`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "build_queue",
    [
      "The machine-wide build queue: builds (builds.slots, default 1) and simulator/device test runs (builds.testSlots, default 2) are separate pools, FIFO.",
      "",
      "action=list (default) shows the running and waiting builds; action=next gives a",
      "waiting build (id) the next free slot. A running build is never interrupted.",
    ].join("\n"),
    {
      action: z.enum(["list", "next"]).optional().describe("list (default) or next."),
      id: z.string().optional().describe("Build id (or the label of a waiting build) for next."),
    },
    async (args) => {
      try {
        const dir = buildsDir();
        if ((args.action ?? "list") === "next") {
          if (!args.id) return workerError(new Error("id is required for next"));
          const order = await buildNext(dir, args.id);
          return workerText(`waiting order: ${order.join(", ") || "-"}`);
        }
        return workerText(renderBuildQueue(await listBuilds(dir), poolSlots()));
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_replay",
    [
      "Replay the transcript of one worker: tool calls, short outputs, result.",
      "",
      "Plain text, no colors. Use tail to cap the output.",
    ].join("\n"),
    {
      id: z.string().describe("Worker id (as shown by worker_ps)."),
      tail: z.number().int().min(1).max(2000).optional().describe("Last N rendered lines. Default: all."),
    },
    async (args) => {
      try {
        const { workers } = readWorkersSection();
        return workerText(replayOutput(workersLogDir(workers), args.id, false, args.tail));
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_say",
    [
      "Send one message to a RUNNING worker: it lands on the worker's open stdin",
      "as a user message, mid-run, without breaking its stream.",
      "",
      "Fails with an explanation when the worker already finished — then use",
      "worker_resume (or `pai worker resume <id> \"text\"`) instead.",
    ].join("\n"),
    {
      id: z.string().describe("Worker id (as shown by worker_ps)."),
      text: z.string().min(1).describe("The message to send (one line)."),
      goal: z.string().optional().describe("Relabel the worker (its ps / pane goal) before sending the message."),
    },
    async (args) => {
      try {
        const { workers } = readWorkersSection();
        const logDir = workersLogDir(workers);
        if (args.goal !== undefined) setWorkerLabel(logDir, args.id, args.goal);
        await sayToWorker(logDir, args.id, args.text);
        return workerText(`sent to ${args.id}`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_priority",
    [
      "Change a RUNNING worker's priority (high, normal, low) at the local engine.",
      "",
      "The router admits high before normal before low at a serial engine and reads the level at every request, so the change applies to the worker's next request. Nothing is interrupted.",
    ].join("\n"),
    {
      id: z.string().describe("Worker id (as shown by worker_ps)."),
      level: z.enum(["high", "normal", "low"]).describe("The new priority."),
    },
    async (args) => {
      try {
        const from = setWorkerPriority(workersLogDir(readWorkersSection().workers), args.id, args.level, "mcp");
        return workerText(`${args.id}: ${from} -> ${args.level}`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_reroute",
    [
      "Move a QUEUED or RUNNING worker to another provider.",
      "",
      "where=cloud is the session's cloud provider, local the running local model, or a provider name. A queued worker's task starts on the target; a running worker is stopped (its commits stay on its branch) and the same task continues there.",
    ].join("\n"),
    {
      id: z.string().describe("Worker id (as shown by worker_ps)."),
      where: z.string().describe("cloud, local or a provider name."),
    },
    async (args) => {
      try {
        const { rerouteWorker } = await import("../workers/reroute.js");
        const r = await rerouteWorker(args.id, args.where, { logDir: workersLogDir(readWorkersSection().workers), by: "mcp" });
        return workerText(`${r.id}: ${r.was} -> started again on ${r.provider}${r.branch ? ` (continues branch ${r.branch})` : ""}`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_pause",
    [
      "Pause a RUNNING worker's engine requests: its next request to the local engine parks in the router until worker_resume (without text). The request in flight finishes; nothing is killed.",
    ].join("\n"),
    { id: z.string().describe("Worker id (as shown by worker_ps).") },
    async (args) => {
      try {
        const changed = setWorkerPaused(workersLogDir(readWorkersSection().workers), args.id, true, "mcp");
        return workerText(changed ? `${args.id}: paused` : `${args.id}: already paused`);
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_resume",
    [
      "Continue a FINISHED worker with a follow-up message: claude --resume on the",
      "same provider, same Claude session, context intact.",
      "",
      "Returns the new worker id. Not for running workers — say to those instead.",
      "",
      "Without text it releases a worker paused with worker_pause instead.",
    ].join("\n"),
    {
      id: z.string().describe("Worker id of the finished run (as shown by worker_ps)."),
      text: z.string().min(1).optional().describe("The follow-up message (omit to release a paused worker)."),
    },
    async (args) => {
      try {
        const { workers } = readWorkersSection();
        const logDir = workersLogDir(workers);
        if (args.text === undefined) {
          return workerText(setWorkerPaused(logDir, args.id, false, "mcp") ? `${args.id}: resumed` : `${args.id}: was not paused`);
        }
        const text = args.text;
        const old = loadStatus(logDir, args.id);
        if (!old) return workerError(new Error(`no worker named "${args.id}"`));
        if (old.state === "running" || old.state === "queued") {
          return workerError(
            new Error(`worker ${args.id} is still running — send messages with worker_say`)
          );
        }
        if (!old.claudeSession) {
          return workerError(
            new Error(
              `worker ${args.id} recorded no Claude session id — it predates resume support ` +
                `or ran through an engine that does not expose one`
            )
          );
        }
        let newId = "";
        const rc = await runWorker({
          providerFlag: old.provider,
          modelFlag: old.model,
          label: `↩ ${old.label}`,
          claudeArgs: ["--resume", old.claudeSession, "-p", text],
          resumeOf: args.id,
          onWorkerStart: (wid) => {
            newId = wid;
          },
        });
        return workerText(
          `resumed ${args.id} as ${newId || "(unknown id)"} — rc=${rc}\ncheck on it with worker_ps / worker_replay`
        );
      } catch (e) {
        return workerError(e);
      }
    }
  );

  server.tool(
    "worker_kill",
    "Stop a RUNNING or queued worker and every live descendant (`pai worker kill`): SIGTERM, then SIGKILL; a pooled worker is stopped through the pool host. A session may only kill workers it started; force=true with a reason overrides.",
    {
      id: z.string().describe("Worker id (as shown by worker_ps)."),
      only: z.boolean().optional().describe("Kill only this worker, leave its children running."),
      force: z.boolean().optional().describe("Kill another session's worker (needs reason)."),
      reason: z.string().min(1).describe("Why; required, recorded in the worker's event log and pai worker ps."),
    },
    async (args) => workerKill(args)
  );

  server.tool(
    "worker_merge",
    "Merge a finished worker's branch into its checkout (`pai worker merge`): verify command (default workers.yaml merge.verify), stub scan, related tests, then dist rebuild when it lands in the running PAI. A failing gate reverts (verify) or keeps the merge and reports the failing files (related tests).",
    {
      id: z.string().describe("Worker id."),
      no_commit: z.boolean().optional().describe("Stage the merge without committing."),
      verify: z.string().optional().describe("Command to run on the merged tree; a non-zero exit reverts the merge."),
      no_verify: z.boolean().optional().describe("Skip the configured merge.verify default."),
      no_verify_tests: z.boolean().optional().describe("Skip the related-tests check for this merge."),
      no_build: z.boolean().optional().describe("Do not rebuild dist/ after merging into the running PAI checkout."),
    },
    async (args) => workerMerge(args)
  );

  server.tool(
    "battery_status",
    "The battery guard (power.batteryGuard.*): last reading, whether new local-model work is paused or stopped and why, a benchmark last-resort stop, and the live <PAI home>/state/benchmark-run.json marker. Also the latest power telemetry line and, over a window, max/average system power in and load, max battery drain and minimum charge. Also the keep-above gate (power.batteryGuard.keepAbovePct/resumeAtPct) and the stored charge-rate calibration; action=calibrate measures the idle charge rate over `minutes` (refused while a local worker runs; load=true measures under load) and stores it, action=wait pauses up to `minutes` one-minute steps until the battery allows the next local job.",
    {
      window_hours: z.number().min(0).max(336).optional().describe("Telemetry window in hours (default 12, max 14 days = 336)."),
      action: z.enum(["status", "calibrate", "wait"]).optional().describe("status (default), calibrate or wait."),
      minutes: z.number().min(0).max(30).optional().describe("calibrate: window in minutes (default 10); wait: at most this many 1-minute pauses (default 0 = check only)."),
      load: z.boolean().optional().describe("calibrate: measure under the current load instead of idle."),
      above: z.number().optional().describe("wait: keep-above level (default config)."),
      resume: z.number().optional().describe("wait: resume level (default config)."),
    },
    async (args) => batteryStatus(args)
  );

  server.tool(
    "worker_gc",
    "Archive leftover worker worktrees (`pai worker gc`). Dry run by default: pass dry_run=false to change anything. foreign=true also archives merged, clean worktrees of the current repo PAI did not create; pool=true also removes leftover pool reserve worktrees.",
    {
      older_than_hours: z.number().min(0).optional().describe("Minimum age of a finished worker (default 24)."),
      all_finished: z.boolean().optional().describe("Any finished worker regardless of age."),
      pool: z.boolean().optional().describe("Also remove leftover pool reserve worktrees."),
      foreign: z.boolean().optional().describe("Also archive merged, clean worktrees PAI did not create."),
      kill_orphans: z.boolean().optional().describe("End processes sitting in a finished worker's worktree (ignored on a dry run)."),
      dry_run: z.boolean().optional().describe("Default true: print what would be archived, change nothing."),
    },
    async (args) => workerGc(args)
  );

  server.tool(
    "pool_status",
    "The worker pool (`pai worker pool status`): config, host, slots, carry and why recent runs were not pooled.",
    {},
    async () => poolStatus()
  );

  server.tool(
    "tests_audit",
    "Audit a repo's tests (`pai tests audit`): every test file (unit, UI/simulator targets, snapshot baselines, run outputs) with a proposed class KEEP-a (fix evidence) / KEEP-b (security or destructive guard) / KEEP-c (external contract) or DROP, the test-file count per month, and a proposed tests/KEPT.md. Read-only; never runs a test. First step of `clean up tests`.",
    { repo: z.string().optional().describe("Repository path (default: the current project).") },
    async (args) => testsAudit(args)
  );

  server.tool(
    "tests_prune",
    "Prune a repo's tests to the governed core (`pai tests prune`). Without apply it returns the plan. With apply=true it starts a worker (orchestrate class) in the repo that git rm's the DROP files, writes tests/KEPT.md, keeps the test script and build working and makes one commit on its own branch; it does not merge, the user lands it. Run tests_audit first and show the user the result; apply only when they asked to clean up tests.",
    {
      repo: z.string().optional().describe("Repository path (default: the current project)."),
      apply: z.boolean().optional().describe("Start the pruning worker (default false: plan only)."),
    },
    async (args) => testsPrune(args)
  );

  server.tool(
    "release",
    "Cut a release of a repo (`pai release`): refuses a dirty tree or a branch other than main; bumps, builds, runs unit tests, commits `chore: release <v>`, tags, pushes to the forge, syncs the push mirror, waits for the tag on GitHub, then creates a GitHub Release with the packed package attached. Pass dry_run=true to get the plan only. A real run pushes and publishes: only call it when the user asked for a release.",
    {
      repo: z.string().optional().describe("Repository path (default: the daemon's working directory)."),
      bump: z.string().optional().describe("patch (default), minor, major or an explicit x.y.z."),
      dry_run: z.boolean().optional().describe("Print the plan, change nothing."),
    },
    async (args) => release(args)
  );

  server.tool(
    "update_check",
    "Whether a newer GitHub Release exists for an installed package (`pai update --check`). Installs nothing.",
    { package: z.string().optional().describe("Package name (default: pai), e.g. aibroker.") },
    async (args) => updateCheck(args)
  );

  server.tool(
    "daemon_service",
    "The PAI daemon service (`pai daemon status|start|stop|restart`). stop leaves it stopped until start: scheduler passes and router supervision do not run meanwhile.",
    { action: z.enum(["status", "start", "stop", "restart"]).optional().describe("Default: status.") },
    async (args) => daemonService(args)
  );

  server.tool(
    "router_service",
    "The local model router (`pai router status|start|stop|restart`). restart hands the port over without refusing connections.",
    { action: z.enum(["status", "start", "stop", "restart"]).optional().describe("Default: status.") },
    async (args) => routerService(args)
  );

  server.tool(
    "model_runtime",
    "Start or stop a local model runtime through its configured models.runtimes.<runtime> commands (`pai models start|stop`, the cockpit runtime action); status lists runtimes (all, or one) from the inventory. Refuses on short memory or requests in flight.",
    {
      runtime: z.string().optional().describe("Runtime name (required for start, stop)."),
      action: z.enum(["status", "start", "stop"]).optional().describe("Default: status."),
      model: z.string().optional().describe("start/stop: the model to load or unload (docker model run|unload)."),
    },
    async (args) => modelRuntime(args)
  );

  server.tool(
    "memory_run",
    "Memory index maintenance (the cockpit memory.* actions): action=embed computes vectors for the whole backlog, index reads notes and memory files now, stop ends a run started by the cockpit/CLI/this tool (resumable), status shows the run and the embed backlog. Refuses while another run is active.",
    { action: z.enum(["status", "embed", "index", "stop"]).optional().describe("Default: status.") },
    async (args) => memoryRun(args)
  );

  // -------------------------------------------------------------------------
  // Tools: config_* — the main PAI config (config.yaml/config.json), the
  // same src/config/main-config-ops.ts functions `pai config` calls on the
  // CLI. Direct library calls, no daemon IPC.
  // -------------------------------------------------------------------------

  server.tool(
    "config_list",
    [
      "Print the main PAI config as YAML (or JSON). Secrets (key/token/secret/",
      "password fields, and postgres.connectionString) are always masked to",
      "****<last4>. Defaults to only what the file explicitly sets; all=true",
      "includes every built-in default value too.",
    ].join("\n"),
    {
      all: z.boolean().optional().describe("Include every default value, not just what the file sets. Default: false."),
      json: z.boolean().optional().describe("Return JSON instead of YAML. Default: false."),
    },
    async (args) => configList(args)
  );

  server.tool(
    "config_get",
    [
      "Read one config value by dotted path (e.g. search.recencyBoostDays).",
      "Resolves against the defaults-merged effective config, so a value never",
      "set in the file still answers with its built-in default. Masked",
      "(****<last4>) if the path looks like a secret.",
    ].join("\n"),
    {
      path: z.string().min(1).describe("Dotted config path, e.g. search.recencyBoostDays."),
    },
    async (args) => configGet(args)
  );

  server.tool(
    "config_set",
    [
      "Write one config value by dotted path. WRITES THE FILE: creates",
      "config.yaml on first use (converting config.json if it exists), then",
      "writes comment-preserving. Value parsing: true/false, null, numbers,",
      "[...] / {...} as JSON, else a plain string. Refuses an unknown",
      "top-level key or a value whose type disagrees with the built-in",
      "default unless force=true.",
    ].join("\n"),
    {
      path: z.string().min(1).describe("Dotted config path, e.g. search.recencyBoostDays."),
      value: z.string().describe("Value to set, as a string (parsed per the rules above)."),
      force: z.boolean().optional().describe("Allow an unknown top-level key or a type mismatch. Default: false."),
    },
    async (args) => configSet(args)
  );

  server.tool(
    "config_unset",
    [
      "Remove one config value by dotted path, WRITING THE FILE — reverting it",
      "to the built-in default. No-ops when the path was never explicitly set.",
    ].join("\n"),
    {
      path: z.string().min(1).describe("Dotted config path, e.g. search.recencyBoostDays."),
    },
    async (args) => configUnset(args)
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
