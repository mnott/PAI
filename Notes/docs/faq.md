# PAI Knowledge OS - Frequently Asked Questions

[Back to Index](index.md)

---

## Installation

### 1. What are the system requirements?

- macOS or Linux
- Bun (JavaScript runtime)
- Node.js 20+
- Claude Code
- Docker (only for full mode with PostgreSQL)

Windows is not currently supported because the daemon uses macOS launchd. Windows support is planned for v1.0.0.

### 2. How long does installation take?

About 5 minutes. Clone the repo, run `bun install && bun run build`, then `pai setup`. The wizard handles everything else interactively.

### 3. Can Claude Code install PAI for me?

Yes. Tell Claude Code: "Clone https://github.com/mnott/PAI and set it up for me." Claude finds the setup skill and runs the wizard.

### 4. What's the difference between simple mode and full mode?

**Simple mode (SQLite):** Zero dependencies beyond Bun. Keyword search only. No Docker needed. Great for trying PAI.

**Full mode (PostgreSQL + pgvector):** Adds semantic search - finding things by meaning, not just exact words. Requires Docker to run PostgreSQL.

### 5. Can I switch from simple mode to full mode later?

Yes. Run `pai daemon migrate` to migrate your data from SQLite to PostgreSQL. Your registry, sessions, and projects are preserved.

### 6. How much disk space does PAI use?

The database size depends on how much content you have. Typical usage:
- Registry (SQLite): 1-5 MB
- PostgreSQL (full mode): 500 MB - 2 GB for 449K chunks with embeddings
- Embedding model (Snowflake Arctic): ~100 MB (downloaded once)
- Reranker model (ms-marco-MiniLM): ~23 MB (downloaded once)

---

## Usage

### 7. How do I search my memory?

Three ways:

**Natural language (in Claude Code):** Just ask Claude. "Search your memory for authentication" or "What do you know about the database migration?"

**CLI:** `pai memory search "authentication"` or `pai memory search --mode semantic "how does login work"`

**MCP tool:** Claude calls `memory_search` automatically based on your question.

### 8. What gets indexed?

PAI indexes your Claude Code session notes and project files from registered projects. Specifically:
- Session notes in `Notes/` directories
- `MEMORY.md` files (evergreen memory)
- `TODO.md` files
- Documentation files
- Source code files (configurable exclusions)

### 9. How often does indexing happen?

Every 5 minutes by default. Configurable via `indexIntervalSecs` in `~/.config/pai/config.json`. You can also trigger manual indexing with `pai memory index`.

### 10. What is context preservation and why do I need it?

When Claude Code's context window fills up (~200K tokens), it compresses the conversation. Without PAI, Claude forgets everything from before the compression. PAI intercepts this with a two-stage relay: saves state before compression, injects it back after. You keep working without re-explaining anything.

### 11. What does "Go" do?

When you say "Go" to Claude, PAI's session start hooks load your project's TODO.md and continuation prompt. Claude picks up exactly where the last session stopped - reading your open tasks, recent activity, and current context.

### 12. Can I use PAI with multiple Claude Code sessions simultaneously?

Yes. The daemon handles multiple connections over the Unix socket. Each session gets its own MCP shim connection, and the daemon multiplexes without contention.

---

## Data and Privacy

### 13. Is my data sent anywhere?

No. Everything runs locally on your machine. The daemon, database, embedding model, and reranker all execute locally. No data leaves your computer. No cloud API keys are needed for core functionality.

### 14. Where is my data stored?

Two locations:
- `~/.pai/registry.db` - SQLite registry (projects, sessions, links)
- PostgreSQL database on localhost:5432 (full mode) - chunks, embeddings, observations

Both are on your machine and under your control.

### 15. How do I back up my data?

```bash
pai backup
```

Creates a timestamped backup in `~/.pai/backups/` containing the registry, config, and a PostgreSQL dump. Restore with `pai restore <path>`.

### 16. Can I delete my data?

