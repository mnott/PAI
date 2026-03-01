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
