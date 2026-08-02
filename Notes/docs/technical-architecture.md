# PAI Knowledge OS - Technical Architecture

[Back to Index](index.md)

---

## System Architecture

```
+----------------------------------------------------------+
|                   Claude Code Session                     |
|                                                          |
|  +------------------+  +-------------+  +-------------+  |
|  | 26 Lifecycle     |  | 18 Skills   |  | Statusline  |  |
|  | Hooks (.mjs)     |  | (SKILL.md)  |  | + Tab UI    |  |
|  +--------+---------+  +------+------+  +------+------+  |
|           |                   |                 |         |
+----------------------------------------------------------+
            |                   |
            |    +--------------+
            |    |
   +--------v----v-----------+
   |   MCP Shim (stdio)      |
   |   dist/daemon-mcp/      |
   |   index.mjs             |
   +--------+----------------+
            |
            | NDJSON over Unix socket
            | /tmp/pai.sock
            |
   +--------v----------------+
   |   PAI Daemon             |
   |   com.pai.pai-daemon     |
   |                          |
   |   +------------------+   |
   |   | Scheduler        |   |
   |   | Index every 5min |   |
   |   +------------------+   |
   |                          |
   |   +------------------+   |
   |   | Embeddings       |   |
   |   | Snowflake Arctic |   |
   |   | 768-dim async    |   |
   |   +------------------+   |
   |                          |
   |   +------------------+   |
   |   | Observation      |   |
   |   | Store            |   |
   |   | classify->store  |   |
   |   +------------------+   |
   |                          |
   |   +------------------+   |
   |   | Vault Indexer    |   |
   |   | Zettelkasten     |   |
   |   +------------------+   |
   +--------+----------------+
            |
   +--------v----------------+      +--------------------+
   |  PostgreSQL + pgvector   |      | SQLite Registry    |
   |  (full mode)             |      | ~/.pai/registry.db |
   |                          |      |                    |
   |  pai_chunks (text+vec)   |      | projects           |
   |  pai_files  (metadata)   |      | sessions           |
   |  pai_observations        |      | links              |
   |  pai_session_summaries   |      +--------------------+
   |  vault_files             |
   |  vault_links             |
   |  vault_aliases           |
   |  vault_name_index        |
   |  vault_health            |
   +-------------------------+
```

---

## Daemon Architecture

The PAI daemon (`com.pai.pai-daemon`) is a persistent launchd service that owns the entire data lifecycle.

### Responsibilities

- **Socket server** - Listens on `/tmp/pai.sock`, speaks NDJSON
- **Request dispatch** - Routes MCP tool calls to the correct handler
- **Index scheduler** - Re-indexes all active projects every 5 minutes (configurable)
- **Embedding generation** - Asynchronous Snowflake Arctic embeddings at reduced CPU priority
- **Vault indexing** - Obsidian vault graph maintenance (when configured)
- **Observation queries** - Serves observation data for progressive injection

### Process Model

```
launchd (com.pai.pai-daemon)
    |
    +-- Node.js process (dist/daemon/index.mjs)
        |
        +-- Socket server (net.createServer)
        |       Accepts NDJSON connections
        |       One connection per Claude Code session
        |
        +-- Scheduler (setInterval)
        |       indexIntervalSecs: 300 (default)
        |       Runs: file scan -> chunk -> hash -> store -> embed
        |
        +-- Dispatcher
                Routes tool calls to handlers:
                memory_search -> search.ts
                project_info  -> projects.ts
                zettel_*      -> zettelkasten/*.ts
                observation_* -> observations.ts
```

### Configuration

