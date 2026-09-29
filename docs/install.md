# Install

## Quick Start

Tell Claude Code:

> Clone https://github.com/mnott/PAI and set it up for me

Or install with a single command:

```bash
npx @tekmidian/pai install
```

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
pai setup            # interactive
pai setup --yes      # unattended: every prompt takes its default
```

The wizard walks you through: storage mode (SQLite or PostgreSQL), project directories, Obsidian vault path, MCP server registration, CLAUDE.md template, and daemon configuration. It's idempotent — safe to re-run anytime.

On Linux, follow [Linux, from zero (Ubuntu)](install-linux.md): it covers the native Claude installer, both storage paths (SQLite, PostgreSQL + pgvector in Docker) and the systemd daemon.

### 3. The daemon

Setup installs and starts it. To manage it:

```bash
pai daemon status      # running? which storage?
pai daemon restart
pai daemon install     # re-create the launchd (macOS) or systemd (Linux) service
```

The daemon runs in the background via launchd (macOS) or a systemd user unit (Linux), indexing your sessions and serving the MCP tools. It starts automatically on login.

### 4. Verify

```bash
pai daemon status    # should show "running"
pai memory search "test"   # should return results after indexing
```

That's it. Claude Code now has persistent memory across all sessions.
