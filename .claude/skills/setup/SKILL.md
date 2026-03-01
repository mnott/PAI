---
name: setup
description: >
  Install and configure PAI Knowledge OS from a local clone. USE WHEN user says "set up PAI",
  "install PAI", "configure PAI", "give Claude a memory", OR user has just cloned the repo
  and asks Claude to get it running. Covers prerequisites, storage selection, build, daemon
  install, MCP config, initial indexing, and verification. Fully idempotent — safe to run
  on an already-configured system; each step checks what is done and skips or completes only
  what is missing.
---

# PAI Knowledge OS - Setup

**Gets PAI fully running from a fresh clone — or verifies an existing install is healthy.**

Each step checks the current state first. If already done, it reports what was found and skips. If partially done, it completes only the missing parts. Running this on a fully installed system is safe and informative.

> **Quick path:** For most users, `pai setup` handles everything automatically — storage,
> CLAUDE.md, PAI skill, hooks, settings.json wiring, statusline, daemon, and MCP registration.
> The steps below document what `pai setup` does internally and how to troubleshoot each part.

## What PAI Is

PAI has three components:

| Component | Binary | Role |
|-----------|--------|------|
| **CLI** | `dist/cli/index.mjs` | The `pai` command — indexing, search, management |
| **Daemon** | `dist/daemon/index.mjs` | Background service, launchd-managed as `com.pai.pai-daemon` |
| **MCP shim** | `dist/daemon-mcp/index.mjs` | Thin proxy from Claude Code to daemon over Unix socket |

The daemon does the heavy lifting (indexing, embeddings). The MCP shim gives Claude Code access to PAI's memory tools. The CLI lets you inspect and manage everything.

---

## Step 1 — Check Prerequisites

**Check first:**
```bash
bun --version
docker --version 2>/dev/null || echo "Docker not installed"
```

**If already done:**
> Bun [version] is installed. Docker [version / not installed]. Continuing.

**If Bun is missing:**
```bash
curl -fsSL https://bun.sh/install | bash
```
Then open a new shell so `bun` is on `$PATH`. Docker is optional — only needed for PostgreSQL mode.

---

## Step 2 — Install Dependencies and Build

**Check first:**
```bash
# Check if the build is current: dist must exist AND be newer than src
REPO="$PWD"   # set this to wherever PAI was cloned

if [ -f "$REPO/dist/cli/index.mjs" ] && \
   [ -f "$REPO/dist/daemon/index.mjs" ] && \
   [ -f "$REPO/dist/daemon-mcp/index.mjs" ]; then
  # Check if any source file is newer than the build output
  NEWEST_SRC=$(find "$REPO/src" -name "*.ts" -newer "$REPO/dist/cli/index.mjs" 2>/dev/null | head -1)
  if [ -z "$NEWEST_SRC" ]; then
    echo "BUILD_CURRENT"
  else
    echo "BUILD_STALE: $NEWEST_SRC is newer than dist"
  fi
else
  echo "BUILD_MISSING"
fi
```

**If already done (BUILD_CURRENT):**
> Build is current — all three binaries exist and no source files are newer. Skipping build.

**If not done or stale (BUILD_MISSING or BUILD_STALE):**
```bash
cd "$REPO"
bun install
bun run build
```

Verify all three binaries exist before continuing:
```bash
ls dist/cli/index.mjs dist/daemon/index.mjs dist/daemon-mcp/index.mjs
```

---

## Step 3 — Choose Storage

**Check first:**
```bash
cat ~/.config/pai/config.json 2>/dev/null || echo "CONFIG_MISSING"
```

**If config exists:**
> An existing PAI config was found:
> [show the contents]
>
> Keep this configuration? Or reconfigure? (keep / reconfigure)

If the user says **keep**, check that the storage backend is actually running:

- If `storageBackend` is `postgres`:
  ```bash
  docker ps --filter "name=pai-pgvector" --format "{{.Status}}" 2>/dev/null
  ```
  - If the container is **running**: report "PostgreSQL container is running." and continue to Step 4.
  - If the container **exists but is stopped**: offer to start it:
    ```bash
    docker start pai-pgvector
    sleep 3 && docker exec pai-pgvector pg_isready -U pai
    ```
  - If the container **does not exist**: the data volume may be gone. Offer to recreate (see Full mode below) or fall back to SQLite.