File: `~/.config/pai/config.json`

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
  },
  "search": {
    "mode": "keyword",
    "rerank": true,
    "recencyBoostDays": 90,
    "defaultLimit": 10,
    "snippetLength": 200
  }
}
```

---

## MCP Shim

The MCP shim (`dist/daemon-mcp/index.mjs`) is a thin stateless proxy:

```
Claude Code <--stdio--> MCP Shim <--NDJSON/socket--> Daemon
```

- Speaks stdio (what Claude Code expects)
- Proxies each request to the daemon over the Unix socket
- Holds no state - all intelligence lives in the daemon
- Multiple Claude Code sessions can share one daemon without contention

### MCP Surface Area

| Category | Count | Details |
|----------|-------|---------|
| **Tools** | 9 | memory_search, memory_get, project_info, project_list, session_list, registry_search, project_detect, project_health, project_todo |
| **Prompts/Skills** | 18 | art, createskill, journal, name, observability, plan, research, review, route, search-history, sessions, share, story-explanation, vault-connect, vault-context, vault-emerge, vault-orphans, vault-trace |
| **Resources** | 11 | pai://aesthetic, pai://constitution, pai://history-system, pai://hook-system, pai://mcp-dev-guide, pai://prompting, pai://prosody-agent-template, pai://prosody-guide, pai://skill-system, pai://terminal-tabs, pai://voice |

---

## Storage Backends

### Pluggable Architecture

Both backends implement `StorageInterface` (`src/storage/interface.ts`). The factory (`src/storage/factory.ts`) instantiates the correct backend at runtime based on config. All higher-level code (indexer, search, MCP tools) is backend-agnostic.

### SQLite (Simple Mode)

- Zero dependencies beyond Bun
- Registry always uses SQLite (`better-sqlite3`)
- Keyword search via FTS5 (BM25 ranking)
- No semantic search, no embeddings
- Location: `~/.pai/registry.db`

### PostgreSQL + pgvector (Full Mode)

- Requires Docker (`pgvector/pgvector:pg17`)
- HNSW vector indexes for semantic search (cosine distance, 768-dim)
- GIN indexes for full-text search (tsvector)
- B-tree indexes on project_id, path, timestamps
- Content-hash deduplication with 30-second window
- Location: `pai` database on localhost:5432

---

## Embedding Pipeline

### Model

- **Snowflake Arctic Embed** - 768-dimensional embeddings
- Runs locally via `@huggingface/transformers`
- No API keys, no cloud calls
- Auto-downloads on first use (~100MB)

### Pipeline

```
File detected (new/changed)
    |
    +-- Chunker splits into ~500-token chunks
    |       Respects paragraph/heading boundaries
    |       Overlap: configurable (default 50 tokens)
    |
    +-- Hash: SHA-256 per chunk for change detection
    |
    +-- Store: text + metadata -> pai_chunks
    |       (keyword search available immediately)
    |
    +-- Queue: chunks without embeddings -> embedding queue
    |
    +-- Async embed: Snowflake Arctic at reduced CPU priority
    |       setPriority(pid, 10)
    |       (semantic search available after embedding)
```

---

## Search Architecture

### Multi-Mode Search

```
Query
  |
  +-- Mode selection (keyword / semantic / hybrid)
  |
  +-- Keyword path: PostgreSQL ts_rank (GIN index)
  |       OR operators for recall, ts_rank for precision
  |
  +-- Semantic path: pgvector cosine distance (HNSW index)
  |       Query embedded with same Snowflake Arctic model
  |
  +-- Hybrid: run both, normalize to [0,1], blend scores
  |
  +-- Cross-encoder reranking (default: on)
  |       Model: Xenova/ms-marco-MiniLM-L-6-v2
  |       Size: 23MB quantized ONNX
  |       Scores each (query, result) pair jointly
  |
  +-- Recency boost (default: 90-day half-life)
  |       score * exp(-ln2/halfLife * ageDays)
  |       Applied after reranking, after normalization
  |
  +-- Return ranked results with file paths and line numbers
