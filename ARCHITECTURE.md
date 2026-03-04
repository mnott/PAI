# PAI Knowledge OS — Architecture

Technical reference for PAI's architecture, database schema, CLI commands, and development setup.

For user-facing documentation, see [README.md](README.md) and [MANUAL.md](MANUAL.md).

---

## Architecture

```
Claude Code Session
    │
    ├── MCP Shim (stdio)
    │       ↓ NDJSON over /tmp/pai.sock
    │
    ├── PAI Daemon (com.pai.pai-daemon)
    │       ├── Scheduler: index every 5 min
    │       ├── Async embedding (Snowflake Arctic, 768-dim)
    │       └── Storage Backend (pluggable)
    │               ↓
    │       PostgreSQL + pgvector
    │       (chunks, embeddings, files, FTS)
    │
    ├── Registry (SQLite)
    │       ~/.pai/registry.db
    │       Projects, sessions, tags, aliases, links
    │
    └── CLI (pai)
            project, session, registry, memory,
            daemon, obsidian, zettel, backup, restore, setup
```

### Key Components

**Daemon (`com.pai.pai-daemon`)** — A persistent launchd service that owns the indexing lifecycle. It exposes a Unix socket at `/tmp/pai.sock` and speaks NDJSON. The MCP shim connects to this socket rather than to the database directly, which means multiple Claude Code sessions can share a single daemon without connection contention.

**Storage** — Two databases serve different roles:

| Layer | Backend | Location | Purpose |
|-------|---------|----------|---------|
| **Registry** | SQLite (always) | `~/.pai/registry.db` | Projects, sessions, tags, aliases, links. Single-writer is fine — only the CLI and daemon write. Uses `better-sqlite3`. |
| **Memory / Embeddings** | Factory-switchable | PostgreSQL (full) or SQLite (simple) | Text chunks, vector embeddings, file metadata. Chosen at setup time via `~/.config/pai/config.json`. |

- **Simple mode (SQLite)**: Zero dependencies. Keyword search (BM25 via FTS5) works immediately. No Docker needed. Best for trying PAI or smaller setups.
- **Full mode (PostgreSQL + pgvector)**: Semantic search via HNSW vector indexes (768-dim, Snowflake Arctic). GIN indexes for full-text search. Runs in Docker (`pai-pgvector` container, `restart: unless-stopped`). Best for large knowledge bases (100K+ documents).

The storage backend is selected during `pai setup` and configured in `~/.config/pai/config.json` (`storageBackend: "sqlite"` or `"postgres"`). The factory pattern (`src/storage/factory.ts`) instantiates the correct backend at runtime. Both backends implement the same `StorageInterface` (`src/storage/interface.ts`), so all higher-level code (indexer, search, MCP tools) is backend-agnostic.