- If `storageBackend` is `sqlite`: report "SQLite mode — no container needed." and continue to Step 4.

If the user says **reconfigure**, proceed with the storage selection question below.

**If config is missing (CONFIG_MISSING) — USER INTERACTION REQUIRED:**

> I need to set up PAI's storage. You have two options:
>
> **Option 1: Simple mode (SQLite)**
> - Zero dependencies — works right away
> - Keyword search only (fast, finds exact terms)
> - Great for trying PAI out or smaller setups
> - No Docker needed
>
> **Option 2: Full mode (PostgreSQL + pgvector)**
> - Semantic search — finds things by meaning, not just words
> - Vector embeddings for concept matching
> - Handles large knowledge bases (100K+ documents)
> - Requires Docker (I'll set it up for you)
>
> Which do you prefer? Most users go with Full mode.

### If Simple mode (SQLite):

```bash
mkdir -p ~/.config/pai
cat > ~/.config/pai/config.json <<'EOF'
{
  "storageBackend": "sqlite",
  "socketPath": "/tmp/pai.sock",
  "indexIntervalSecs": 300
}
EOF
```

Note: semantic search is not available in SQLite mode. Keyword search works immediately.

### If Full mode (PostgreSQL + pgvector):

First verify Docker is running:
```bash
docker info 2>/dev/null | head -5
```

If Docker is not running, start Docker Desktop, then retry. If Docker is not installed, offer to fall back to SQLite mode.

Check if the container already exists:
```bash
docker ps -a --filter "name=pai-pgvector" --format "{{.Names}} {{.Status}}"
```

- If the container **already exists and is running**: no action needed, skip to writing the config.
- If the container **exists but is stopped**:
  ```bash
  docker start pai-pgvector
  sleep 3 && docker exec pai-pgvector pg_isready -U pai
  ```
- If the container **does not exist**, create it:
  ```bash
  docker run -d \
    --name pai-pgvector \
    -e POSTGRES_USER=pai \
    -e POSTGRES_PASSWORD=pai \
    -e POSTGRES_DB=pai \
    -p 127.0.0.1:5432:5432 \
    --restart unless-stopped \
    pgvector/pgvector:pg17

  sleep 3 && docker exec pai-pgvector pg_isready -U pai
  ```
  Expected: `/var/run/postgresql:5432 - accepting connections`

Write the config (safe to overwrite when reconfiguring):
```bash
mkdir -p ~/.config/pai
cat > ~/.config/pai/config.json <<'EOF'
{
  "storageBackend": "postgres",
  "socketPath": "/tmp/pai.sock",
  "indexIntervalSecs": 300,
  "embeddingModel": "Snowflake/snowflake-arctic-embed-m-v1.5",
  "postgres": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "pai",
    "user": "pai",
    "password": "pai"
  }
}
EOF
```

---

## Step 4 — Link the CLI

**Check first:**
```bash
pai --version 2>/dev/null && echo "CLI_OK" || echo "CLI_MISSING"
```

**If already done (CLI_OK):**
> `pai` is in PATH and reports version [X.Y.Z]. Skipping link step.

**If not done (CLI_MISSING):**
```bash
# Preferred: use npm link (handles PATH automatically)
cd "$REPO" && npm link

# Alternative if npm link fails: symlink manually
# ln -sf "$REPO/dist/cli/index.mjs" /usr/local/bin/pai
# chmod +x /usr/local/bin/pai
```

Verify:
```bash
pai --version
```

If `command not found`, check that `/usr/local/bin` is in your `$PATH`.

---

## Step 5 — PAI Skill

> **Automated by `pai setup` (Step 5).** Manual steps below are only needed if you skipped that.

The PAI skill provides session lifecycle automation — pause/end/continue commands, token monitoring, git commit rules, and session note naming.

**Check first:**
```bash
[ -f ~/.claude/skills/PAI/SKILL.md ] && grep -q "Generated by PAI Setup" ~/.claude/skills/PAI/SKILL.md \
  && echo "PAI_SKILL_OK" || echo "PAI_SKILL_MISSING"
```

**If already installed (PAI_SKILL_OK):**
> PAI skill is installed at ~/.claude/skills/PAI/SKILL.md. Skipping.

**If missing:**
The `pai setup` wizard installs this automatically from `templates/pai-skill.template.md`. To install manually:
```bash
mkdir -p ~/.claude/skills/PAI
REPO="$PWD"  # PAI repo root
sed "s|\${HOME}|$HOME|g" "$REPO/templates/pai-skill.template.md" > ~/.claude/skills/PAI/SKILL.md
```

---

## Step 6 — Hooks and Statusline

> **Automated by `pai setup` (Step 6).** Manual steps below are only needed if you skipped that.

PAI uses Claude Code hooks to track session lifecycle events:

| Hook | Event | What it does |
|------|-------|-------------|
| `pai-pre-compact.sh` | PreCompact | Marks session as compacted, logs compaction event |
| `pai-session-stop.sh` | Stop | Marks session completed, auto-renames session note |

The statusline script shows greeting, MCPs, and context usage in the Claude Code status bar.

**Check first:**
```bash
[ -f ~/.claude/Hooks/pai-pre-compact.sh ] && echo "HOOKS_OK" || echo "HOOKS_MISSING"
[ -f ~/.claude/statusline-command.sh ] && echo "STATUSLINE_OK" || echo "STATUSLINE_MISSING"
```

**If already installed:** Skip.

**If missing:** The `pai setup` wizard copies these from the repo. To install manually:
```bash
REPO="$PWD"
cp "$REPO/src/hooks/pre-compact.sh" ~/.claude/Hooks/pai-pre-compact.sh
cp "$REPO/src/hooks/session-stop.sh" ~/.claude/Hooks/pai-session-stop.sh
cp "$REPO/statusline-command.sh" ~/.claude/statusline-command.sh
chmod +x ~/.claude/Hooks/pai-pre-compact.sh ~/.claude/Hooks/pai-session-stop.sh ~/.claude/statusline-command.sh
```

---

## Step 7 — Settings.json (Env, Hooks, Statusline)

> **Automated by `pai setup` (Step 7).** Manual steps below are only needed if you skipped that.

PAI wires itself into `~/.claude/settings.json` with:

| Setting | Purpose |
|---------|---------|
| `env.PAI_DIR` | Base directory for hooks and statusline (`~/.claude`) |
| `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Auto-compact threshold (default: 80%) |
| `hooks.PreCompact` | Fires `pai-pre-compact.sh` on context compaction |
| `hooks.Stop` | Fires `pai-session-stop.sh` on session end |
| `statusLine` | Shows PAI statusline with context meter and MCPs |

**The merge is non-destructive** — existing env vars, hooks, and settings are preserved. PAI only adds entries that are missing.

**Check first:**
```bash
grep -q "PAI_DIR" ~/.claude/settings.json 2>/dev/null && echo "SETTINGS_OK" || echo "SETTINGS_MISSING"
```

**If already configured:** Skip.

**If missing:** `pai setup` handles this automatically via the settings-manager. To patch manually, add the entries listed above to your `~/.claude/settings.json`.

**Personalisation (not automated):** Set `DA` (assistant name) and `DA_COLOR` in settings.json env section after setup if you want a custom greeting. PAI does not set these — they're personal choices.

---

## Step 8 — Registry Scan

**Check first:**
```bash
pai registry stats 2>/dev/null || echo "REGISTRY_EMPTY"
```

**If registry has projects:**
> Registry already contains [N] projects and [M] sessions.
>
> Scan for newly added projects? (yes / no)

If the user says **yes** (or this is a fresh setup): run the scan.

**If empty:**
```bash
pai registry scan
```

This discovers all Claude Code projects from `~/.claude/projects/`. Report how many projects were found. A typical setup finds 5–50 projects.

---

## Step 9 — Install Daemon and Register MCP

> **Automated by `pai setup` (Steps 8-9).** Manual steps below are only needed if you skipped that.

**Check first:**
```bash
pai daemon status 2>/dev/null && echo "DAEMON_RUNNING" || echo "DAEMON_NOT_RUNNING"
```

Also check MCP registration:
```bash
grep -q '"pai"' ~/.claude.json 2>/dev/null && echo "MCP_REGISTERED" || echo "MCP_NOT_REGISTERED"
```

**If daemon is running and MCP is registered:**
> Daemon is running (uptime: [X]). PAI MCP tools are registered in ~/.claude.json.
> Nothing to do — skipping installation.

**If daemon is running but MCP is not registered:**
> Daemon is running but MCP tools are not registered. Registering now.
```bash
pai daemon install --mcp-only 2>/dev/null || pai daemon install
```

**If daemon is not running:**
```bash
pai daemon install
```

This command:
- Creates the launchd plist at `~/Library/LaunchAgents/com.pai.pai-daemon.plist`
- Loads the daemon via `launchctl`
- Registers the MCP shim in `~/.claude.json` so Claude Code can find PAI's tools

Verify the daemon started:
```bash
pai daemon status
```

Expected: `Daemon running. Socket: /tmp/pai.sock`

If the daemon fails to start, check the log:
```bash
tail -20 /tmp/pai-daemon.log
```

---

## Step 10 — Initial Index

**Check first:**
```bash
pai memory status 2>/dev/null
```

**If chunks > 0:**
> PAI has already indexed [K] files into [C] chunks.
>
> **PostgreSQL only:** Check embedding coverage:
> - If fewer than 50% of chunks have embeddings, suggest running `pai memory embed` in the background.
> - If coverage is 50% or more, report the percentage and move on.

**If empty (chunks = 0):**
```bash
pai memory index
```

Check the results:
```bash
pai memory status
```

**PostgreSQL only** — start embedding generation in the background:
```bash
pai memory embed &
```

Embeddings take a few minutes to generate. Semantic search becomes available as they complete. Check progress with `pai memory status` at any time.

---

## Step 11 — Verify End-to-End

Run a full health check:
```bash
pai daemon status
pai memory status
pai project list | head -10
```

Report a comprehensive status summary to the user:

> PAI is fully set up. Current state:
>
> - Daemon: [running / not running]
> - Storage: [sqlite / postgres — container status]
> - Projects: [N] registered
> - Indexed: [K] files, [C] chunks
> - Embeddings: [M] / [C] ([%]) — [postgres only]
>
> **Restart Claude Code** so the MCP tools take effect. After restart, try:
> - "Show me all my projects"
> - "Search your memory for [something you worked on recently]"
>
> The daemon runs every 5 minutes to pick up new sessions automatically.
> For the full user manual, see MANUAL.md in this repo.

---

## Step 12 — CLAUDE.md (Global Multi-Agent Patterns)

**Check first:**
```bash
# Check if CLAUDE.md exists
if [ -f ~/.claude/CLAUDE.md ]; then
  # Check for PAI-generated marker
  grep -q "<!-- Generated by PAI Setup -->" ~/.claude/CLAUDE.md \
    && echo "PAI_CLAUDE_MD" \
    || echo "CUSTOM_CLAUDE_MD"
else
  echo "NO_CLAUDE_MD"
fi
```

**If PAI-generated marker is present (PAI_CLAUDE_MD):**
> PAI CLAUDE.md is already installed (marker found). Skipping.
> To reinstall with the latest template, delete ~/.claude/CLAUDE.md and re-run this step.

**If a custom CLAUDE.md exists (CUSTOM_CLAUDE_MD):**
> A custom ~/.claude/CLAUDE.md was found that was not generated by PAI.
>
> Options:
> 1. **Merge PAI patterns** — append PAI's multi-agent blocks to your existing file
> 2. **Keep yours** — do nothing
> 3. **Replace** — backup your file and install PAI's template
>
> Which would you prefer? (merge / keep / replace)

- If **merge**: append the PAI pattern blocks (parallel execution, spotchecks, swarm mode, agent-first architecture) to the existing file without replacing anything. Do NOT add the `<!-- Generated by PAI Setup -->` marker — the file is a hybrid.
- If **keep**: skip this step entirely.
- If **replace**: proceed as for NO_CLAUDE_MD, backing up first.

**If no CLAUDE.md exists (NO_CLAUDE_MD):**

> Would you like me to install a CLAUDE.md template that optimizes Claude Code for
> multi-agent workflows? This adds patterns for parallel execution, spotchecks, and
> autonomous swarm mode. It also configures PAI as the first search target for memory
> queries.
>
> (yes / no)

If yes:
```bash
# Install from the repo template, substituting $HOME
sed "s|\${HOME}|$HOME|g" "$REPO/templates/claude-md.template.md" > ~/.claude/CLAUDE.md
```

The template must include a `<!-- Generated by PAI Setup -->` marker at the top so future runs can detect it. The template should contain:
- Agent-first architecture patterns
- Parallel execution guidance
- PAI memory search instructions with the note that PAI should be checked first before falling back to other search methods
- Swarm mode orchestration patterns

---

## Step 13 — Embedding Priority

The daemon's embedding process is CPU-intensive but runs as a background job. A future release will launch the embedding worker with `nice -n 10` so it yields CPU to foreground tasks automatically. For now, if you notice CPU pressure during embedding, you can pause it:

```bash
# Pause embedding (sends SIGSTOP to the embed process)
pkill -STOP -f "pai memory embed"

# Resume when ready
pkill -CONT -f "pai memory embed"
```

This step has no interactive component — just report the above to the user so they know the option exists.

---

## Step 14 — Obsidian Integration (Optional)

**Check first:**
```bash
if [ -d ~/.pai/obsidian-vault/ ]; then
  echo "VAULT_EXISTS"
  pai obsidian status 2>/dev/null || echo "STATUS_UNAVAILABLE"
else
  echo "NO_VAULT"
fi
```

**If vault exists (VAULT_EXISTS):**
> Obsidian vault found at ~/.pai/obsidian-vault/
> [show output of `pai obsidian status`]
>
> Vault health is [healthy / degraded]. [If degraded, report what is wrong.]

Run a sync if health shows stale links or missing pages:
```bash
pai obsidian sync
```

**If no vault (NO_VAULT):**

> Would you like to set up Obsidian integration? This creates a vault at ~/.pai/obsidian-vault/
> with symlinks to all your project memory files, making them browsable in Obsidian.
>
> (yes / no)

If yes:
```bash
pai obsidian sync
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `pai: command not found` | Run `npm link` in the repo dir, or add `dist/cli/index.mjs` to `$PATH` |
| Daemon not starting | Check `tail -20 /tmp/pai-daemon.log` for errors |
| Docker container won't start | Ensure Docker Desktop is running; check port 5432 is free |
| No search results | Daemon may not have indexed yet — run `pai memory index` manually |
| Semantic search returns nothing | Run `pai memory embed` to generate embeddings; takes a few minutes |
| MCP tools not visible in Claude | Restart Claude Code after `pai daemon install` |
| `pg_isready` times out | Wait 10 more seconds and retry; first pull of pgvector image is slow |
| Build appears stale | Delete `dist/` and re-run `bun run build` |
| Config exists but storage is wrong | Delete `~/.config/pai/config.json` and re-run Step 3 |

---

## Summary Checklist

- [ ] Bun installed (`bun --version` works)
- [ ] Build current — all three binaries exist and src is not newer
- [ ] Storage configured — SQLite or PostgreSQL container running
- [ ] CLI linked to PATH (`pai --version` works)
- [ ] PAI skill installed (`~/.claude/skills/PAI/SKILL.md` exists)
- [ ] Hooks installed (`~/.claude/Hooks/pai-pre-compact.sh`, `pai-session-stop.sh`)
- [ ] Statusline installed (`~/.claude/statusline-command.sh`)
- [ ] settings.json wired (env vars, hooks, statusline configured)
- [ ] Registry scan complete (projects discovered)
- [ ] Daemon installed and running (`pai daemon status` shows running)
- [ ] MCP tools registered in `~/.claude.json`
- [ ] Initial index complete (`pai memory status` shows chunks > 0)
- [ ] PostgreSQL: embeddings at 50%+ coverage (or `pai memory embed` running)
- [ ] Claude Code restarted (MCP tools loaded)
- [ ] MCP tools accessible (try "Show me all my projects")
- [ ] (Optional) CLAUDE.md installed or merged
- [ ] (Optional) Obsidian vault synced
