# PAI Knowledge OS — v0.9.7

Claude Code has a memory problem. Every new session starts cold — no idea what you built yesterday, what decisions you made, or where you left off. PAI fixes this.

Install PAI and Claude remembers. Ask it what you were working on. Ask it to find that conversation about the database schema. Ask it to pick up exactly where the last session ended. It knows.

## Quick Start

Tell Claude Code:

> Clone https://github.com/mnott/PAI and set it up for me

Or manually:

### 1. Install

```bash
git clone https://github.com/mnott/PAI
cd PAI
bun install
bun run build
```

### 2. Run the setup wizard

```bash
pai setup
```

The wizard walks you through: storage mode (SQLite or PostgreSQL), project directories, Obsidian vault path, MCP server registration, CLAUDE.md template, and daemon configuration. It's idempotent — safe to re-run anytime.

### 3. Start the daemon

```bash
pai daemon start
```

The daemon runs in the background via launchd, indexing your sessions and serving the MCP tools. It starts automatically on login.

### 4. Verify

```bash
pai daemon status    # should show "running"
pai memory search "test"   # should return results after indexing
```

That's it. Claude Code now has persistent memory across all sessions.

---

## Automatic Session Notes — by Topic

PAI's headline feature: **every session is automatically documented.** No manual note-taking, no "pause session" commands, no forgetting to save what you did.

When you work, a background daemon watches your session **continuously**. Every time Claude's context compacts — which happens automatically as the conversation grows — the daemon reads the JSONL transcript, combines it with your git history, and spawns a headless Claude process to write a structured session note. Not just at session end. Midway through your work, while you're still coding. The notes build up in real time as you go — what was built, what decisions were made, what problems were hit, what's left to do.

**When you change topics mid-session, PAI creates a new note.** If you start the day debugging audio, then pivot to a Flutter rewrite, you get two notes — not one giant file mixing unrelated work:

```
Notes/2026/03/
  0001 - 2026-03-23 - Phase 1 Research and Architecture.md
  0002 - 2026-03-24 - Background Audio and iOS Conflicts.md
  0003 - 2026-03-24 - Flutter Rewrite with Whisper.md     ← auto-split, same day
```

Topic detection uses Jaccard word similarity between the new summary's topic and the existing note's title. Below 30% overlap = new note.

**Model tiering:** Opus for final session summaries (best quality, runs once). Sonnet for mid-session checkpoints (good quality, runs on compaction). All using your Max plan — no API charges.

This is not a template or a skeleton. These are real notes with build error chronologies, architectural decisions with rationale, code snippets, and "what was tried and failed" sections. The kind of notes you'd write yourself if you had time.

---

## What You Can Ask Claude

### Searching Your Memory

- "Search your memory for authentication" — finds past sessions about auth, even with different words
- "What do you know about the Whazaa project?" — retrieves full project context instantly
- "Find where we discussed the database migration" — semantic search finds it even if you phrase it differently
- "Search your memory for that Chrome browser issue" — keyword and meaning-based search combined

### Managing Projects

- "Show me all my projects" — lists everything PAI tracks with stats
- "Which project am I in?" — auto-detects from your current directory
- "What's the status of the PAI project?" — full project details, sessions, last activity
- "How many sessions does Whazaa have?" — project-level session history

### Navigating Sessions

- "List my recent sessions" — shows what you've been working on across all projects
- "What did we do in session 42?" — retrieves any specific session by number
- "What were we working on last week?" — Claude knows, without you re-explaining
- "Clean up my session notes" — auto-names unnamed sessions and organizes by date

### Reviewing Your Work

- "Review my week" — synthesizes session notes, git commits, and completed tasks into a themed narrative
- "What did I do today?" — daily review across all projects
- "Journal this thought" — capture freeform reflections with timestamps
- "Plan my week" — forward-looking priorities based on open TODOs and recent activity
- "What themes are emerging in my work?" — spot patterns across sessions and projects

### Sharing Your Work

