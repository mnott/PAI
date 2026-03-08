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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PaiClient } from "../daemon/ipc-client.js";
import { loadConfig } from "../daemon/config.js";

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

// ---------------------------------------------------------------------------
// MCP instructions — shipped skill summaries for all PAI workflows
// ---------------------------------------------------------------------------

const PAI_INSTRUCTIONS = [
  "## PAI — Personal AI Infrastructure",
  "",
  "This MCP server provides PAI's federated memory, project registry, and session management.",
  "PAI also ships the following skill workflows that activate automatically based on user intent.",
  "",
  "---",
  "",
  "## CORE Operating Rules",
  "",
  "**Response modes:** Classify every request before responding.",
  "- MINIMAL: greetings, acks, simple yes/no → 1-3 sentences, no structure",
  "- STANDARD: single-step tasks, quick lookups → direct answer only",
  "- FULL: multi-step work, research, implementation (3+ tools) → SUMMARY / ANALYSIS / ACTIONS / RESULTS / STATUS / NEXT / COMPLETED",
  "",
  "**Session lifecycle commands:**",
  "- `go` / `continue` / `weiter` → read Notes/TODO.md, look for `## Continue` section first, resume from there",
  "- `pause session` → summarize state, update TODO.md, write `## Continue` section at top, stop",
  "- `end session` → pause procedure + rename session note to describe work done (NEVER leave as 'New Session')",
  "- `cpp` → `git add . && git commit -m 'feat: ...' && git push` (no AI signatures in commit messages)",
  "",
  "**Session note format:** `NNNN - YYYY-MM-DD - Descriptive Work Done.md`",
  "WRONG: `0027 - 2026-01-04 - New Session.md` | RIGHT: `0027 - 2026-01-04 - Reranker Implementation.md`",
  "",
  "**Git commit rules:** NEVER include 'Generated with Claude Code', Co-Authored-By lines, or emoji signatures.",
  "Format: `<type>: <description>` — types: feat, fix, refactor, docs, test, chore, style",
  "",
  "**Stack preferences:** TypeScript > Python, bun for JS/TS, uv for Python. Never npm/yarn/pnpm/pip.",
  "",
  "**Security:** Two repos — PRIVATE (~/.pai, personal data) and PUBLIC (~/Projects/PAI, sanitized). Never commit private data to public repo. Run `git remote -v` before every push.",
  "",
  "**Token management:** After 5+ sequential tool calls, self-assess context usage. If >60% full, self-summarize. If >80%, checkpoint and suggest /clear.",
  "",
  "**Compaction resilience:** Write GOAL.md before non-trivial work. Update TODO.md in real-time with [~] for in-progress items. Checkpoint after major milestones.",
  "",
  "**Fact-checking:** Mark unverified AI-sourced claims with ⚠️ Unverified. Always verify against official sources.",
  "",
  "**Permission to fail:** Say 'I don't know' when information isn't available. Never fabricate.",
  "",
  "**History lookup:** When asked about past work, search `${PAI_DIR}/History/` first.",
  "",
  "---",
  "",
  "## Review Skill",
  "",
  "USE WHEN user says 'review', 'what did I do', 'this week', 'weekly review', 'daily review', 'monthly review', 'what have we achieved', 'reflect', 'retrospective', 'recap', '/review', OR asks about accomplishments over a time period.",
  "",
  "**Commands:**",
  "| Subcommand | Period |",
  "|------------|--------|",
  "| `/review today` | Today |",
  "| `/review week` | Current week (Mon-Sun), DEFAULT if no period |",
  "| `/review month` | Current calendar month |",
  "| `/review year` | Current calendar year |",
  "",
  "**Data sources:** Session notes (`~/.claude/projects/*/Notes/`), git commits, completed TODO items `[x]`, journal entries (`${PAI_DIR}/Journal/`), SeriousLetter jobs (if available), Todoist completed tasks (if available), calendar events (if available).",
  "",
  "**Output format:** Group by THEME not chronology. Sections: project themes, job search, personal, key decisions, numbers (sessions/commits/tasks). Second-person voice ('You built...', 'You applied to...'). Highlight completed and shipped items.",
  "",
  "**WhatsApp:** Condensed, bold headers, under 2000 chars. Voice: 30-60 sec conversational summary, top 3-5 achievements.",
  "",
  "---",
  "",
  "## Journal Skill",
  "",
  "USE WHEN user says 'journal', 'note to self', 'capture this thought', 'journal entry', 'I want to write down', 'reflect on', 'yaja', '/journal', OR wants to record a freeform observation, insight, or personal note.",
  "",
  "**Commands:**",
  "| Command | Action |",
  "|---------|--------|",
  "| `/journal` | Create new entry |",
  "| `/journal read` | Read today's entries |",
  "| `/journal search <query>` | Search past entries |",
  "",
  "**Storage:** `${PAI_DIR}/Journal/YYYY/MM/YYYY-MM-DD.md` — one file per day, entries appended with `---` separators.",
  "",
  "**Entry format:** `**HH:MM** — [content]\\n\\n#tags`",
  "",
  "**Auto-tagging:** active project → `#project-name`, work → `#work`, mood → `#reflection`, idea → `#idea`, person → `#people`.",
  "",
  "**Rules:** Append-only. Never edit or delete existing entries. Preserve the user's voice — do not paraphrase. Voice entries via WhatsApp: clean up filler words, confirm with `whatsapp_tts`.",
  "",
  "---",
  "",
  "## Plan Skill",
  "",
  "USE WHEN user says 'plan', 'what should I focus on', 'plan tomorrow', 'plan my week', 'what\\'s next', 'priorities', 'focus areas', '/plan', OR asks about upcoming work priorities or wants to set intentions for a time period.",
  "",
  "**Commands:**",
  "| Subcommand | Scope |",
  "|------------|-------|",
  "| `/plan tomorrow` | Next day, DEFAULT |",
  "| `/plan week` | Next 7 days |",
  "| `/plan month` | Next 30 days |",
  "",
  "**Data sources:** Open TODO items `[ ]`, in-progress items `[~]`, calendar events, recent review data, journal insights tagged `#idea`, SeriousLetter pipeline.",
  "",
  "**Output format:** Must Do / Should Do / Could Do (3-5 focus items max). Calendar constraints. Energy note from journal. Second-person, specific ('Add journal table to federation.db', NOT 'work on PAI').",
  "",
  "**Rules:** Never more than 7 focus items. Never plan without checking calendar first. Offer to save plan to journal.",
  "",
  "---",
  "",
  "## Share Skill",
  "",
  "USE WHEN user says 'share on linkedin', 'post about', 'write a tweet about', '/share', 'linkedin post', 'tweet this', 'publish to X', 'bluesky post', 'post to bluesky', OR wants to create social media content about their work.",
  "",
  "**Commands:**",
  "| Subcommand | Platform | Period |",
  "|------------|----------|--------|",
  "| `/share linkedin week` | LinkedIn | Current week |",
  "| `/share linkedin today` | LinkedIn | Today |",
  "| `/share linkedin \"topic\"` | LinkedIn | Topic-filtered |",
  "| `/share x` | X/Twitter | Today |",
  "| `/share x \"topic\"` | X/Twitter | Topic-filtered |",
  "| `/share bluesky` | Bluesky | Today |",
  "",
  "**LinkedIn rules:** 1000-2000 chars, first-person builder voice, concrete hook opener, 3-5 hashtags at end. NEVER: 'leverage', 'synergy', 'excited to share'. YES: specific versions, numbers, performance deltas.",
  "",
  "**X/Twitter rules:** Max 280 chars, 0-2 hashtags, lead with the interesting thing. Thread format: 3-5 tweets numbered '1/' '2/' etc. Offer to post via `mcp__x__send_tweet` — ALWAYS ask before posting.",
  "",
  "**Bluesky rules:** Max 300 chars, no hashtags needed, warmer than X but still technical. Copy-paste only.",
  "",
  "**Content rule:** Always gather real data first. If no interesting content found, say so rather than inflate.",
  "",
  "---",
  "",
  "## Sessions Skill",
  "",
  "USE WHEN user says 'list sessions', 'where was I working', 'show my sessions', 'find session', 'continue work from', 'switch to project', 'open project', 'name project', 'work on X', 'show me what we did on X', OR asks about past sessions, previous work, or project navigation.",
  "",
  "**Key commands:**",
  "| Command | Action |",
  "|---------|--------|",
  "| `pai session active` | Show currently open Claude Code sessions |",
  "| `pai session list` | Full session list |",
  "| `pai search \"keyword\"` | Find sessions by keyword |",
  "| `pai route <project>` | Route notes to a project |",
  "| `pai route` | Show current routing |",
  "| `pai route clear` | Stop routing |",
  "| `pai open <project> --claude` | Open project in new tab |",
  "| `pai name \"Name\"` | Name current project |",
  "",
  "**Intent routing:**",
  "- 'Work on X' / 'Start working on kioskpilot' → `pai route <project>`, then read that project's TODO.md",
  "- 'Show me sessions for PAI' / 'What did we do on X?' → `pai search <project>`",
  "- 'List sessions' → run `pai session active` FIRST (show active tabs prominently), then `pai session list`",
  "- 'Where are my notes going?' → `pai route` (no args)",
  "",
  "---",
  "",
  "## Route Skill",
  "",
  "USE WHEN user says 'route', 'what project is this', 'tag this session', 'where does this belong', 'categorize this session', OR starting work in an unfamiliar directory needing to connect to a PAI project.",
  "",
  "Detects current session context, searches PAI memory semantically and by keyword, and suggests which PAI project to route the session to.",
  "",
  "**Workflow:** Read CWD + project markers → search PAI memory → present top 3-5 matching projects with confidence → user picks → route and tag session.",
  "",
  "---",
  "",
  "## SearchHistory Skill",
  "",
  "USE WHEN user says 'search history', 'find past', 'what did we do', 'when did we', OR asks about previous sessions, past work, or historical context.",
  "",
  "**Search commands:**",
  "```bash",
  "# Keyword search across all history and project notes",
  "rg -i -l \"$QUERY\" ~/.claude/History/ ~/.claude/projects/*/Notes/",
  "",
  "# Recent files (last 7 days)",
  "find ~/.claude/projects/*/Notes -name \"*.md\" -mtime -7 | xargs ls -lt | head -10",
  "",
  "# Search prompts (what did I ask about X?)",
  "rg -i '\"prompt\":.*KEYWORD' ~/.claude/History/raw-outputs/",
  "```",
  "",
  "**Locations:**",
  "| Content | Location |",
  "|---------|----------|",
  "| Session notes | `~/.claude/projects/*/Notes/*.md` |",
  "| History sessions | `~/.claude/History/sessions/YYYY-MM/` |",
  "| Learnings | `~/.claude/History/Learnings/YYYY-MM/` |",
  "| Decisions | `~/.claude/History/Decisions/YYYY-MM/` |",
  "| All prompts | `~/.claude/History/raw-outputs/YYYY-MM/*_all-events.jsonl` |",
  "",
  "---",
  "",
  "## Name Skill",
  "",
  "USE WHEN user says '/name', 'name this session', 'rename session', OR wants to label what they're working on.",
  "",
  "Call `aibroker_rename` with the provided name. Updates: AIBroker session registry, iTerm2 tab title, statusline display.",
  "",
  "Usage: `/name <new name>` — immediately call `aibroker_rename`, no confirmation needed.",
  "",
  "---",
  "",
  "## Observability Skill",
  "",
  "USE WHEN user says 'start observability', 'stop dashboard', 'restart observability', 'monitor agents', 'show agent activity', or needs to debug multi-agent workflows.",
  "",
  "**Commands:**",
  "```bash",
  "~/.claude/Skills/observability/manage.sh start    # Start server + dashboard",
  "~/.claude/Skills/observability/manage.sh stop     # Stop everything",
  "~/.claude/Skills/observability/manage.sh restart  # Restart both",
  "~/.claude/Skills/observability/manage.sh status   # Check status",
  "```",
  "",
  "**Access:** Dashboard UI: http://localhost:5172 | Server API: http://localhost:4000",
  "",
  "**What it monitors:** Agent session starts/ends, tool calls across all agents, hook event execution, session timelines. Data source: `~/.claude/History/raw-outputs/YYYY-MM/YYYY-MM-DD_all-events.jsonl`.",
  "",
  "---",
  "",
  "## Research Skill",
  "",
  "USE WHEN user says 'do research', 'extract wisdom', 'analyze content', 'find information about', or requests web/content research.",
  "",
  "**Research modes:**",
  "- Quick: 1 agent per type, 2 min timeout",
  "- Standard (default): 3 agents per type, 3 min timeout",
  "- Extensive: 8 agents per type, 10 min timeout",
  "",
  "**Available agents:** `claude-researcher` (free, WebSearch), `perplexity-researcher` (PERPLEXITY_API_KEY), `gemini-researcher` (GOOGLE_API_KEY).",
  "",
  "**Workflow routing:**",
  "- Parallel research → read `${PAI_DIR}/Skills/research/workflows/conduct.md`",
  "- Claude research (free) → `workflows/claude-research.md`",
  "- Blocked content / CAPTCHA → escalate: WebFetch → BrightData → Apify",
  "- YouTube URL → `fabric -y <URL>` then pattern",
  "- Fabric patterns → 242+ patterns including: `extract_wisdom`, `summarize`, `create_threat_model`, `analyze_claims`, `improve_writing`",
  "",
  "**Fabric usage:** `fabric [input] -p [pattern]` or `fabric -u \"URL\" -p [pattern]` or `fabric -y \"YOUTUBE_URL\" -p [pattern]`",
  "",
  "---",
  "",
  "## Art Skill",
  "",
  "USE WHEN user wants to create visual content, illustrations, diagrams, art, header images, visualizations, mermaid charts, flowcharts, or any visual request.",
  "",
  "**Aesthetic:** Tron-meets-Excalidraw — dark slate backgrounds, neon orange + cyan accents, hand-drawn sketch lines, subtle glows. Full details: `${PAI_DIR}/Skills/CORE/aesthetic.md`.",
  "",
  "**Workflow routing by content type:**",
  "| Request | Workflow |",
  "|---------|----------|",
  "| Unsure which format | `workflows/visualize.md` (adaptive orchestrator) |",
  "| Blog header / editorial | `workflows/workflow.md` |",
  "| Flowchart / sequence / state | `workflows/mermaid.md` |",
  "| Architecture / system diagram | `workflows/technical-diagrams.md` |",
  "| Classification grid | `workflows/taxonomies.md` |",
  "| Timeline / chronological | `workflows/timelines.md` |",
  "| 2x2 matrix / framework | `workflows/frameworks.md` |",
  "| X vs Y comparison | `workflows/comparisons.md` |",
  "| Annotated screenshot | `workflows/annotated-screenshots.md` |",
  "| Quote card | `workflows/aphorisms.md` |",
  "| Stats / big number | `workflows/stats.md` |",
  "",
  "**Image generation:** `bun run ${PAI_DIR}/Skills/art/tools/generate-ulart-image.ts --model nano-banana-pro --prompt \"[PROMPT]\" --size 2K`",
  "",
  "---",
  "",
  "## Createskill Skill",
  "",
  "USE WHEN user wants to create, validate, update, or canonicalize a skill, OR mentions skill creation, new skill, build skill, skill compliance, or skill structure.",
  "",
  "**Before creating any skill, READ:** `${PAI_DIR}/Skills/CORE/SkillSystem.md`",
  "",
  "**Naming convention:** All skill directories and workflow files use TitleCase (PascalCase). NEVER: `createskill`, `create-skill`, `create.md`.",
  "",
  "**Workflow routing:**",
  "| Trigger | Workflow |",
  "|---------|----------|",
  "| 'create a new skill' | `workflows/CreateSkill.md` |",
  "| 'validate skill', 'check skill' | `workflows/ValidateSkill.md` |",
  "| 'update skill', 'add workflow' | `workflows/UpdateSkill.md` |",
  "| 'canonicalize', 'fix skill structure' | `workflows/CanonicalizeSkill.md` |",
  "",
  "---",
  "",
  "## StoryExplanation Skill",
  "",
  "USE WHEN user explicitly says '/story', 'create story explanation', 'run CSE', 'explain this as a story', 'story with links', 'deep story'. Do NOT activate on vague mentions of 'story'.",
  "",
  "**Commands:**",
  "| Command | Output |",
  "|---------|--------|",
  "| `/story [content]` | 8 numbered narrative points (default) |",
  "| `/story [N] [content]` | N numbered points (3-50) |",
  "| `/story deep [content]` | 20+ points deep dive |",
  "| `/story links [content]` | N points with inline links |",
  "",
  "**Input sources:** URL (WebFetch), YouTube URL (`fabric -y <URL>`), file path (Read), pasted text (direct).",
  "",
  "---",
  "",
  "## Vault Skills (Obsidian Integration)",
  "",
  "All vault skills work with vault at: `/Users/i052341/Daten/Cloud/Obsidian/ObsidianMN/`",
  "",
  "### VaultContext",
  "USE WHEN user says 'load vault context', 'brief me from Obsidian', 'morning briefing', '/vault-context', 'what am I working on', 'what\\'s in my vault'.",
  "",
  "Reads: daily note → open TODOs → PAI index (active projects) → HOME.md (focus areas) → recent insights. Synthesizes into morning briefing with Suggested First Action.",
  "",
  "### VaultConnect",
  "USE WHEN user says 'connect X and Y', 'how does X relate to Y', 'find path between', 'bridge topics', '/vault-connect', OR asks how two ideas are connected in the vault.",
  "",
  "Finds connections between two topics via the wikilink graph: direct links → 1-hop bridges → 2-hop paths. If no path found, offers to create a bridge note.",
  "",
  "### VaultEmerge",
  "USE WHEN user says 'what\\'s emerging', 'find patterns', 'emerging clusters', 'themes in vault', '/vault-emerge', 'new projects forming', 'what am I thinking about', 'recent themes'.",
  "",
  "Finds notes modified in last 90 days sharing keywords but not yet linked to each other. Surfaces top 8-10 emerging clusters with note counts and folder diversity. Offers to create MOC (Map of Content) index notes for top clusters.",
  "",
  "### VaultOrphans",
  "USE WHEN user says 'find orphans', 'orphaned notes', 'unlinked notes', 'vault orphans', '/vault-orphans', 'clean up vault graph', 'disconnected notes'.",
  "",
  "Finds notes with zero inbound wikilinks. Groups by top-level folder. Excludes expected orphan folders (PAI/, Daily Notes/). For each orphan, suggests connections to existing notes and drafts specific wikilink text.",
  "",
  "### VaultTrace",
  "USE WHEN user says 'trace idea', 'how did X evolve', 'history of X in notes', 'when did I first write about', '/vault-trace', 'timeline of X', 'track idea evolution', 'idea history'.",
  "",
  "Builds a chronological timeline of how an idea first appeared and evolved across vault notes. Extracts relevant excerpts. Identifies inflection points where framing shifted. Summarizes the evolution arc (first appearance → development → current state).",
  "",
  "---",
  "",
  "## Notification Conventions",
  "",
  "**When executing any skill workflow, announce it:**",
  "1. Output text: `Running the **WorkflowName** workflow from the **SkillName** skill...`",
  "2. Call notification: `~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME SKILLNAME`",
  "",
  "**WhatsApp routing:** Messages prefixed `[Whazaa]` → reply via `whatsapp_send` (same content as terminal). Messages prefixed `[Whazaa:voice]` → reply via `whatsapp_tts`. No prefix → terminal only.",
  "Strip the prefix before processing. Acknowledge long tasks immediately before starting work.",
].join("\n");

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
  // Connect transport and start serving
  // -------------------------------------------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

startShim().catch((e) => {
  process.stderr.write(`PAI MCP shim fatal error: ${String(e)}\n`);
  process.exit(1);
});
