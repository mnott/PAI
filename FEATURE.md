# PAI Feature Comparison

## Credit

This project is inspired by Daniel Miessler's work. He coined the "PAI" concept (Personal AI
Infrastructure) and built [Fabric](https://github.com/danielmiessler/fabric), a Python CLI for
augmenting human capabilities with reusable AI prompt patterns. If you haven't seen Fabric,
go look at it — it's excellent and solves a different problem extremely well.

This repository, PAI Knowledge OS, starts from the same name and philosophy but takes a
different direction: persistent memory, session continuity, and deep Claude Code integration.

---

## Feature Comparison

| Feature | Fabric (Miessler) | PAI Knowledge OS (this) |
|---|---|---|
| **Language** | Python | TypeScript (Bun) |
| **Primary interface** | CLI pipe (`echo "..." \| fabric -p pattern`) | MCP server + CLI (`pai`) |
| **Prompt templates** | Yes — 200+ community "patterns" | No (out of scope) |
| **YouTube transcript extraction** | Yes (built-in) | Yes — via [Scribe MCP](https://github.com/mnott/Scribe) |
| **WhatsApp integration** | No | Yes — via [Whazaa MCP](https://github.com/mnott/Whazaa) |
| **Google Workspace integration** | No | Yes — via [Coogle MCP](https://github.com/mnott/Coogle) |
| **DEVONthink integration** | No | Yes — via [devonthink-mcp](https://github.com/mnott/Devon) |
| **Hookmark integration** | No | Yes — via [Hook MCP](https://github.com/mnott/Hook) |
| **LLM pipe-through workflow** | Yes — core feature | No |
| **Persistent session memory** | No | Yes — auto-indexed, 449K+ chunks |
| **Session registry** | No | Yes — SQLite, tracks 77+ projects |
| **Background daemon** | No | Yes — launchd, IPC via Unix socket |
| **MCP server** | No | Yes — 9 tools, 19 prompts, 11 resources exposed to Claude Code |
| **Keyword search (BM25)** | No | Yes — GIN full-text index, PostgreSQL |
| **Semantic search (vector)** | No | Yes — pgvector HNSW, Snowflake Arctic 768-dim |
| **Multi-backend storage** | No | Yes — SQLite (simple) or PostgreSQL (full) |
| **Obsidian vault bridge** | No | Yes — symlinks + auto-generated topic pages |
| **Project lifecycle** | No | Yes — promote, archive, move, detect from cwd |
| **Auto project registration** | No | Yes — detects .git, package.json, pubspec.yaml, etc. on session start |
| **Setup wizard** | No | Yes — idempotent 14-step interactive wizard |
| **Hook system** | No | Yes — pre-compact, session-stop, auto-cleanup, whisper rules |
| **Automatic session notes** | No | Yes — AI-generated via daemon worker (Opus/Sonnet), topic-based splitting |
| **Topic-based note splitting** | No | Yes — Jaccard similarity detects topic shifts, creates separate notes |
| **Whisper rules** | No | Yes — injects critical rules on every prompt, survives compaction and /clear |
| **4-layer wake-up context** | No | Yes — `memory_wakeup` tool loads identity (L0), recent story (L1), on-demand topic (L2), deep search (L3) |
| **Temporal knowledge graph** | No | Yes — `kg_add`, `kg_query`, `kg_invalidate`, `kg_contradictions` tools; facts have `valid_from`/`valid_to` timestamps |
| **Memory taxonomy tool** | No | Yes — `memory_taxonomy` surfaces project/session/chunk counts and recent activity at a glance |
| **Mid-session auto-save** | No | Yes — Stop hook fires every 15 human messages (configurable via `PAI_AUTO_SAVE_INTERVAL`), saves without ending session |
| **Cross-project tunnel detection** | No | Yes — `memory_tunnels` finds concepts shared across multiple projects via FTS vocabulary comparison |
| **Session note reconstruction** | No | Yes — /reconstruct skill retroactively creates notes from JSONL + git history |
| **Backup / restore** | No | Yes — timestamped pg_dump + registry export |
| **Multi-session concurrency** | n/a | Yes — daemon multiplexes Claude sessions |
| **Budget-aware advisor mode** | No | Yes — auto-adjusts subagent model tiering based on weekly usage (normal/conservative/strict/critical) |
| **Natural language mode switching** | No | Yes — say "go easy on the budget" or "lock it down" to change advisor mode |
| **22 built-in skills** | No | Yes — /review, /plan, /journal, /share, /whisper, /advisor, /reconstruct, /consolidate, /vault-*, /research, /art, and more |
| **God-note detection** | No | Yes — detects overgrown session notes with confidence tagging, Louvain community detection |
| **Privacy tags** | Yes — `<private>` blocks excluded from memory | Yes — `<private>` blocks stripped before indexing, never stored or searched |
| **3-layer search pattern** | Yes — search index → timeline → get_observations | Yes — compact format (~50 tokens/result) → memory_get for full content |
| **One-command install** | Yes — `npx claude-mem install` | Yes — `npx @tekmidian/pai install` |
| **Custom statusline** | No | Yes — model, MCPs, context meter, usage limits, advisor mode, pace indicator, colors |
| **Local / private** | Yes | Yes — no cloud, no external API for core |
| **Docker required** | No | Only for full mode (PostgreSQL); SQLite mode needs none |
| **macOS / Linux** | Yes | Yes |

---

## What's New in PAI Knowledge OS

These are capabilities that don't exist in Fabric and address a specific problem:
Claude Code starts every session cold, with no memory of past work.

### Persistent Memory Engine

A background daemon indexes your Claude Code session notes and project files every five
minutes. Chunks are hashed for change detection, stored in PostgreSQL, and made available
for both keyword search (BM25/GIN) and semantic search (pgvector HNSW). When you ask
"what were we doing with the authentication system last month?" — it finds it.

### Session Registry

Every Claude Code project and session is tracked in a lightweight SQLite registry. Projects
are detected automatically from the current working directory. Sessions get unique numbers,
tags, aliases, and cross-references. You can query across all of them from any Claude session.

### MCP Server + Daemon Architecture

The MCP server exposes memory and registry tools directly inside Claude Code. The daemon
handles the indexing lifecycle and accepts connections over a Unix socket, so multiple Claude
Code instances can share one daemon without contention. The MCP shim is a thin connector;
all state lives in the daemon.

### Obsidian Vault Bridge

PAI can sync your session notes and project memory into an Obsidian vault as a live knowledge
graph. Symlinks connect the vault to your actual note files. Topic pages are auto-generated
from project metadata. The vault updates on demand via `pai obsidian sync`.

### Two Storage Modes

Simple mode requires nothing beyond Bun — SQLite only, keyword search only. Full mode adds
Docker, PostgreSQL, pgvector, and Snowflake Arctic embeddings for semantic search. The setup
wizard asks which you want and configures everything.

### Idempotent Setup Wizard

`pai setup` walks through configuration interactively and is safe to re-run. It handles
PostgreSQL connection, embedding model selection, indexing interval, CLAUDE.md template
installation, MCP server registration, and Obsidian configuration — and detects what's
already configured so re-runs only change what you choose.

---

## What Fabric Does That This Doesn't

To be clear about scope:

- **Prompt pattern library** — Fabric ships 200+ community-maintained prompt templates. PAI
  Knowledge OS has no pattern system.
- **Pipe-through LLM workflows** — Fabric's `echo "..." | fabric -p pattern` idiom is elegant
  for processing text at the command line. PAI doesn't replicate this.
- **YouTube / web extraction** — Fabric can pull transcripts and content from URLs as input to
  patterns. PAI covers YouTube transcription via the companion
  [Scribe MCP](https://github.com/mnott/Scribe) server, but does not replicate Fabric's
  web-scraping pipeline.

If you want prompt patterns and CLI pipe-through workflows, use Fabric. If you want Claude
Code to remember everything across sessions, use this.

---

## Using Both

They're not mutually exclusive. Fabric handles one-shot prompt workflows. PAI Knowledge OS
handles persistent memory for Claude Code. Many people will want both.