- "Share on LinkedIn today" — generates a professional post about what you shipped, with real numbers and technical substance
- "Tweet about the vault migration" — punchy X/Twitter post or thread, with option to post directly
- "Share on Bluesky this week" — conversational technical post for the Bluesky audience
- Platform-aware formatting: LinkedIn gets hashtags and narrative, X gets threads and hooks, Bluesky gets conversational tone

### Tracking Your Activity

- "What changes did I make to the daemon today?" — automatic observation capture tracks every tool call
- "Show me all decisions from the last session" — observations are classified: decision, bugfix, feature, refactor, discovery, change
- "What files did I modify in the PAI project this week?" — searchable timeline of every edit, commit, and search
- "Show observation stats" — totals, breakdowns by type and project, with visual bar charts

### Continuing Where You Left Off

- "Go" — reads your TODO.md continuation prompt and picks up exactly where the last session stopped
- "What was I working on?" — progressive context injection loads recent observations at session start
- "Continue the daemon refactor" — session summaries give Claude full context without re-explaining
- "/reconstruct" — retroactively creates session notes from JSONL transcripts and git history when automatic capture missed a session

### Keeping Things Safe

- "Back up everything" — creates a timestamped backup of all your data
- "How's the system doing?" — checks daemon health, index stats, embedding coverage

### Obsidian Integration

- "Sync my Obsidian vault" — updates your linked vault with the latest notes
- "Open my notes in Obsidian" — launches Obsidian with your full knowledge graph

### Zettelkasten Intelligence

- "Explore notes linked to PAI" — follow trains of thought through wikilink chains
- "Find surprising connections to this note" — discover semantically similar but graph-distant notes
- "What themes are emerging in my vault?" — detect clusters of related notes forming new ideas
- "How healthy is my vault?" — structural audit: dead links, orphans, disconnected clusters
- "Suggest connections for this note" — proactive link suggestions using semantic + graph signals
- "What does my vault say about knowledge management?" — use the vault as a thinking partner

### Budget Management

- "How much budget do I have left?" — shows current weekly usage and advisor mode
- "Go easy on the budget" — switches to conservative mode (prefer haiku subagents)
- "Lock it down" — switches to critical mode (minimize all token usage)
- "Go full power" — switches to normal mode (no constraints)
- "Back to auto" — resets to auto mode (derives from weekly budget percentage)

---

## Skills

PAI ships 22 skills — slash commands that activate specialized workflows. Each responds to natural language triggers as well as the `/command` syntax.

### Productivity

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/advisor` | "budget mode", "save budget", "go easy on the budget" | Manage budget-aware model tiering for subagents |
| `/plan` | "plan my week", "what should I focus on", "priorities" | Plan tomorrow/week/month based on open tasks and calendar |
| `/review` | "review my week", "what did I do", "recap" | Daily/weekly/monthly review of work accomplished |
| `/journal` | "journal", "note to self", "capture this thought" | Create, read, or search personal journal entries |
| `/share` | "share on LinkedIn", "tweet about", "post to Bluesky" | Generate social media posts about completed work |

### Session Management

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/sessions` | "list sessions", "where was I working" | Navigate sessions, projects, switch working context |
| `/route` | "what project is this", "tag this session" | Detect which PAI project the current session belongs to |
| `/name` | "name this session", "rename session" | Name or rename the current session |
| `/search-history` | "search history", "find past", "what did we do" | Search past sessions and previous work by keyword |
| `/consolidate` | "consolidate notes", "clean up notes", "merge duplicates" | Merge duplicate session notes, fix titles, renumber |
| `/reconstruct` | "reconstruct sessions", "backfill session notes" | Retroactively create notes from JSONL transcripts and git history |

