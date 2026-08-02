# PAI Knowledge OS - Product Overview

[Back to Index](index.md)

---

## What PAI Does

PAI gives Claude Code persistent memory. Install it once, and Claude remembers your projects, your decisions, your architecture, and where you left off - across every session, forever.

Everything runs locally on your machine. No cloud. No API keys for the core system. Your data never leaves your computer.

---

## Core: Memory, Sessions, Projects

### Persistent Memory Engine

A background daemon indexes your Claude Code session notes and project files every 5 minutes. Content is chunked, hashed for change detection, and stored in a local database. When you ask Claude something about past work, it searches this index and surfaces relevant context in seconds.

**What you can ask:**

- "Search your memory for authentication" - finds past sessions about auth
- "What do you know about the Whazaa project?" - retrieves full project context
- "Find where we discussed the database migration" - semantic search finds it even with different phrasing

### Session Management

Every Claude Code session gets a numbered note, automatically created and tracked. Sessions are organized by project, tagged, cross-referenced, and searchable.

**What you can ask:**

- "List my recent sessions" - shows what you've been working on
- "What did we do in session 42?" - retrieves any specific session
- "What were we working on last week?" - Claude knows, without you re-explaining

### Project Registry

PAI auto-detects which project you're in from your working directory. 77+ projects tracked across 449K+ indexed chunks in production use.

**What you can ask:**

- "Show me all my projects" - lists everything with stats
- "Which project am I in?" - auto-detects from current directory
- "What's the status of the PAI project?" - full details, sessions, last activity

---

## Productivity: Plan, Review, Journal, Research, Share

Six skills loaded on-demand to conserve context.

### Plan

Forward-looking planning based on open TODOs and recent activity. Reads your TODO.md, reviews recent sessions, and generates prioritized plans.

**What you can ask:**

- "Plan my week" - priorities based on recent activity and open tasks
- "What should I focus on today?" - daily priorities

### Review

Synthesizes session notes, git commits, and completed tasks into themed narratives.

**What you can ask:**

- "Review my week" - narrative synthesis of what you accomplished
- "What did I do today?" - daily review across all projects
- "What themes are emerging in my work?" - spot patterns

### Journal

Freeform reflection capture with timestamps. Think of it as a developer's diary that Claude can reference later.

**What you can ask:**

- "Journal this thought: I think the auth system needs a complete rewrite"
- "Record a note: discovered that the API rate limit is causing timeout issues"

### Research

Structured research methodology with source tracking and synthesis.

**What you can ask:**

- "Research best practices for API rate limiting"
- "Investigate options for real-time notifications"

### Share

Platform-aware social media content generation from your actual work.

**What you can ask:**

- "Share on LinkedIn today" - professional post with real numbers and technical substance
- "Tweet about the vault migration" - punchy X/Twitter thread
- "Share on Bluesky this week" - conversational technical post

Each platform gets appropriate formatting: LinkedIn gets hashtags and narrative, X gets threads and hooks, Bluesky gets conversational tone.

### Createskill

Scaffold new PAI skills with proper structure and trigger phrases.

---

## UI Customization: Statusline, Tab Titles, Tab Colors

### Statusline

A rich terminal statusline showing:
- Current model name
- Active MCP server count
- Context window usage meter with percentage
- Auto-compact threshold indicator
- OAuth usage limits and daily budget pace

### Tab Titles

Terminal tab titles update automatically based on session activity - showing the current project and what Claude is working on.

### Tab Colors

Terminal tab colors change based on context, giving visual cues about which project or session type is active.

---

## Context Preservation: Surviving Compaction

When Claude's context window fills up, it compresses the conversation. Without PAI, everything before that point is lost. PAI intercepts this with a two-stage relay:

1. **Before compression (PreCompact hook)** - Extracts session state from the conversation transcript: recent requests, work summaries, files modified, current task context. Saves to a checkpoint.

2. **After compression (SessionStart hook)** - Reads the checkpoint and injects it back into Claude's fresh context. Claude picks up exactly where it left off.

**What gets preserved:**

- Your last 3 requests
- Work summaries and captured context
- Files modified during the session
- Current working directory and task state
- Session note checkpoints (persistent - survive full restarts)

This happens automatically. You don't configure anything.

---

## Semantic Search: Vector + Reranking + Hybrid

*Pro tier feature*

Three search modes work together for optimal results.

### Keyword Search (BM25)

Full-text search via FTS5 (SQLite) or GIN indexes (PostgreSQL). Fast, exact-match focused. Best for function names, error messages, session numbers.

### Semantic Search (Vector)

768-dimensional Snowflake Arctic embeddings with pgvector HNSW indexes. Finds things by meaning, not just words. "How does the reconnection logic work?" finds the right session even if it never used those words.

### Hybrid Search

Runs both keyword and semantic pipelines, normalizes scores to 0-1, and blends them. Best overall quality for general use.

### Cross-Encoder Reranking

Every search automatically gets a second pass: a cross-encoder model (ms-marco-MiniLM-L-6-v2, 23MB quantized) reads each (query, result) pair and re-scores for relevance. Runs entirely locally.

### Recency Boost

Recent content scores higher with a configurable half-life (default 90 days). A 3-month-old result retains 50% of its score, 6 months retains 25%. Applied after reranking so relevance is scored first, then time-weighted.

