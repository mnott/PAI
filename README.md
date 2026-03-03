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

PAI doesn't just store your notes — it understands them. Three search modes work together, and an optional reranking step puts the best results first.

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

Optionally weight recent content higher than older content. Useful when you want what you worked on last week to rank above something from six months ago, even if both match equally well.

The boost uses exponential decay with a configurable half-life. A half-life of 90 days means a 3-month-old result retains 50% of its score, a 6-month-old retains 25%, and a year-old retains ~6%.

```bash
# Boost recent results (score halves every 90 days)
pai memory search "notification system" --recency 90

# Combine with any mode — works with keyword, semantic, hybrid, and reranking
pai memory search "notification system" --mode hybrid --recency 90
```

Via MCP, pass `recency_boost: 90` to the `memory_search` tool. Set to 0 (default) to disable.

Recency boost is applied after cross-encoder reranking, so relevance is scored first, then time-weighted. Scores are normalized before decay so the math works correctly regardless of the underlying score scale.

---

## Zettelkasten Intelligence

PAI implements Niklas Luhmann's Zettelkasten principles as six computational operations on your Obsidian vault.

### How it works

PAI indexes your entire vault — following symlinks, deduplicating by inode, parsing every wikilink — and builds a graph database alongside semantic embeddings. Six tools then operate on this dual representation:

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

The vault indexer follows symlinks (critical for vaults built on symlinks), deduplicates files by inode to handle multiple paths to the same file, and builds a complete wikilink graph with Obsidian-compatible shortest-match resolution.

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