### Obsidian Vault

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/vault-context` | "morning briefing", "load vault context" | Load Obsidian vault context for a briefing |
| `/vault-connect` | "connect X and Y", "how does X relate to Y" | Find connections between two topics in the vault |
| `/vault-emerge` | "what's emerging", "find patterns", "themes in vault" | Surface emerging themes and clusters |
| `/vault-orphans` | "find orphans", "unlinked notes" | Find and reconnect orphaned notes with zero inbound links |
| `/vault-trace` | "trace idea", "how did X evolve", "idea history" | Trace the evolution of an idea across vault notes over time |

### Tools & System

| Skill | Trigger | What it does |
|-------|---------|-------------|
| `/whisper` | "add whisper rule", "show whisper rules" | Manage persistent behavioral constraints injected on every prompt |
| `/research` | "do research", "extract wisdom", "analyze content" | Web research, content extraction, and analysis via parallel agents |
| `/art` | "create diagram", "flowchart", "visualize" | Create visual content, diagrams, flowcharts, and AI-generated images |
| `/story` | "explain this as a story", "create story explanation" | Create numbered narrative story explanations of any content |
| `/observability` | "start observability", "monitor agents" | Start, stop, or check the multi-agent observability dashboard |
| `/createskill` | "create skill", "validate skill" | Create, validate, update, or canonicalize a PAI skill |

---

## Budget-Aware Advisor Mode

PAI tracks your weekly Claude usage and automatically adjusts subagent model selection to stay within budget. The statusline shows your current mode at a glance.

### How it works

The statusline reads your OAuth usage from the Anthropic API (5-hour and 7-day windows) and writes the weekly budget percentage to `~/.claude/advisor-mode.json`. A whisper-rules hook reads this file on every prompt and injects model-tiering guidance.

### Automatic thresholds

| Budget Used | Mode | Subagent Model | Behavior |
|-------------|------|----------------|----------|
| < 60% | normal | Any | No constraints |
| 60–80% | conservative | Haiku preferred | Escalate to sonnet only if haiku insufficient |
| 80–92% | strict | Haiku only | Minimize spawning, no opus subagents |
| > 92% | critical | Haiku or none | Essential work only, minimize all token usage |

### Statusline display

The advisor mode label appears on the context line:

```
💎 Context: 12K / 1000K (68%) │ 5h: 3% → 13:18 │ 1d: 5% / 8% │ 7d: strict 91% → Fr. 08:00
```

Manually forced modes show a 📌 prefix (e.g. `📌normal 91%`) so you always know whether the mode was auto-calculated or manually set.

### Switching modes

Use `/budget` commands, `/Advisor` skill, or plain language:

```
/budget auto                  — reset to auto (budget-driven)
/budget mode normal           — force normal mode
/budget force haiku           — force all subagents to haiku

/Advisor auto                 — same, via skill (note: capital A)
/Advisor mode strict          — force strict mode

