# PAI Knowledge OS

Claude Code has a memory problem. Every new session starts cold — no idea what you built yesterday, what decisions you made, or where you left off. You re-explain everything, every time. PAI fixes this.

Install PAI and Claude remembers. Ask it what you were working on. Ask it to find that conversation about the database schema. Ask it to pick up exactly where the last session ended. It knows.

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

---

## Quick Start

Tell Claude Code:

> Clone https://github.com/mnott/PAI and set it up for me

Claude finds the setup skill, checks your system, runs the interactive wizard, and configures itself. You answer a few questions — simple mode or full mode, where your projects live, whether you use Obsidian — and Claude does the rest.

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
| **Session Start** | Loads project context, detects which project you're in, creates a session note |
| **User Prompt** | Cleans up temp files, updates terminal tab titles |
| **Pre-Compact** | Saves session state checkpoint, sends notification |
| **Post-Compact** | Injects preserved state back into Claude's context |
| **Tool Use** | Captures tool outputs for observability |
| **Session End** | Summarizes work done, finalizes session note |
| **Stop** | Writes work items to session note, sends notification |

All hooks are TypeScript compiled to `.mjs` modules. They run as separate processes, communicate via stdin (JSON input from Claude Code) and stdout (context injection back into the conversation).

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

Once set, PAI's statusline shows `[auto-compact:80%]` next to the context meter on line 3, so you always know auto-compact is active and at what threshold.

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

## Companion Projects

PAI works great alongside these tools (also by the same author):

- **[Whazaa](https://github.com/mnott/Whazaa)** — WhatsApp bridge for Claude Code (voice notes, screenshots, session routing)
- **[Coogle](https://github.com/mnott/Coogle)** — Google Workspace MCP daemon (Gmail, Calendar, Drive multiplexing)
- **[DEVONthink MCP](https://github.com/mnott/devonthink-mcp)** — DEVONthink integration for document search and archival

---

## Acknowledgments

PAI Knowledge OS is inspired by [Daniel Miessler](https://github.com/danielmiessler)'s concept of Personal AI Infrastructure and his [Fabric](https://github.com/danielmiessler/fabric) project — a Python CLI for augmenting human capabilities with reusable AI prompt patterns. Fabric is excellent and solves a different problem; PAI takes the same philosophy in a different direction: persistent memory, session continuity, and deep Claude Code integration. See [FEATURE.md](FEATURE.md) for a detailed comparison.

---

## License

MIT

