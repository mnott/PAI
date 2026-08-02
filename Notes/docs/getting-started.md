# Getting Started with PAI Knowledge OS

[Back to Index](index.md)

---

## The Quick Way

Tell Claude Code:

> Clone https://github.com/mnott/PAI and set it up for me

Claude finds the setup skill, checks your system, runs the interactive wizard, and configures everything. You answer a few questions and Claude does the rest.

---

## Prerequisites

| Requirement | Why | Install |
|-------------|-----|---------|
| **Bun** | JavaScript runtime and package manager | `curl -fsSL https://bun.sh/install \| bash` |
| **Node.js 20+** | Required for some build steps | `brew install node` or [nodejs.org](https://nodejs.org) |
| **Claude Code** | The AI coding assistant PAI integrates with | [claude.ai/code](https://claude.ai/code) |
| **Docker** (full mode only) | Runs PostgreSQL + pgvector | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| **macOS or Linux** | Supported platforms | - |

## Step 1: Clone and Build

```bash
git clone https://github.com/mnott/PAI.git
cd PAI
bun install
bun run build
```

The build compiles TypeScript, generates hook modules, and creates skill stubs with symlinks.

## Step 2: Link the CLI

```bash
npm link
```

Or manually:

```bash
ln -s $(pwd)/dist/cli/index.mjs /usr/local/bin/pai
```

Verify: `pai --version` should print `0.7.0`.

## Step 3: Choose Your Mode

### Simple Mode (SQLite)

- Zero dependencies beyond Bun
- Keyword search only (BM25 via FTS5)
- No Docker needed
- Great for trying PAI or lightweight setups

### Full Mode (PostgreSQL + pgvector)

- Adds semantic search and vector embeddings
- Finds things by meaning, not just exact words
- Requires Docker
- Best for serious use with large knowledge bases

If choosing full mode, start PostgreSQL first:

```bash
docker run -d \
  --name pai-postgres \
  -e POSTGRES_USER=pai \
  -e POSTGRES_PASSWORD=pai \
  -e POSTGRES_DB=pai \
  -p 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg17
```

## Step 4: Run the Setup Wizard

```bash
pai setup
```

The interactive wizard walks through 15 steps:

1. **Welcome** - Version check and system validation
2. **Storage backend** - Choose SQLite or PostgreSQL
3. **Embedding model** - Configure Snowflake Arctic (full mode)
4. **CLAUDE.md template** - Install agent orchestration patterns
5. **PAI skill** - Install PAI core skill
6. **Steering rules** - Install steering configuration
7. **Skill stubs** - Create symlinks for 18 MCP prompt skills
8. **Hook system** - Deploy lifecycle hooks to ~/.claude/Hooks/
9. **Hook compilation** - Compile TypeScript hooks to .mjs modules
10. **Claude Code settings** - Configure settings.json
11. **Daemon installation** - Register launchd service
12. **MCP server** - Register PAI as an MCP server in ~/.claude.json
13. **Directory creation** - Create ~/.pai/ and ~/.config/pai/
14. **Initial indexing** - Index your existing Claude Code projects
15. **Verification** - Confirm everything is working

The wizard is idempotent - safe to re-run at any time.

## Step 5: Verify the Installation

```bash
# Check daemon health
pai daemon status

# Check index statistics
pai memory status

# List discovered projects
pai project list
```

All three should return healthy output. If the daemon is not running:

```bash
pai daemon install
pai daemon status
```

## Step 6: Your First Search

Open a new Claude Code session (restart needed for MCP tools to appear). Then try:

```
"Search your memory for [something you worked on recently]"
```

Or from the CLI:

```bash
pai memory search "authentication"
pai memory search --mode semantic "how does the login flow work"
pai memory search --mode hybrid "database migration patterns"
```

## Step 7: Enable Auto-Compact (Recommended)

Add durable auto-compact to survive context window fills:

Tell Claude Code:

> Add CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set to 80 to the env block in ~/.claude/settings.json

This ensures context compaction triggers at 80% and PAI's preservation hooks keep you working seamlessly.

---

## Directory Layout After Setup

```
~/.pai/
    registry.db          # SQLite project registry
    obsidian-vault/      # Symlinked Obsidian vault (if configured)
    backups/             # Timestamped backups

~/.config/pai/
    config.json          # Runtime configuration
    voices.json          # Voice TTS configuration (optional)

~/.claude/
    Hooks/               # Compiled lifecycle hooks (.mjs)
    skills/              # Skill stub symlinks
    settings.json        # Claude Code settings (hooks, env)
    CLAUDE.md            # Agent orchestration patterns

/tmp/
    pai.sock             # Unix socket (daemon IPC)
    pai-daemon.log       # Daemon log
```

---

## Troubleshooting

### Daemon won't start

```bash
# Check logs
pai daemon logs

# Common fix: socket file from crashed daemon
rm /tmp/pai.sock
pai daemon restart
```

### MCP tools don't appear in Claude Code

1. Verify MCP registration: `grep -l "pai" ~/.claude.json`
2. Restart Claude Code (required after MCP changes)
3. Check daemon: `pai daemon status`

### Search returns no results

```bash
# Check if indexing has run
pai memory status

# Trigger manual index
pai memory index

# For semantic search, check embeddings
pai memory embed
```

### PostgreSQL connection refused

```bash
# Check Docker container
docker ps | grep pai-postgres

# Start if stopped
docker start pai-postgres
```

---

## What's Next

- Read the [Product Overview](product-overview.md) for a complete feature walkthrough
- Explore [Use Cases](use-cases.md) for real-world scenarios
- Check the [Technical Architecture](technical-architecture.md) for system design details
- Review the [Plugin System](plugin-system.md) for module customization