"go full power"               — normal mode (plain language)
"be conservative"             — conservative mode
"lock it down"                — critical mode
"back to auto"                — auto mode
```

Changes take effect on the next prompt — no restart needed.

> **Note:** `/advisor` (lowercase) conflicts with a Claude Code built-in command. Use `/budget` or `/Advisor` (capital A) instead.

---

## Context Preservation

When Claude's context window fills up, it compresses the conversation. Without PAI, everything from before that point is lost — Claude forgets what it was working on, what files it changed, and what you asked for.

PAI intercepts this compression with a two-stage relay:

1. **Before compression** — PAI extracts session state from the conversation transcript: your recent requests, work summaries, files modified, and current task context. This gets saved to a checkpoint.

2. **After compression** — PAI reads that checkpoint and injects it back into Claude's fresh context. Claude picks up exactly where it left off.

This happens automatically. You don't need to do anything — just keep working, and PAI handles the continuity.

### What Gets Preserved

- Your last 3 requests (so Claude knows what you were asking)
- Work summaries and captured context
- Files modified during the session
- Current working directory and task state
- Session note checkpoints (persistent — survive even full restarts)

### Session Lifecycle Hooks

PAI runs hooks at every stage of a Claude Code session:

| Event | What PAI Does |
|-------|--------------|
| **Session Start** | Loads project context, detects which project you're in, auto-registers new projects, creates a session note, injects recent observations |
| **User Prompt** | Cleans up temp files, updates terminal tab titles, injects whisper rules and advisor mode guidance on every prompt |
| **Pre-Compact** | Saves session state checkpoint, pushes `session-summary` work item to daemon, sends notification |
| **Post-Compact** | Injects preserved state back into Claude's context |
| **Tool Use** | Classifies tool calls into structured observations (decision/bugfix/feature/refactor/discovery/change) |
| **Session End** | Pushes `session-summary` work item to daemon for AI-powered note generation |
| **Stop** | Pushes `session-summary` work item to daemon, sends notification |

All hooks are TypeScript compiled to `.mjs` modules. They run as separate processes and communicate via stdin (JSON input from Claude Code) and stdout (context injection back into the conversation). Hooks are thin relays — they capture minimal data and immediately push work items to the daemon queue, which handles all heavy processing asynchronously.

---

## Automatic Session Notes

PAI automatically writes structured session notes after every session ends — no manual journaling required. The daemon spawns a headless Claude CLI process (using your Max plan, not the API) to summarize the JSONL conversation transcript combined with recent git history.

### What Gets Generated

Each session note contains:

- **Work Done** — concrete description of what was accomplished
- **Key Decisions** — choices made and their rationale
- **Known Issues** — bugs found, blockers, or open questions
- **Next Steps** — where to pick up in the next session

The summarizer uses tiered model selection based on the trigger:

| Trigger | Model | Timeout | JSONL Limit |
|---------|-------|---------|-------------|
| Session end (Stop hook) | Opus | 5 minutes | 500K bytes |
| Auto-compaction (PreCompact hook) | Sonnet | 2 minutes | 200K bytes |

### Topic-Based Note Splitting

When a session covers multiple distinct topics, PAI creates separate notes rather than one long note for the whole session. The summarizer outputs a `TOPIC:` line describing the subject of the current work. PAI compares this against the existing note title using Jaccard word similarity — when similarity falls below 30%, a new note is created automatically.

Notes within the same day are numbered sequentially: `0042 - 2026-03-24 - Session Name.md`, `0043 - 2026-03-24 - Different Topic.md`, and so on.

### One Note Per Session

Each compaction within a session updates the existing note rather than creating a new one. The 30-minute cooldown between summaries prevents redundant updates. Stop hook triggers bypass the cooldown with a force flag to ensure the final state is always captured.

### Garbage Title Filter

Session note titles are validated before creation. Over 20 patterns are rejected, including: task notification strings, `[object Object]`, hex hashes, bare numbers, and other non-descriptive artifacts that can appear in session transcripts. Titles must describe actual work done and are capped at 60 characters.

### Finding the Claude Binary

The daemon runs under launchd with a minimal PATH that does not include `~/.local/bin/`. PAI resolves the Claude CLI binary by checking `~/.local/bin/claude` first, then falling back to PATH lookup, before spawning headless summarization processes.

### Stripping the API Key

When spawning headless Claude CLI processes for summarization, the daemon strips `ANTHROPIC_API_KEY` from the subprocess environment. This forces the spawned process to authenticate via your Max plan (free) rather than using the API key (billable). Without this, every automatic session note would incur API charges.

---

## Progressive Memory Loading

PAI loads context in layers at session start rather than all at once. This keeps early-session latency low while giving Claude everything it needs to be useful immediately.

### The Four Layers

| Layer | What it loads | When |
|-------|---------------|------|
| **L0 — Identity** | Your identity file (`~/.pai/identity.txt`) — who you are, your working style, key preferences | Always, at every session start |
| **L1 — Essential story** | Summaries from the most recent session notes — what you were doing, what decisions were made, where things stand | Always, at session start |
| **L2 — Topic queries** | On-demand retrieval for the current topic — fetched when a specific question or task is identified | On demand, during the session |
| **L3 — Deep search** | Full `memory_search` across all indexed content — for when L2 is not enough | On demand, when explicitly needed |

L0 and L1 fire automatically via the `memory_wakeup` MCP tool, which is called by the `SessionStart` hook. L2 and L3 are invoked as needed — the model decides when to go deeper based on the question at hand.

### Configuring Your Identity File

Create `~/.pai/identity.txt` with a short description of yourself and your working style. Claude will see this at every session start. Example:

```
Matthias. Principal engineer. Work across TypeScript, Dart, and shell scripting.
Projects: PAI (AI infrastructure), RingsADay (Flutter app), Scribe (MCP server).
Prefer concise explanations, hate unnecessary hedging.
```

---

## Advanced Memory Tools

### Temporal Knowledge Graph

Facts change over time. The `kg_triples` table stores knowledge as subject-predicate-object triples with `valid_from` and `valid_to` timestamps, so facts can expire and contradict each other rather than accumulating in an undated blob.

Four MCP tools cover the full lifecycle:

- `kg_add` — Add a fact with a start date (and optional end date)
- `kg_query` — Query the graph, filtered to facts valid at a given point in time
- `kg_invalidate` — Mark a fact as no longer true (sets `valid_to`)
- `kg_contradictions` — Surface facts that directly contradict each other, using predicate inversion rules

Example: "Matthias uses PostgreSQL" added in March; "Matthias uses SQLite" added in April with the March fact invalidated. `kg_query` in April sees only the current fact; `kg_query` for March sees the historical one.

### Memory Taxonomy

`memory_taxonomy` gives a shape-of-memory overview: projects, session counts, chunk counts, embedding coverage, and recent activity. Think of it as a dashboard for your knowledge base — useful both for the model (to understand what it knows) and for you (to audit what is indexed).

### Cross-Project Tunnels

`memory_tunnels` detects concepts that appear across multiple projects. It works by comparing FTS vocabulary in SQLite mode or `ts_stat` output in PostgreSQL mode. When a concept — a library name, a design pattern, a person's name — shows up in three separate projects, PAI surfaces that connection as a tunnel.

This reveals unexpected intellectual bridges: the same concurrency pattern used in PAI's daemon showing up in your Flutter app's state management, or a vendor name appearing in both your notes and your job applications.

---

## Automatic Observation Capture

PAI automatically classifies and stores every significant tool call during your sessions. When you edit a file, run a command, or make a decision, PAI captures it as a structured observation — building a searchable timeline of everything you've done across all projects.

### How it works

A PostToolUse hook fires after every Claude Code tool call. A rule-based classifier (no AI needed, under 50ms) categorizes each action:

| Type | What triggers it | Examples |
|------|-----------------|----------|
| **decision** | Git commits, config changes | `git commit`, writing to config files |
| **bugfix** | Test runs, error investigation | `npm test`, debugging commands |
| **feature** | New file creation, feature work | Creating components, adding endpoints |
| **refactor** | Code restructuring | Renaming, moving files, reorganizing |
| **discovery** | File reads, searches | Reading code, grep searches, glob patterns |
| **change** | File edits | Editing source files, updating configs |

Observations are stored with content-hash deduplication (30-second window) to prevent duplicates from rapid tool calls.

### Progressive context injection

At session start, PAI injects recent observations as layered context:

1. **Compact index** (~100 tokens) — observation type counts and active projects
2. **Timeline** (~500 tokens) — recent observations with timestamps
3. **On-demand** — full details available via MCP tools

This means Claude starts every session already knowing what you were working on, without you re-explaining anything.

### Searching observations

Ask Claude naturally:

```
"What changes did I make to the daemon today?"
"Show me all decisions from the last session"
"What files did I modify in the PAI project this week?"
```

Or use the CLI:

```bash
# List recent observations
pai observation list