**Embeddings** — Snowflake Arctic Embed produces 768-dimensional embeddings (PostgreSQL mode only). The daemon generates embeddings asynchronously in the background after initial text indexing, so keyword search is available immediately and semantic search follows within minutes. The embedding process runs at reduced CPU priority (`setPriority(pid, 10)`).

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (JavaScript runtime and package manager)
- [Docker](https://docs.docker.com/get-docker/) (for the PostgreSQL + pgvector container)
- [Claude Code](https://claude.ai/code) (the CLI this integrates with)

### 1. Clone and Build

```bash
git clone https://github.com/mnott/PAI.git
cd PAI
bun install
bun run build
```

The build uses `tsdown` to compile TypeScript. Link the CLI globally:

```bash
npm link   # or: ln -s $(pwd)/dist/cli/index.mjs /usr/local/bin/pai
```

### 2. Start PostgreSQL with pgvector

```bash
docker run -d \
  --name pai-postgres \
  -e POSTGRES_USER=pai \
  -e POSTGRES_PASSWORD=pai \
  -e POSTGRES_DB=pai \
  -p 127.0.0.1:5432:5432 \
  pgvector/pgvector:pg17
```

### 3. Run the Setup Wizard

```bash
pai setup
```

The interactive wizard walks through seven steps:

1. PostgreSQL connection (host, port, credentials)
2. Embedding model selection (Snowflake Arctic recommended)
3. Indexing interval (default: 5 minutes)
4. CLAUDE.md template installation
5. Projects root directory
6. Obsidian vault location (optional)
7. MCP server registration with Claude Code

### 4. Install the Daemon

```bash
pai daemon install
```

This registers `com.pai.pai-daemon` as a launchd service and adds the PAI MCP server to your Claude Code configuration (`~/.claude.json`). The daemon starts immediately and begins indexing.

### 5. Verify

```bash
pai daemon status    # Confirm the daemon is running
pai memory status    # Check index stats (files, chunks, embeddings)
```

If both commands return healthy output, PAI is running. Open a new Claude Code session — the MCP tools will be available immediately.

### Directory Layout After Setup

```
~/.pai/
    registry.db          # SQLite project registry
    obsidian-vault/      # Symlinked Obsidian vault (if configured)
    backups/             # Timestamped backups from `pai backup`

~/.config/pai/
    config.json          # Daemon runtime configuration
    voices.json          # Voice TTS configuration (optional)

/tmp/
    pai.sock             # Unix socket (daemon)
    pai-daemon.log       # Daemon log
```

---

## MCP Server

PAI exposes 7 tools to Claude Code via a daemon-backed MCP shim. The shim speaks stdio (what Claude Code expects) and proxies each request to the background daemon over NDJSON on a Unix socket.

```
Claude Code (stdio)
    └── PAI MCP shim  (dist/daemon-mcp/index.mjs)
            └── NDJSON over /tmp/pai.sock
                    └── PAI daemon  (com.pai.pai-daemon)
                            └── PostgreSQL + pgvector
```

### Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search indexed memory across projects |
| `memory_get` | Retrieve full content of a specific file |
| `project_info` | Look up a project by slug, alias, or number |
| `project_list` | List all registered projects |
| `session_list` | List session notes, optionally filtered by project |
| `registry_search` | Search project metadata (names, paths, tags) |
| `project_detect` | Identify which project a given path belongs to |
| `zettel_explore` | BFS traversal of wikilink graph from a seed note |
| `zettel_surprise` | Find semantically distant but graph-close notes |
| `zettel_converse` | Hybrid search with graph expansion and cross-domain connections |
| `zettel_themes` | Cluster vault notes into thematic groups by embedding similarity |
| `zettel_health` | Audit vault for broken links, orphans, and isolated clusters |
| `zettel_suggest` | Suggest link targets weighted by semantics, tags, and graph neighborhood |

### Tool Reference

**`memory_search(query, mode?, project?, limit?, rerank?)`** — Search the indexed knowledge base. Returns ranked chunks with file paths and line numbers. `mode`: `keyword` (default), `semantic`, or `hybrid`. Cross-encoder reranking is on by default; set `rerank: false` to skip it.

**`memory_get(project, path)`** — Retrieve the complete contents of a specific file from a project's memory index.

**`project_info(identifier)`** — Returns metadata for a project. Accepts a slug, numeric ID, or alias.

**`project_list(status?)`** — Lists all projects in the registry. Filter by `active`, `archived`, or `all`.

**`session_list(project?, limit?)`** — Lists session notes sorted by date descending.

**`registry_search(query)`** — Full-text search over project metadata — names, paths, tags.

**`project_detect(path?)`** — Given a filesystem path (defaults to CWD), returns the matching project.

**`zettel_explore(note, depth?, direction?)`** — BFS walk from a seed note across `vault_links`. Returns a subgraph of neighboring notes with each edge classified as `sequential` or `associative`. `direction`: `outbound` (default), `inbound`, or `both`.

**`zettel_surprise(note, limit?)`** — Returns notes that are semantically dissimilar to `note` but reachable within a short graph distance. Scored as `cosine_similarity × log2(graph_distance + 1)`. Useful for lateral discovery.

**`zettel_converse(query, limit?)`** — Runs a hybrid memory search, expands the result set via graph neighborhood, then surfaces cross-domain connections — notes from unrelated clusters that are semantically close to the query.

**`zettel_themes(min_cluster_size?)`** — Clusters all vault embeddings using agglomerative single-linkage clustering. Returns thematic groups with representative note titles and cluster size.

**`zettel_health()`** — Full structural audit of the vault. Reports broken links (target not in `vault_files`), orphaned notes (no inbound or outbound edges), notes missing embeddings, and isolated clusters detected via union-find.

**`zettel_suggest(note, limit?)`** — Ranks candidate link targets for a given note. Score is a weighted sum: semantic embedding similarity (0.5), shared tags (0.2), graph neighborhood overlap with existing links (0.3).

### Installation

```bash
pai mcp install        # Install MCP shim only
pai daemon install     # Install daemon + MCP together (recommended)
```

Restart Claude Code after installation for the tools to appear.

---

## Search Modes

Three modes, selectable via the `--mode` flag on the CLI or the `mode` parameter in MCP tool calls.

### Keyword (default)

PostgreSQL full-text search using `ts_rank`. No machine learning required. Performs well for exact terms, file names, session numbers, and known identifiers.

```bash
pai memory search "session 0087 obsidian bridge"
```

FTS query builders use OR operators rather than AND. `ts_rank` scores multi-match chunks higher naturally, so recall is maximized while precision comes from ranking.

### Semantic

Vector similarity search using pgvector cosine distance on 768-dimensional Snowflake Arctic embeddings. Matches concepts across paraphrasing, synonyms, and language boundaries.

```bash
pai memory search --mode semantic "how do I reconnect the messenger daemon"
```

Embeddings are generated asynchronously by the daemon scheduler or on demand via `pai memory embed`.

### Hybrid

Runs both keyword and semantic pipelines, normalizes each result set to a 0–1 score range, then blends them with a configurable weight. Delivers the best overall result quality.

```bash
pai memory search --mode hybrid "rate limiting patterns"
```

### Cross-Encoder Reranking (on by default)

All search results are automatically re-scored using a cross-encoder model (`Xenova/ms-marco-MiniLM-L-6-v2`, 23 MB quantized). Cross-encoders process (query, document) pairs jointly — more accurate than BM25 or bi-encoder cosine but slower since each pair is scored independently. Use `--no-rerank` to skip this step.

```bash
pai memory search "PAI memory search implementation" --mode hybrid
pai memory search "PAI memory search implementation" --mode hybrid --no-rerank
```

The reranker loads lazily on first use (downloads the model once, ~23 MB). Subsequent calls reuse the cached model. The MCP tool defaults to `rerank: true`; pass `rerank: false` to skip.

### Mode Comparison

| Mode | Speed | Requires Embeddings | Best For |
|------|-------|---------------------|----------|
| keyword | Fast | No | Exact terms, IDs, session numbers |
| semantic | Medium | Yes | Concepts, paraphrases, cross-language |
| hybrid | Medium | Yes | General-purpose, best quality |
| any (rerank default) | Slower | Model auto-downloads | All modes — best relevance ordering |

---

## CLI Reference

### Project Management

| Subcommand | Description |
|------------|-------------|
| `project add <path>` | Register a new project |
| `project list` | List all registered projects |
| `project info <slug>` | Show project details and metadata |
| `project archive <slug>` | Archive a project |
| `project unarchive <slug>` | Restore an archived project |
| `project move <slug> <path>` | Update a project's root path |
| `project tag <slug> <tag>` | Add a tag to a project |
| `project alias <slug> <alias>` | Add an alias for quick lookup |
| `project cd <slug>` | Print project path for shell navigation |
| `project detect` | Auto-detect project from CWD |
| `project health` | Audit all registered paths |
| `project consolidate <slug>` | Merge scattered Notes directories |
| `project promote` | Promote a session note into a project |

```bash
pai project list
pai project info my-app
cd $(pai project cd my-app)
pai project health
pai project promote --from-session ~/.pai/sessions/0012 --to ~/projects/new-project
```

### Session Management

| Subcommand | Description |
|------------|-------------|
| `session list` | List sessions, optionally by project |
| `session info <slug> <number>` | Show session details |
| `session rename <slug> <number> <name>` | Rename a session note |
| `session tag <slug> <number> <tag>` | Tag a session |
| `session route <slug> <number> <target>` | Cross-reference to another project |
| `session cleanup` | Auto-name, organize into YYYY/MM folders |

```bash
pai session list --project my-app
pai session cleanup
```

### Memory Engine

| Subcommand | Description |
|------------|-------------|
| `memory index` | Re-index files for keyword search |
| `memory embed` | Generate vector embeddings |
| `memory search <query>` | Search indexed content |
| `memory status` | Show index statistics |

```bash
pai memory search "chrome browser"
pai memory search --mode semantic "how does authentication work"
pai memory search --mode hybrid "indexer exclusion patterns"
pai memory status
```

### Daemon Management

| Subcommand | Description |
|------------|-------------|
| `daemon serve` | Start daemon in foreground |
| `daemon status` | Check daemon health |
| `daemon restart` | Restart the running daemon |
| `daemon install` | Install as launchd service |
| `daemon uninstall` | Remove launchd service |
| `daemon logs` | View daemon logs |
| `daemon migrate` | Migrate SQLite → PostgreSQL |

```bash
pai daemon status
pai daemon logs -f
pai daemon restart
```

Socket: `/tmp/pai.sock` · Log: `/tmp/pai-daemon.log`

### Registry Maintenance

| Subcommand | Description |
|------------|-------------|
| `registry scan` | Discover new projects |
| `registry migrate` | Apply schema migrations |
| `registry stats` | Show registry statistics |
| `registry rebuild` | Rebuild from scratch |
| `registry lookup <path>` | Resolve encoded path |

```bash
pai registry scan
pai registry stats
```

### Obsidian Vault

| Subcommand | Description |
|------------|-------------|
| `obsidian sync` | Sync notes into vault as symlinks |
| `obsidian status` | Show vault health |
| `obsidian open` | Launch Obsidian |

```bash
pai obsidian sync
pai obsidian status
```

### Zettelkasten

| Subcommand | Description |
|------------|-------------|
| `zettel explore <note>` | BFS traversal of wikilink graph from a seed note |
| `zettel surprise <note>` | Find semantically distant but graph-close notes |
| `zettel converse <query>` | Hybrid search with graph expansion and cross-domain connections |
| `zettel themes` | Cluster vault notes into thematic groups |
| `zettel health` | Audit vault for broken links, orphans, and isolated clusters |
| `zettel suggest <note>` | Suggest link targets weighted by semantics, tags, and graph neighborhood |

```bash
pai zettel explore "My Seed Note" --depth 3 --direction both
pai zettel surprise "My Seed Note" --limit 10
pai zettel converse "distributed systems tradeoffs"
pai zettel themes --min-cluster-size 3
pai zettel health
pai zettel suggest "My Seed Note" --limit 5
```

### Other Commands

```bash
pai backup                    # Backup registry, config, and Postgres
pai restore <path>            # Restore from backup (--no-postgres to skip DB)
pai setup                     # Interactive 7-step setup wizard
pai search "query"            # Quick full-text search shortcut
```

---

## Daemon

The PAI daemon is a persistent background service that handles indexing, embedding generation, and MCP request proxying.

### What It Does

- Listens on Unix socket `/tmp/pai.sock` using NDJSON protocol
- Proxies all MCP tool calls from the shim to PostgreSQL
- Re-indexes all active projects on a configurable interval (default: every 5 minutes)
- Generates text embeddings asynchronously using Snowflake Arctic Embed (768-dim)

### Configuration

```json
{
  "storageBackend": "postgres",
  "socketPath": "/tmp/pai.sock",
  "indexIntervalSecs": 300,
  "postgres": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "pai",
    "user": "pai",
    "password": "pai"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `storageBackend` | `"postgres"` | Storage engine: `"postgres"` or `"sqlite"` |
| `socketPath` | `"/tmp/pai.sock"` | Unix socket path for daemon IPC |
| `indexIntervalSecs` | `300` | Seconds between full re-index runs |

### Launchd Service

The daemon runs under the label `com.pai.pai-daemon`. The plist is installed to `~/Library/LaunchAgents/` by `pai daemon install`. launchd restarts the daemon automatically if it exits.

---

## Obsidian Bridge

PAI can expose your project memory as an Obsidian vault. The vault contains no actual files — only symlinks into each project's `Notes/` directory, so edits in Obsidian are immediately visible to PAI and vice versa.

### Vault Layout

```
~/.pai/obsidian-vault/
├── _index.md                    # Auto-generated landing page
├── topics/
│   ├── active-projects.md       # Links to all active project folders
│   └── recent-sessions.md       # Latest sessions across all projects
├── pai-knowledge-os -> ~/projects/PAI/Notes/
├── my-app -> ~/projects/my-app/Notes/
└── api-service -> ~/projects/api-service/Notes/
```

### Vault Health

`pai obsidian status` reports three categories:

| Status | Meaning |
|--------|---------|
| Healthy | Symlink exists and target directory is present |
| Broken | Symlink exists but target has moved or been deleted |
| Orphaned | Target directory exists but symlink is missing |

---

## Zettelkasten Intelligence

PAI implements six Luhmann-inspired operations on the vault's dual representation: a wikilink graph stored in `vault_links` and semantic embeddings stored alongside the vault file records. Together these two layers enable graph-based navigation, serendipitous discovery, and structural health analysis.

### Operations

| Operation | Module | Algorithm |
|-----------|--------|-----------|
| Explore | `src/zettelkasten/explore.ts` | BFS on vault_links, classifies sequential vs associative edges |
| Surprise | `src/zettelkasten/surprise.ts` | Cosine similarity × log2(graph_distance + 1) |
| Converse | `src/zettelkasten/converse.ts` | Hybrid search → graph expansion → cross-domain connections |
| Themes | `src/zettelkasten/themes.ts` | Agglomerative single-linkage clustering of embeddings |
| Health | `src/zettelkasten/health.ts` | SQL-driven audit with union-find for cluster detection |
| Suggest | `src/zettelkasten/suggest.ts` | Weighted: semantic (0.5) + tags (0.2) + graph neighborhood (0.3) |

### Design Notes

**Explore** performs a BFS walk from a seed note across `vault_links`. Each edge is classified as sequential (the linked note shares a common tag or is a direct sequence continuation) or associative (a lateral connection between different topics). The result is a subgraph that exposes the local neighborhood of a note.

**Surprise** finds notes that are semantically distant from a seed note in embedding space but close in graph distance — the "surprising bridge" pattern Luhmann valued. The score `cosine_similarity × log2(graph_distance + 1)` rewards notes that are conceptually different yet structurally nearby.

**Converse** treats the vault as a conversation partner. It runs a hybrid memory search, expands results via the graph to pull in neighboring notes, then identifies cross-domain connections — notes from unrelated topic clusters that share embedding proximity with the query.

**Themes** clusters vault embeddings using agglomerative single-linkage clustering. The output is a flat list of thematic groups with representative note titles. Useful for detecting topic drift, finding redundancy, or building a high-level map of the vault.

**Health** runs a SQL-driven structural audit: broken links, orphaned notes (no inbound or outbound links), notes with no embedding, and isolated clusters detected via union-find on the `vault_links` graph.

**Suggest** ranks candidate link targets for a given note using a weighted sum of three signals: semantic similarity of embeddings (weight 0.5), shared tags (weight 0.2), and presence in the graph neighborhood of already-linked notes (weight 0.3).

---

## Hook System

PAI ships a comprehensive set of lifecycle hooks that integrate with Claude Code's hook events. Hooks are TypeScript source files (`src/hooks/ts/`) compiled to `.mjs` modules and deployed to `~/.claude/Hooks/`.

### Hook Architecture

```
Claude Code Event
    │
    ├── stdin: JSON { session_id, transcript_path, cwd, hook_event_name }
    │
    ├── Hook Process (.mjs)
    │       ├── Reads stdin for context
    │       ├── Performs side effects (file writes, notifications)
    │       └── Writes stdout (injected as <system-reminder> into conversation)
    │
    └── stderr: diagnostic logs (visible in Claude Code's hook output)
```

**Key constraint:** Not all hook events support stdout injection. `SessionStart` does. `PreCompact` does not. This matters for context preservation.

### Hook Inventory

| Hook | Event | Purpose |
|------|-------|---------|
| `load-core-context.mjs` | SessionStart | Loads PAI skill system and core configuration |
| `load-project-context.mjs` | SessionStart | Detects project, loads notes dir, TODO, session note |
| `initialize-session.mjs` | SessionStart | Creates numbered session note, registers in PAI registry |
| `post-compact-inject.mjs` | SessionStart (compact) | Reads saved state and injects into post-compaction context |
| `security-validator.mjs` | PreToolUse (Bash) | Validates shell commands against security rules |
| `capture-all-events.mjs` | All events | Observability — logs every hook event to session timeline |
| `context-compression-hook.mjs` | PreCompact | Extracts session state, saves checkpoint, writes temp file for relay |
| `capture-tool-output.mjs` | PostToolUse | Records tool inputs/outputs for observability dashboard |
| `update-tab-on-action.mjs` | PostToolUse | Updates terminal tab title based on current activity |
| `sync-todo-to-md.mjs` | PostToolUse (TodoWrite) | Syncs Claude's internal TODO list to `Notes/TODO.md` |
| `cleanup-session-files.mjs` | UserPromptSubmit | Cleans up stale temp files between prompts |
| `update-tab-titles.mjs` | UserPromptSubmit | Sets terminal tab title from session context |
| `stop-hook.mjs` | Stop | Writes work items to session note, sends notification |
| `capture-session-summary.mjs` | SessionEnd | Final session summary written to session note |
| `subagent-stop-hook.mjs` | SubagentStop | Captures sub-agent completion for observability |

### Context Preservation Relay

The most critical hook interaction is the PreCompact → SessionStart relay that preserves context across compaction:

```
PreCompact fires (context-compression-hook.mjs)
    │
    ├── Reads transcript JSONL from stdin { transcript_path }
    ├── Extracts: recent user messages, work summaries, files modified, captures
    ├── Writes checkpoint to session note (persistent)
    ├── Writes injection payload to /tmp/pai-compact-state-{session_id}.txt
    └── Sends notification (WhatsApp or ntfy.sh)

    ⬇ Claude Code runs compaction (conversation is summarized)

SessionStart(compact) fires (post-compact-inject.mjs)
    │
    ├── Reads /tmp/pai-compact-state-{session_id}.txt
    ├── Outputs content to stdout → injected into post-compaction context
    └── Deletes temp file (one-shot relay)
```

**Why the relay?** PreCompact hooks cannot inject into the conversation (stdout is ignored by Claude Code for this event). SessionStart hooks can. The temp file bridges the gap.

### Building Hooks

```bash
bun run build              # Builds everything including hooks
node scripts/build-hooks.mjs   # Build hooks only
```

The build script compiles each `.ts` hook to a self-contained `.mjs` module using `tsx` bundling, then copies them to the configured hooks directory (`~/.claude/Hooks/` by default).

### Adding a New Hook

1. Create the TypeScript source in the appropriate `src/hooks/ts/<event>/` directory
2. Read stdin for `HookInput` JSON (session_id, transcript_path, cwd, hook_event_name)
3. Use stderr for diagnostics, stdout only if the event supports injection
4. Register the hook in `~/.claude/settings.json` under the appropriate event with the correct matcher
5. Run `bun run build` to compile and deploy

---

## Templates

PAI ships three templates used during setup and customizable for your workflow.

### `templates/claude-md.template.md`

A publishable CLAUDE.md template containing generic agent orchestration patterns: swarm mode, parallel execution, model selection matrix (haiku/sonnet/opus), mandatory spotchecks, and directory restrictions.

`pai setup` generates your `~/.claude/CLAUDE.md` from this template, substituting `${HOME}` with your home directory.

### `templates/agent-prefs.example.md`

Personal preferences template covering identity, project mappings, notifications, voice, and git rules. Copy to `~/.config/pai/agent-prefs.md` and customize.

### `templates/voices.example.json`

Voice configuration for TTS integration. Supports Kokoro (local, no API key) and ElevenLabs:

```json
{
  "backend": "kokoro",
  "default_voice": "af_heart",
  "agents": {
    "main": "af_heart",
    "researcher": "bm_george"
  }
}
```

Copy to `~/.config/pai/voices.json` and configure your preferred backend.

---

## Database Schema

### Registry (`~/.pai/registry.db` — SQLite)

| Table | Key Columns |
|-------|-------------|
| `projects` | id, slug, root_path, claude_notes_dir, status, tags, aliases, created_at |
| `sessions` | id, project_id, number, date, slug, file_path, tags |
| `links` | source_session_id, target_project_id, link_type |

### Federation (`pai` PostgreSQL + pgvector)

**`pai_chunks`** — Indexed content chunks with embeddings:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | SHA-256 chunk identifier |
| `project_id` | INTEGER | Owning project |
| `source` | TEXT | `memory`, `notes`, or `content` |
| `tier` | TEXT | `evergreen`, `topic`, or `session` |
| `path` | TEXT | Relative path within project |
| `start_line` / `end_line` | INTEGER | Line range in source file |
| `hash` | TEXT | SHA-256 of chunk text |
| `text` | TEXT | Raw chunk content |
| `embedding` | vector(768) | Snowflake Arctic embedding (nullable) |
| `updated_at` | BIGINT | Last index timestamp |

**`pai_files`** — File metadata for change detection:

| Column | Type | Description |
|--------|------|-------------|
| `project_id` | INTEGER | Owning project |
| `path` | TEXT | Relative path |
| `hash` | TEXT | SHA-256 of full file |
| `mtime` | BIGINT | Modification time |
| `size` | BIGINT | File size in bytes |

**Indexes:** HNSW on embedding (cosine), GIN on text (tsvector), B-tree on project_id/path.

### Vault Tables (v3 — PostgreSQL)

These tables are populated by `src/memory/vault-indexer.ts` and queried by all six zettelkasten operations.

**`vault_files`** — One row per Obsidian note:

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL | Surrogate key |
| `vault_path` | TEXT | Path relative to vault root |
| `title` | TEXT | Note title (H1 or filename) |
| `tags` | TEXT[] | Frontmatter tags |
| `embedding` | vector(768) | Snowflake Arctic embedding |
| `mtime` | BIGINT | Modification time |
| `hash` | TEXT | SHA-256 of file content |

**`vault_aliases`** — Obsidian alias metadata:

| Column | Type | Description |
|--------|------|-------------|
| `file_id` | INTEGER | FK → vault_files.id |
| `alias` | TEXT | Alias string from frontmatter |

**`vault_links`** — Directed wikilink edges:

| Column | Type | Description |
|--------|------|-------------|
| `source_id` | INTEGER | FK → vault_files.id (linking note) |
| `target_id` | INTEGER | FK → vault_files.id (linked note) |
| `link_text` | TEXT | Display text of the link |
| `link_type` | TEXT | `sequential` or `associative` |

**`vault_name_index`** — Reverse lookup for wikilink resolution:

| Column | Type | Description |
|--------|------|-------------|
| `name` | TEXT | Lowercased title or alias |
| `file_id` | INTEGER | FK → vault_files.id |

**`vault_health`** — Cached audit results from the Health operation:

| Column | Type | Description |
|--------|------|-------------|
| `file_id` | INTEGER | FK → vault_files.id |
| `issue_type` | TEXT | `broken_link`, `orphan`, `no_embedding`, `isolated_cluster` |
| `detail` | TEXT | Human-readable description |
| `checked_at` | BIGINT | Timestamp of the audit run |

**Content Tiers:**

| Tier | Description | Example |
|------|-------------|---------|
| `evergreen` | Permanent, high-signal memory | `MEMORY.md` |
| `topic` | Structured content files | Documentation, topic pages |
| `session` | Session notes | `Notes/0087 - 2026-02-20 - Obsidian Bridge.md` |

---

## Backup and Restore

### Creating a Backup

```bash
pai backup
```

Creates a timestamped directory under `~/.pai/backups/` containing: `registry.db`, `config.json`, `federation.db` (if SQLite fallback active), and a `pg_dump` of the PostgreSQL database.

### Restoring

```bash
pai restore ~/.pai/backups/2026-02-25T14-30-00
pai restore ~/.pai/backups/2026-02-25T14-30-00 --no-postgres
```

The `--no-postgres` flag skips PostgreSQL restore — useful when restoring to a fresh instance you intend to re-index.

---

## Development

### Build

```bash
bun install
bun run build    # Uses tsdown (NOT tsup)
bun run dev      # Watch mode
bun run test     # vitest
bun run lint     # tsc --noEmit
```

### Build Outputs

| Output | Purpose |
|--------|---------|
| `dist/cli/index.mjs` | `pai` CLI |
| `dist/mcp/index.mjs` | Direct MCP server (legacy) |
| `dist/daemon/index.mjs` | Daemon server |
| `dist/daemon-mcp/index.mjs` | MCP shim (stdio → daemon socket) |

### Source Structure

```
src/
├── cli/commands/    # CLI command implementations
│   └── zettel.ts    # `pai zettel` with 6 subcommands
├── daemon/          # Daemon server and index scheduler
├── daemon-mcp/      # MCP shim (stdio → daemon socket)
├── federation/      # Federation schema definitions
├── hooks/           # Lifecycle hooks (pre-compact, session-stop)
├── mcp/             # Direct MCP server (legacy)
├── memory/          # Indexer, chunker, embeddings, search, reranker
│   ├── reranker.ts  # Cross-encoder reranking (Xenova/ms-marco-MiniLM-L-6-v2)
│   └── vault-indexer.ts  # Obsidian vault indexing into v3 vault tables
├── obsidian/        # Obsidian vault bridge
│   └── vault-fixer.ts    # Repairs broken wikilinks and orphaned entries
├── registry/        # Registry migrations and queries
├── session/         # Session slug generator
├── storage/         # Storage backend interface (SQLite/Postgres)
└── zettelkasten/    # Luhmann-inspired graph + semantic operations
    ├── explore.ts   # BFS traversal classifying sequential/associative edges
    ├── surprise.ts  # Serendipitous bridge discovery via cosine × graph distance
    ├── converse.ts  # Hybrid search → graph expansion → cross-domain connections
    ├── themes.ts    # Agglomerative embedding clustering for thematic groups
    ├── health.ts    # SQL-driven vault audit with union-find cluster detection
    ├── suggest.ts   # Weighted link suggestions (semantic + tags + graph)
    └── index.ts     # Barrel export for all zettelkasten operations
```

### Important Notes

- **better-sqlite3 is not supported in Bun.** Migration scripts use `npx tsx` to run under Node.js.
- **Do not substitute tsup for tsdown.** The build configuration depends on tsdown-specific behavior.
- The daemon and MCP shim communicate exclusively over the Unix socket. The shim holds no state.
- Embedding generation is always asynchronous. Text indexing is immediate; embeddings are processed in the background.

---

## License

MIT