```

### Cross-Encoder Reranker

- **Model**: `Xenova/ms-marco-MiniLM-L-6-v2` - 22.7M parameters, 23MB q8 quantized ONNX
- **Module**: `src/memory/reranker.ts` - lazy singleton, same pattern as embeddings
- **API**: `rerankResults(query, results, opts?)` - reads (query, snippet) pairs, re-sorts by relevance
- **Why**: Cross-encoders process pairs jointly (more accurate than bi-encoder cosine) but slower since each pair is scored independently

### Recency Boost

- **Function**: `applyRecencyBoost(results, halfLifeDays)` in `src/memory/search.ts`
- **Math**: Min-max normalize to [0,1], then `normalized * exp(-ln2/halfLife * ageDays)`
- **Why normalize first**: Cross-encoder outputs negative logits - naive multiplication would invert the decay
- **Pipeline position**: After reranking, before slug population

---

## Hook System

### Architecture

```
Claude Code Event
    |
    +-- stdin: JSON { session_id, transcript_path, cwd, hook_event_name }
    |
    +-- Hook Process (.mjs)
    |       Reads stdin for context
    |       Performs side effects (file writes, notifications)
    |       Writes stdout (injected as <system-reminder>)
    |
    +-- stderr: diagnostic logs
```

**Key constraint**: Not all events support stdout injection. SessionStart does. PreCompact does not. This drives the two-stage relay design.

### Hook Inventory (26 registrations)

**SessionStart (5 hooks):**
- `load-core-context.mjs` - Loads PAI skill system and core configuration
- `load-project-context.mjs` - Detects project, loads notes dir, TODO, session note
- `initialize-session.mjs` - Creates numbered session note, registers in registry
- `post-compact-inject.mjs` - Reads saved state, injects into post-compaction context (matcher: compact)
- `inject-observations.mjs` - Injects recent observation context (compact index + timeline)

**PreToolUse (1 hook):**
- `security-validator.mjs` - Validates shell commands against security rules (matcher: Bash)

**PostToolUse (4 hooks):**
- `observe.mjs` - Classifies tool calls into typed observations
- `capture-tool-output.mjs` - Records tool inputs/outputs for observability
- `update-tab-on-action.mjs` - Updates terminal tab title
- `sync-todo-to-md.mjs` - Syncs TODO list to Notes/TODO.md (matcher: TodoWrite)

**UserPromptSubmit (2 hooks):**
- `cleanup-session-files.mjs` - Cleans up stale temp files
- `update-tab-titles.mjs` - Sets terminal tab title from session context

**PreCompact (2 hooks):**
- `context-compression-hook.mjs` - Extracts session state, saves checkpoint
- `pai-pre-compact.sh` - Shell notification hook

**Stop/SessionEnd (3 hooks):**
- `stop-hook.mjs` - Writes work items to session note, sends notification
- `capture-session-summary.mjs` - Final session summary
- `subagent-stop-hook.mjs` - Captures sub-agent completion

**All events (7 registrations from 1 hook):**
- `capture-all-events.mjs` - Observability logger for every hook event

### Context Preservation Relay

The most critical hook interaction:

```
PreCompact fires (context-compression-hook.mjs)
    |
    +-- Reads transcript JSONL from stdin
    +-- Extracts: recent messages, work summaries, files modified
    +-- Writes checkpoint to session note (persistent)
    +-- Writes injection payload to /tmp/pai-compact-state-{session_id}.txt
    +-- Sends notification
    |
    v  Claude Code runs compaction
    |
SessionStart(compact) fires (post-compact-inject.mjs)
    |
    +-- Reads /tmp/pai-compact-state-{session_id}.txt
    +-- Outputs content to stdout -> injected into context
    +-- Deletes temp file (one-shot relay)