# Filter by type
pai observation list --type decision

# Filter by project
pai observation list --project pai

# Show stats
pai observation stats
```

### Session summaries

When a session ends, PAI generates a structured summary capturing what was requested, investigated, learned, completed, and what the next steps are. These summaries feed into the progressive context system, giving future sessions a concise picture of past work.

---

## Whisper Rules

PAI provides a hook that injects user-defined rules into every prompt via `UserPromptSubmit`. Rules survive compaction, `/clear`, and session restarts — they fire on every single turn, making them the most reliable way to enforce behavioral constraints.

**PAI ships the mechanism. You provide the rules.** The file `~/.claude/whisper-rules.md` does not exist by default. Use the `/whisper` skill to manage your rules:

```
/whisper                          — show current rules
/whisper add "NEVER send emails"  — add a rule
/whisper remove 3                 — remove rule #3
/whisper list                     — list with line numbers
```

Or edit `~/.claude/whisper-rules.md` directly — one rule per line, plain text.

**Keep rules focused.** Every rule is injected on every prompt. Too many rules dilute effectiveness and waste tokens. Reserve whisper rules for truly critical constraints that keep getting violated despite being in CLAUDE.md.

The pattern is inspired by [Letta's claude-subconscious](https://github.com/letta-ai/claude-subconscious) approach to persistent context injection.

---

## Auto-Compact Context Window

Claude Code can automatically compact your context window when it fills up, preventing session interruptions mid-task. PAI's statusline shows you at a glance whether auto-compact is active.

### Why the GUI setting doesn't work

Claude Code has an `autoCompactEnabled` setting in `~/.claude.json`, but it gets overwritten on every restart. Do not use it — changes don't survive.

### The durable approach: environment variable

Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in your `~/.claude/settings.json` under the `env` block. This survives restarts, `/clear`, and Claude Code updates.

```json
{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80"
  }
}
```

The value is the context percentage at which compaction triggers. `80` means compact when the context window reaches 80% full. Restart Claude Code after saving.

### Statusline indicator

PAI's statusline shows the remaining context until auto-compact triggers as a percentage on line 3, along with your 5-hour and 7-day usage limits, daily pace indicator, and advisor mode label.

### Set it up with one prompt

Give Claude Code this prompt and it handles everything:

> Add `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set to `80` to the `env` block in `~/.claude/settings.json`. This enables durable auto-compact that survives restarts. Do not touch `~/.claude.json` — that file gets overwritten on startup. After saving, confirm the setting is in place and tell me to restart Claude Code.

