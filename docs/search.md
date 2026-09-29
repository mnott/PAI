# Search

## Token-Efficient Search (3-Layer Pattern)

For budget-conscious usage, PAI supports a compact search format that returns ~10x fewer tokens per result. Instead of fetching full snippets upfront, get a compact index first, then drill into interesting results.

### The workflow

```
1. Search with format="compact"  →  IDs + paths + scores (~50 tokens/result)
2. Review the index, pick interesting results
3. Use memory_get to read full content for those specific files
```

### Example

```
"Search for authentication with compact format"
  → Claude passes format: "compact" to memory_search
  → Gets a tight index: [1] pai — src/auth.ts L10-45 score=0.892
  → Then reads only the files that matter
```

Via MCP, pass `format: "compact"` to the `memory_search` tool. Default is `"full"` (current behavior with snippets).

### Section-aware retrieval

Long notes are chunked at their headings, and every chunk carries its heading path as a first line, for example `[Decisions > Worker routing > Provider choice]`. A search for "routing" therefore finds the paragraph under that sub-section even when the paragraph never uses the word. Headings inside code fences are ignored.

For long files, read by section instead of whole:

```
1. memory_outline(project, path)  →  heading tree with line ranges and token estimates
      ## Previous handovers  L45-195 ~2361t
        ### Shipped (2026-09-29)  L60-66 ~251t
2. memory_get(project, path, from=60, lines=7)  →  just that section
```

`memory_outline` returns structure only, never text, and takes an optional `max_depth`.

When the chunking logic changes, `CHUNKER_VERSION` in `src/memory/chunker.ts` is bumped. It is part of each file's change-detection hash, so the first index pass after an upgrade re-chunks and re-embeds every file once; later passes skip unchanged files as before. On a large index that pass takes hours of local CPU for embeddings, and semantic search misses files until they are re-embedded, so restart the daemon onto a new version at a quiet time.

## Search Intelligence

PAI doesn't just store your notes — it understands them. Three search modes work together, with reranking and recency boost on by default. All search settings are configurable.

### Search Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Keyword** | Full-text search (BM25 via SQLite FTS5) | Exact terms, function names, error messages |
| **Semantic** | Vector similarity (Snowflake Arctic embeddings) | Finding things by meaning, even with different words |
| **Hybrid** | Keyword + semantic combined, scores normalized and blended | General use — the default |

### Cross-Encoder Reranking

Every search automatically runs a second pass: a cross-encoder model reads each (query, result) pair together and re-scores them for relevance. This catches results that keyword or vector search ranked too low.

```bash
# Search with reranking (default)
pai memory search "how does session routing work"

# Skip reranking for faster results
pai memory search "how does session routing work" --no-rerank
```

The reranker uses a small local model (~23 MB) that runs entirely on your machine. First use downloads it automatically. No API keys, no cloud calls.

### Recency Boost

Recent content scores higher than older content — on by default with a 90-day half-life. A 3-month-old result retains 50% of its score, a 6-month-old retains 25%, and a year-old retains ~6%.

```bash
# Search uses recency boost automatically (90-day half-life from config)
pai memory search "notification system"

# Override the half-life for this search
pai memory search "notification system" --recency 30

# Disable recency boost for this search
pai memory search "notification system" --recency 0
```

Via MCP, pass `recency_boost: 90` to the `memory_search` tool, or `recency_boost: 0` to disable.

Recency boost is applied after cross-encoder reranking, so relevance is scored first, then time-weighted. Scores are normalized before decay so the math works correctly regardless of the underlying score scale.

### Search Settings

All search defaults are configurable via `~/.claude/pai/config.json` and can be viewed or changed from the command line.

```bash
# View all search settings
pai memory settings

# View a single setting
pai memory settings recencyBoostDays

# Change a setting
pai memory settings recencyBoostDays 60
pai memory settings mode hybrid
pai memory settings rerank false
```

| Setting | Default | Description |
|---------|---------|-------------|
| `mode` | `keyword` | Default search mode: `keyword`, `semantic`, or `hybrid` |
| `rerank` | `true` | Cross-encoder reranking on by default |
| `recencyBoostDays` | `90` | Recency half-life in days. `0` = off |
| `defaultLimit` | `10` | Default number of results |
| `snippetLength` | `200` | Max characters per snippet in MCP results |

Settings live in the `search` section of `~/.claude/pai/config.json`. Per-call parameters (CLI flags or MCP tool arguments) always override config defaults.

### Using Search from Within Claude

When PAI is configured as an MCP server, Claude uses the `memory_search` tool automatically. You don't need to call it yourself — just ask Claude naturally and it searches your memory behind the scenes.

**Example prompts you can give Claude:**

```
"Search your memory for authentication"
"What do you know about the database migration?"
"Find where we discussed the notification system"
```

Claude calls `memory_search` with the right parameters based on your config defaults. Reranking and recency boost are both active by default — you don't need to configure anything for good results.

**Overriding defaults for a specific search:**

You can ask Claude to adjust search behavior per-query:

```
"Search for authentication using semantic mode"
  → Claude passes mode: "semantic"

"Search for the old logging discussion without recency boost"
  → Claude passes recency_boost: 0

"Search for database schema across all projects with no reranking"
  → Claude passes all_projects: true, rerank: false
```

**The `memory_search` MCP tool accepts these parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Free-text search query (required) |
| `project` | string | Scope to one project by slug |
| `all_projects` | boolean | Explicitly search all projects |
| `sources` | array | Restrict to `"memory"` or `"notes"` |
| `limit` | integer | Max results (1–100, default from config) |
| `mode` | string | `"keyword"`, `"semantic"`, or `"hybrid"` |
| `rerank` | boolean | Cross-encoder reranking (default: true from config) |
| `recency_boost` | integer | Recency half-life in days (0 = off, default from config) |

All parameters except `query` are optional. Omitted values fall back to your `~/.claude/pai/config.json` defaults.

**Changing defaults permanently:**

Tell Claude to change your search settings:

```
"Set my default search mode to hybrid"
"Turn off reranking by default"
"Change the recency boost to 60 days"
```

Claude runs `pai memory settings <key> <value>` to update `~/.claude/pai/config.json`. Changes take effect on the next search — no restart needed.