```

---

## Skill System

### Discovery Flow

```
Source: src/daemon-mcp/prompts/*.ts
    |
    +-- Build: node scripts/build-skill-stubs.mjs --sync
    |       Extracts content, generates SKILL.md with YAML frontmatter
    |
    +-- Output: dist/skills/<TitleCase>/SKILL.md
    |
    +-- Symlink: ~/.claude/skills/<Name> -> dist/skills/<Name>
    |
    +-- Claude Code scans ~/.claude/skills/ at session start
    |       Loads descriptions, auto-invokes matching skills
```

Skills are loaded on-demand to conserve context. Each provides a focused workflow with instructions, examples, and constraints.

### Extension Points

Three locations for custom content, all gitignored:

1. `user-extensions/skills/MySkill/SKILL.md` - Custom skills
2. `user-extensions/hooks/my-hook.ts` - Custom hooks
3. `src/daemon-mcp/prompts/custom/my-prompt.ts` - Custom MCP prompts

---

## Database Schema

### Registry (SQLite)

```sql
-- Projects
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    slug        TEXT UNIQUE NOT NULL,
    root_path   TEXT NOT NULL,
    claude_notes_dir TEXT,
    status      TEXT DEFAULT 'active',  -- active, archived
    tags        TEXT,  -- JSON array
    aliases     TEXT,  -- JSON array
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Sessions
CREATE TABLE sessions (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER REFERENCES projects(id),
    number      INTEGER NOT NULL,
    date        TEXT,
    slug        TEXT,
    file_path   TEXT,
    tags        TEXT  -- JSON array
);

-- Cross-project links
CREATE TABLE links (
    source_session_id INTEGER REFERENCES sessions(id),
    target_project_id INTEGER REFERENCES projects(id),
    link_type         TEXT
);
```

### Federation (PostgreSQL + pgvector)

```sql
-- Indexed content chunks
CREATE TABLE pai_chunks (
    id          TEXT PRIMARY KEY,  -- SHA-256 chunk ID
    project_id  INTEGER NOT NULL,
    source      TEXT,    -- 'memory', 'notes', 'content'
    tier        TEXT,    -- 'evergreen', 'topic', 'session'
    path        TEXT,
    start_line  INTEGER,
    end_line    INTEGER,
    hash        TEXT,    -- SHA-256 of chunk text
    text        TEXT,
    embedding   vector(768),  -- Snowflake Arctic
    updated_at  BIGINT
);

-- HNSW index for vector search
CREATE INDEX ON pai_chunks USING hnsw (embedding vector_cosine_ops);

-- GIN index for full-text search
CREATE INDEX ON pai_chunks USING gin (to_tsvector('english', text));

-- Observations (auto-captured tool calls)
CREATE TABLE pai_observations (
    id                  SERIAL PRIMARY KEY,
    session_id          TEXT,
    project_id          INTEGER,
    project_slug        TEXT,
    type                TEXT,  -- decision, bugfix, feature, refactor, discovery, change
    title               TEXT,
    narrative           TEXT,
    tool_name           TEXT,
    tool_input_summary  TEXT,
    files_read          JSONB,
    files_modified      JSONB,
    concepts            JSONB,
    content_hash        TEXT,  -- 30-second dedup window
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Session summaries
CREATE TABLE pai_session_summaries (
    id                SERIAL PRIMARY KEY,
    session_id        TEXT UNIQUE,
    project_id        INTEGER,
    project_slug      TEXT,
    request           TEXT,
    investigated      TEXT,
    learned           TEXT,
    completed         TEXT,
    next_steps        TEXT,
    observation_count INTEGER,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

### Vault Tables (Zettelkasten)

```sql
CREATE TABLE vault_files (
    id         SERIAL PRIMARY KEY,
    vault_path TEXT UNIQUE,
    title      TEXT,
    tags       TEXT[],
    embedding  vector(768),
    mtime      BIGINT,
    hash       TEXT
);

CREATE TABLE vault_links (
    source_id  INTEGER REFERENCES vault_files(id),
    target_id  INTEGER REFERENCES vault_files(id),
    link_text  TEXT,
    link_type  TEXT  -- 'sequential' or 'associative'
);

CREATE TABLE vault_aliases (
    file_id INTEGER REFERENCES vault_files(id),
    alias   TEXT
);

CREATE TABLE vault_name_index (
    name    TEXT,
    file_id INTEGER REFERENCES vault_files(id)
);

CREATE TABLE vault_health (
    file_id    INTEGER REFERENCES vault_files(id),
    issue_type TEXT,  -- broken_link, orphan, no_embedding, isolated_cluster
    detail     TEXT,
    checked_at BIGINT
);
```

---

## Content Tiers

| Tier | Description | Example | Indexing Priority |
|------|-------------|---------|-------------------|
| `evergreen` | Permanent, high-signal memory | `MEMORY.md` | Highest |
| `topic` | Structured content files | Documentation, topic pages | Medium |
| `session` | Session notes | `Notes/0087 - 2026-02-20 - Obsidian Bridge.md` | Standard |

---

## Source Structure

```
src/
+-- cli/
|   +-- commands/           # CLI command modules (backup, daemon, memory, etc.)
|   +-- index.ts            # CLI entry point
+-- daemon/
|   +-- daemon/             # Server internals (dispatcher, handler, server)
|   +-- indexer/            # Background index scheduler
|   +-- config.ts           # Runtime configuration
|   +-- index.ts            # Daemon entry point
+-- daemon-mcp/
|   +-- instructions.ts     # MCP routing table (~1.5KB)
|   +-- prompts/            # 18 skill prompts + custom/
|   +-- resources/          # 11 reference resources (pai:// URIs)
|   +-- index.ts            # MCP shim entry point
+-- hooks/
|   +-- ts/                 # TypeScript hooks by event
|       +-- PreCompact/
|       +-- PreToolUse/
|       +-- PostToolUse/
|       +-- SessionStart/
|       +-- Stop/
|       +-- UserPromptSubmit/
+-- mcp/
|   +-- tools/              # Shared tool implementations
+-- memory/
|   +-- chunker/            # Text chunking strategies
|   +-- embeddings.ts       # Snowflake Arctic generation
|   +-- indexer.ts           # File indexer with change detection
|   +-- reranker.ts         # Cross-encoder reranking
|   +-- search.ts           # Multi-mode search engine
|   +-- vault-indexer.ts    # Obsidian vault indexing
+-- observations/           # Auto-capture system
|   +-- classifier.ts       # Rule-based tool call classifier
|   +-- store.ts            # PostgreSQL persistence
+-- storage/                # Pluggable backend
|   +-- factory.ts          # Backend selection
|   +-- interface.ts        # StorageInterface contract
|   +-- postgres.ts         # PostgreSQL + pgvector
|   +-- sqlite.ts           # SQLite backend
+-- zettelkasten/           # 6 Luhmann operations
    +-- explore.ts, surprise.ts, converse.ts,
        themes.ts, health.ts, suggest.ts
```

---

## Build System

```bash
bun run build
# Equivalent to:
#   tsdown (compile TypeScript to dist/)
#   node scripts/build-hooks.mjs --sync (compile hooks, symlink)
#   node scripts/build-skill-stubs.mjs --sync (generate skills, symlink)
```

| Output | Purpose |
|--------|---------|
| `dist/cli/index.mjs` | `pai` CLI |
| `dist/daemon/index.mjs` | Daemon server |
| `dist/daemon-mcp/index.mjs` | MCP shim |
| `dist/hooks/*.mjs` | Compiled lifecycle hooks |
| `dist/skills/<Name>/SKILL.md` | Generated skill stubs |

**Important build notes:**
- Uses `tsdown` (NOT tsup) - configuration depends on tsdown-specific behavior
- `better-sqlite3` is not supported in Bun - migration scripts use `npx tsx` under Node.js
- Daemon and MCP shim communicate exclusively over the Unix socket
- Embedding generation is always asynchronous