---

## Storage Options

PAI offers two modes, and the setup wizard asks which you prefer.

**Simple mode (SQLite)** — Zero dependencies beyond Bun. Keyword search only. Great for trying it out or for systems without Docker.

**Full mode (PostgreSQL + pgvector)** — Adds semantic search and vector embeddings. Finds things by meaning, not just exact words. "How does the reconnection logic work?" finds the right session even if it never used those exact words. Requires Docker.

---

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- [Docker](https://docs.docker.com/get-docker/) — only for full mode
- [Claude Code](https://claude.ai/code)
- macOS or Linux

---

## How It Works

A background service runs quietly alongside your work. Every five minutes it indexes your Claude Code projects and session notes — chunking them, hashing them for change detection, and storing them in a local database. When you ask Claude something about past work, it searches this index by keyword, by meaning, or both, and surfaces the relevant context in seconds.

Everything runs locally. No cloud. No API keys for the core system.

For the technical deep-dive — architecture, database schema, CLI reference, and development setup — see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Search Intelligence

PAI doesn't just store your notes — it understands them. Three search modes work together, with reranking and recency boost on by default. All search settings are configurable.

### Search Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Keyword** | Full-text search (BM25 via SQLite FTS5) | Exact terms, function names, error messages |
| **Semantic** | Vector similarity (Snowflake Arctic embeddings) | Finding things by meaning, even with different words |
| **Hybrid** | Keyword + semantic combined, scores normalized and blended | General use — the default |

### Cross-Encoder Reranking

Every search automatically runs a second pass: a cross-encoder model reads each (query, result) pair together and re-scores them for relevance. This catches results that keyword or vector search ranked too low.

```bash
# Search with reranking (default)
pai memory search "how does session routing work"

# Skip reranking for faster results
pai memory search "how does session routing work" --no-rerank
```

The reranker uses a small local model (~23 MB) that runs entirely on your machine. First use downloads it automatically. No API keys, no cloud calls.

### Recency Boost

Recent content scores higher than older content — on by default with a 90-day half-life. A 3-month-old result retains 50% of its score, a 6-month-old retains 25%, and a year-old retains ~6%.

```bash
# Search uses recency boost automatically (90-day half-life from config)
pai memory search "notification system"

# Override the half-life for this search
pai memory search "notification system" --recency 30

# Disable recency boost for this search
pai memory search "notification system" --recency 0
```

Via MCP, pass `recency_boost: 90` to the `memory_search` tool, or `recency_boost: 0` to disable.

Recency boost is applied after cross-encoder reranking, so relevance is scored first, then time-weighted. Scores are normalized before decay so the math works correctly regardless of the underlying score scale.

### Search Settings

All search defaults are configurable via `~/.config/pai/config.json` and can be viewed or changed from the command line.

```bash
# View all search settings
pai memory settings

# View a single setting
pai memory settings recencyBoostDays

# Change a setting
pai memory settings recencyBoostDays 60
pai memory settings mode hybrid
pai memory settings rerank false
```

| Setting | Default | Description |
|---------|---------|-------------|
| `mode` | `keyword` | Default search mode: `keyword`, `semantic`, or `hybrid` |
| `rerank` | `true` | Cross-encoder reranking on by default |
| `recencyBoostDays` | `90` | Recency half-life in days. `0` = off |
| `defaultLimit` | `10` | Default number of results |
| `snippetLength` | `200` | Max characters per snippet in MCP results |

Settings live in the `search` section of `~/.config/pai/config.json`. Per-call parameters (CLI flags or MCP tool arguments) always override config defaults.

### Using Search from Within Claude

When PAI is configured as an MCP server, Claude uses the `memory_search` tool automatically. You don't need to call it yourself — just ask Claude naturally and it searches your memory behind the scenes.

**Example prompts you can give Claude:**

```
"Search your memory for authentication"
"What do you know about the database migration?"
"Find where we discussed the notification system"
```

Claude calls `memory_search` with the right parameters based on your config defaults. Reranking and recency boost are both active by default — you don't need to configure anything for good results.

**Overriding defaults for a specific search:**

You can ask Claude to adjust search behavior per-query:

```
"Search for authentication using semantic mode"
  → Claude passes mode: "semantic"

"Search for the old logging discussion without recency boost"
  → Claude passes recency_boost: 0

"Search for database schema across all projects with no reranking"
  → Claude passes all_projects: true, rerank: false
```

**The `memory_search` MCP tool accepts these parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Free-text search query (required) |
| `project` | string | Scope to one project by slug |
| `all_projects` | boolean | Explicitly search all projects |
| `sources` | array | Restrict to `"memory"` or `"notes"` |
| `limit` | integer | Max results (1–100, default from config) |
| `mode` | string | `"keyword"`, `"semantic"`, or `"hybrid"` |
| `rerank` | boolean | Cross-encoder reranking (default: true from config) |
| `recency_boost` | integer | Recency half-life in days (0 = off, default from config) |

All parameters except `query` are optional. Omitted values fall back to your `~/.config/pai/config.json` defaults.

**Changing defaults permanently:**

Tell Claude to change your search settings:

```
"Set my default search mode to hybrid"
"Turn off reranking by default"
"Change the recency boost to 60 days"
```

Claude runs `pai memory settings <key> <value>` to update `~/.config/pai/config.json`. Changes take effect on the next search — no restart needed.

---

## Zettelkasten Intelligence

PAI implements Niklas Luhmann's Zettelkasten principles as six computational operations on your Obsidian vault.

### How it works

PAI indexes your entire vault — following symlinks, deduplicating by inode, parsing every link — and builds a graph database alongside semantic embeddings. Six tools then operate on this dual representation:

| Tool | What it does |
|------|-------------|
| `pai zettel explore` | Follow trains of thought through link chains (Folgezettel traversal) |
| `pai zettel surprise` | Find notes that are semantically close but far apart in the link graph |
| `pai zettel converse` | Ask questions and let the vault "talk back" with unexpected connections |
| `pai zettel themes` | Detect emerging clusters of related notes across folders |
| `pai zettel health` | Structural audit — dead links, orphans, disconnected clusters, health score |
| `pai zettel suggest` | Proactive connection suggestions combining semantic similarity, tags, and graph proximity |

All tools work as CLI commands (`pai zettel <command>`) and MCP tools (`zettel_*`) accessible through the daemon.

### Vault Indexing

The vault indexer follows symlinks (critical for vaults built on symlinks), deduplicates files by inode to handle multiple paths to the same file, and builds a complete link graph with Obsidian-compatible shortest-match resolution.

All link types are parsed and resolved:

| Syntax | Type | Example |
|--------|------|---------|
| `[[Note]]` | Wikilink | `[[Daily Note]]`, `[[Note\|alias]]`, `[[Note#heading]]` |
| `![[file]]` | Embed | `![[diagram.png]]`, `![[template]]` |
| `[text](path.md)` | Markdown link | `[see here](notes/idea.md)`, `[ref](note.md#section)` |
| `![alt](file)` | Markdown embed | `![photo](assets/img.jpg)` |

External URLs (`https://`, `mailto:`, etc.) are excluded — only relative paths are treated as vault connections. URL-encoded paths (e.g. `my%20note.md`) are decoded automatically.

- Full index: ~10 seconds for ~1,000 files
- Incremental: ~2 seconds (hash-based change detection)
- Runs automatically via the daemon scheduler

---

## Release History

18 releases shipped from v0.7.2 to v0.9.7 (March 19 – April 10, 2026):

| Version | Feature |
|---------|---------|
| v0.7.2 | Auto-registration, one-note-per-session, Reconstruct skill |
| v0.7.3 | Automatic AI-powered session notes via daemon |
| v0.7.4 | Auto-register on parent match |
| v0.7.5 | Tiered model selection (opus/sonnet/haiku) |
| v0.7.6 | Find claude binary in launchd |
| v0.7.7 | Whisper rules hook |
| v0.7.8 | Strip API key from daemon (prevent billing) |
| v0.8.0 | Topic-based note splitting |
| v0.8.1 | /whisper skill, remove hardcoded defaults |
| v0.8.2 | Reduce topic split sensitivity |
| v0.8.3 | /consolidate skill |
| v0.8.4 | Store TOPIC in HTML comment |
| v0.8.5 | God-note detection, confidence tagging, Louvain communities, query feedback |
| v0.9.0 | 4-layer wake-up, temporal KG, taxonomy, tunnels, mid-session auto-save |
| v0.9.1 | KG backfill CLI, shared kg-extraction module |
| v0.9.2 | Stop-hook first-run safeguard |
| v0.9.3 | Silence stop-hook diagnostics |
| v0.9.4 | Remove exit(2) noise |
| v0.9.5 | Budget-aware advisor mode |
| v0.9.6 | Statusline auto-writes budget to advisor |
| v0.9.7 | Advisor mode label in statusline, natural language mode switching |

---

## Companion Projects

PAI works great alongside these tools (also by the same author):

- **[AIBroker](https://github.com/mnott/AIBroker)** — Unified message bridge for Claude Code (WhatsApp, Telegram, PAILot — text and voice routing)
- **[Whazaa](https://github.com/mnott/Whazaa)** — WhatsApp bridge for Claude Code (voice notes, screenshots, session routing)
- **[Telex](https://github.com/mnott/Telex)** — Telegram bridge for Claude Code (text and voice messaging)
- **[Coogle](https://github.com/mnott/Coogle)** — Google Workspace MCP daemon (Gmail, Calendar, Drive multiplexing)
- **[DEVONthink MCP](https://github.com/mnott/devonthink-mcp)** — DEVONthink integration for document search and archival

---

## Acknowledgments

PAI Knowledge OS is inspired by [Daniel Miessler](https://github.com/danielmiessler)'s concept of Personal AI Infrastructure and his [Fabric](https://github.com/danielmiessler/fabric) project — a Python CLI for augmenting human capabilities with reusable AI prompt patterns. Fabric is excellent and solves a different problem; PAI takes the same philosophy in a different direction: persistent memory, session continuity, and deep Claude Code integration. See [FEATURE.md](FEATURE.md) for a detailed comparison.

The automatic observation capture system — classifying tool calls into structured observations with progressive context injection — is inspired by [claude-mem](https://github.com/thedotmack/claude-mem) by [thedotmack](https://github.com/thedotmack). claude-mem demonstrated that automatic memory capture during Claude Code sessions dramatically improves continuity. PAI adapts this concept with a rule-based classifier, PostgreSQL storage, and three-layer progressive disclosure.

---

## License

MIT
