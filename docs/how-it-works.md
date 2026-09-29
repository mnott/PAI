# How It Works

## How It Works

A background service runs quietly alongside your work. Every five minutes it indexes your Claude Code projects and session notes — chunking them, hashing them for change detection, and storing them in a local database. When you ask Claude something about past work, it searches this index by keyword, by meaning, or both, and surfaces the relevant context in seconds.

Everything runs locally. No cloud. No API keys for the core system.

For the technical deep-dive — architecture, database schema, CLI reference, and development setup — see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Storage Options

PAI offers two modes, and the setup wizard asks which you prefer.

**Simple mode (SQLite)** — Zero dependencies beyond Node. Keyword search only. Great for trying it out or for systems without Docker.

**Full mode (PostgreSQL + pgvector)** — Adds semantic search and vector embeddings. Finds things by meaning, not just exact words. "How does the reconnection logic work?" finds the right session even if it never used those exact words. Requires Docker.

## Prerequisites

- [Node.js](https://nodejs.org) 20 or newer (22 from apt works) — the installed `pai` runs on Node
- [Bun](https://bun.sh) — only to build from a git checkout (development)
- [Docker](https://docs.docker.com/get-docker/) — only for full mode
- [Claude Code](https://claude.ai/code)
- macOS or Linux (tmux for worker panes on Linux; iTerm2 on macOS)