---

## Observability: Auto-Capture, Summaries, Progressive Injection

*Pro tier feature*

### Automatic Observation Capture

A PostToolUse hook fires after every Claude Code tool call. A rule-based classifier (no AI, under 50ms) categorizes each action:

| Type | Triggers | Examples |
|------|----------|---------|
| **decision** | Git commits, config changes | `git commit`, writing to config files |
| **bugfix** | Test runs, error investigation | `npm test`, debugging |
| **feature** | New file creation | Creating components, adding endpoints |
| **refactor** | Code restructuring | Renaming, moving files |
| **discovery** | File reads, searches | Reading code, grep searches |
| **change** | File edits | Editing source files, updating configs |

### Progressive Context Injection

At session start, PAI injects recent observations as layered context:

1. **Compact index** (~100 tokens) - observation type counts and active projects
2. **Timeline** (~500 tokens) - recent observations with timestamps
3. **On-demand** - full details available via MCP tools

Claude starts every session already knowing what you were working on.

### Session Summaries

When a session ends, PAI generates a structured summary: what was requested, investigated, learned, completed, and next steps. These feed into progressive context for future sessions.

**What you can ask:**

- "What changes did I make to the daemon today?"
- "Show me all decisions from the last session"
- "Show observation stats" - totals with visual bar charts

---

## Zettelkasten Intelligence: 6 Graph Operations

*Enterprise tier feature*

PAI implements Niklas Luhmann's Zettelkasten principles as six computational operations on your Obsidian vault.

### How It Works

PAI indexes your entire vault - following symlinks, deduplicating by inode, parsing every wikilink - and builds a graph database alongside semantic embeddings.

### The Six Operations

| Operation | What It Does |
|-----------|-------------|
| **Explore** | Follow trains of thought through wikilink chains (BFS traversal) |
| **Surprise** | Find notes semantically close but graph-distant - the "surprising bridge" |
| **Converse** | Ask questions and let the vault "talk back" with unexpected connections |
| **Themes** | Detect emerging clusters of related notes across folders |
| **Health** | Structural audit - dead links, orphans, disconnected clusters, health score |
| **Suggest** | Proactive link suggestions using semantic similarity + tags + graph proximity |

**What you can ask:**

- "Explore notes linked to PAI" - follow trains of thought
- "Find surprising connections to this note" - serendipitous discovery
- "What themes are emerging in my vault?" - detect clusters
- "How healthy is my vault?" - structural audit
- "Suggest connections for this note" - proactive linking

### Vault Indexing Stats

- Full index: ~10 seconds for ~1,000 files
- Incremental: ~2 seconds (hash-based change detection)
- Runs automatically via daemon scheduler
- Supports all link types: wikilinks, embeds, markdown links, markdown embeds

---

## Creative Studio: Art, Story, Voice

*Enterprise tier feature*

### Art Direction

Visual art direction and creative guidance skill for generating consistent aesthetic output.

### Story Explanations

Narrative explanations of technical concepts - turning complex architecture into understandable stories.

### Voice and Prosody

Voice agent template and prosody guidelines for TTS integration. Supports Kokoro (local, no API key) and ElevenLabs backends. Agent-specific voice configuration.

---

## Companion Ecosystem

PAI works alongside these MCP servers (also by the same author):

| Companion | What It Does |
|-----------|-------------|
| **[AIBroker](https://github.com/mnott/AIBroker)** | Unified message bridge (WhatsApp, Telegram, PAILot) |
| **[Whazaa](https://github.com/mnott/Whazaa)** | WhatsApp bridge with voice notes and screenshots |
| **[Telex](https://github.com/mnott/Telex)** | Telegram bridge for text and voice |
| **[Coogle](https://github.com/mnott/Coogle)** | Google Workspace (Gmail, Calendar, Drive) |
| **[Scribe](https://github.com/mnott/Scribe)** | Content extraction and YouTube transcription |
| **[DEVONthink MCP](https://github.com/mnott/devonthink-mcp)** | DEVONthink document search and archival |
| **[Hook MCP](https://github.com/mnott/Hook)** | Hookmark integration for deep linking |
| **[SeriousLetter](https://github.com/mnott/SeriousLetter)** | Job application management |

---

## What You Can Ask Claude

Once PAI is installed, all of these work naturally in conversation:

**Memory:** "Search your memory for authentication" | "What do you know about the Whazaa project?" | "Find where we discussed the database migration"

**Projects:** "Show me all my projects" | "Which project am I in?" | "What's the status of the PAI project?"

**Sessions:** "List my recent sessions" | "What did we do in session 42?" | "What were we working on last week?"

**Review:** "Review my week" | "What did I do today?" | "What themes are emerging?"

**Share:** "Share on LinkedIn today" | "Tweet about the vault migration" | "Share on Bluesky this week"

**Observations:** "What changes did I make today?" | "Show me all decisions from the last session" | "Show observation stats"

**Continue:** "Go" - reads TODO.md and picks up exactly where the last session stopped

**Zettelkasten:** "Explore notes linked to PAI" | "Find surprising connections" | "What themes are emerging in my vault?" | "How healthy is my vault?"