Yes. Remove `~/.pai/`, drop the PostgreSQL database, and remove the daemon (`pai daemon uninstall`). All PAI data is gone.

---

## Compatibility

### 17. Does PAI work with Cursor?

Yes. PAI's 9 MCP tools work with Cursor via MCP. Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pai": {
      "command": "node",
      "args": ["/path/to/PAI/dist/daemon-mcp/index.mjs"]
    }
  }
}
```

You get memory search, project management, and session listing. Cursor doesn't support hooks or skills, so those features are Claude Code only.

### 18. Does PAI work with Gemini CLI?

Yes. Same MCP tools via `gemini-extension.json`. Full MCP tool access, no hooks or skills.

### 19. Will PAI work with future AI assistants?

Any assistant that supports MCP (Model Context Protocol) can use PAI's 9 tools. As more assistants adopt MCP, PAI's compatibility expands automatically.

### 20. Does PAI work with Obsidian?

Yes. PAI can sync your session notes into an Obsidian vault as symlinks (`pai obsidian sync`). The Enterprise tier adds Zettelkasten intelligence - 6 graph operations on your vault. PAI indexes all Obsidian link types (wikilinks, embeds, markdown links).

---

## Pricing and Licensing

### 21. Is PAI open source?

Yes. PAI is MIT licensed. The core is free forever. Premium tiers (Pro and Enterprise) add advanced features but the source code is fully open.

### 22. What's free and what's paid?

**Free ($0):** Core memory (keyword search), session management, project registry, 5 hooks, 6 productivity skills (plan, review, journal, research, share, createskill), UI customization, context preservation.

**Pro ($9/mo):** Everything in Free + semantic search, hybrid search, cross-encoder reranking, recency boost, observation capture, progressive injection, session summaries.

**Enterprise ($29/mo):** Everything in Pro + Zettelkasten (6 graph operations), vault indexer, art direction, story explanations, voice/prosody.

See [Pricing](pricing.md) for the full breakdown.

### 23. Is there a free trial of Pro/Enterprise?

Currently (v0.7.0), all features are free. Tier gating is planned for v0.9.0. You can try everything today at no cost.

### 24. What happens if I cancel my subscription?

Your data remains intact - it's all local. You keep all Free tier features. Premium features gracefully degrade (semantic search falls back to keyword, observations stay in the database but require Pro to query).

---

## Troubleshooting

### 25. The daemon won't start

Check the logs: `pai daemon logs`. Common causes:
- Stale socket file: `rm /tmp/pai.sock` then `pai daemon restart`
- Port conflict: another process on port 5432
- Missing dependencies: re-run `bun install && bun run build`

### 26. Search returns no results

1. Check indexing status: `pai memory status`
2. Trigger manual index: `pai memory index`
3. For semantic search, check embeddings: `pai memory embed`
4. Verify the project is registered: `pai project list`

### 27. MCP tools don't appear in Claude Code

1. Verify registration: check `~/.claude.json` for PAI MCP entry
2. Restart Claude Code (required after MCP changes)
3. Check daemon: `pai daemon status`

### 28. Context preservation isn't working

1. Verify hooks are deployed: check `~/.claude/Hooks/` for PAI hook files
2. Verify hook registration: check `~/.claude/settings.json` for PAI hooks
3. Check auto-compact is enabled: look for `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json`
4. Re-run setup: `pai setup` (idempotent, safe to re-run)

### 29. PostgreSQL connection refused

```bash
# Check Docker container status
docker ps | grep pai-postgres

# Start if stopped
docker start pai-postgres

# If container doesn't exist, create it
docker run -d \
  --name pai-postgres \
  -e POSTGRES_USER=pai \
  -e POSTGRES_PASSWORD=pai \
  -e POSTGRES_DB=pai \
  -p 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg17
```

### 30. How do I update PAI?

```bash
cd /path/to/PAI
git pull
bun install
bun run build
pai daemon restart
```

The build automatically recompiles hooks, regenerates skill stubs, and updates symlinks. Restart the daemon to pick up changes.
