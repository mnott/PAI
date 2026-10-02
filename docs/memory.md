# Memory

## Progressive Memory Loading

PAI loads context in layers at session start rather than all at once. This keeps early-session latency low while giving Claude everything it needs to be useful immediately.

### The Four Layers

| Layer | What it loads | When |
|-------|---------------|------|
| **L0 — Identity** | Your identity file (`~/.pai/identity.txt`) — who you are, your working style, key preferences | Always, at every session start |
| **L1 — Essential story** | Summaries from the most recent session notes — what you were doing, what decisions were made, where things stand | Always, at session start |
| **L2 — Topic queries** | On-demand retrieval for the current topic — fetched when a specific question or task is identified | On demand, during the session |
| **L3 — Deep search** | Full `memory_search` across all indexed content — for when L2 is not enough | On demand, when explicitly needed |

L0 and L1 fire automatically via the `memory_wakeup` MCP tool, which is called by the `SessionStart` hook. L2 and L3 are invoked as needed — the model decides when to go deeper based on the question at hand.

### Configuring Your Identity File

Create `~/.pai/identity.txt` with a short description of yourself and your working style. Claude will see this at every session start. Example:

```
Principal engineer. Work across TypeScript, Dart, and shell scripting.
Projects: PAI (AI infrastructure), RingsADay (Flutter app), Scribe (MCP server).
Prefer concise explanations, hate unnecessary hedging.
```

## Advanced Memory Tools

### Temporal Knowledge Graph

Facts change over time. The `kg_triples` table stores knowledge as subject-predicate-object triples with `valid_from` and `valid_to` timestamps, so facts can expire and contradict each other rather than accumulating in an undated blob.

Four MCP tools cover the full lifecycle:

- `kg_add` — Add a fact with a start date (and optional end date)
- `kg_query` — Query the graph, filtered to facts valid at a given point in time
- `kg_invalidate` — Mark a fact as no longer true (sets `valid_to`)
- `kg_contradictions` — Surface facts that directly contradict each other, using predicate inversion rules

Example: "the user prefers PostgreSQL" added in March; "the user prefers SQLite" added in April with the March fact invalidated. `kg_query` in April sees only the current fact; `kg_query` for March sees the historical one.

### Memory Taxonomy

`memory_taxonomy` gives a shape-of-memory overview: projects, session counts, chunk counts, embedding coverage, and recent activity. Think of it as a dashboard for your knowledge base — useful both for the model (to understand what it knows) and for you (to audit what is indexed).

### Cross-Project Tunnels

`memory_tunnels` detects concepts that appear across multiple projects. It works by comparing FTS vocabulary in SQLite mode or `ts_stat` output in PostgreSQL mode. When a concept — a library name, a design pattern, a person's name — shows up in three separate projects, PAI surfaces that connection as a tunnel.

This reveals unexpected intellectual bridges: the same concurrency pattern used in PAI's daemon showing up in your Flutter app's state management, or a vendor name appearing in both your notes and your job applications.

## Memory Architecture

PAI's memory system uses a three-tier hybrid store inspired by Cognee's approach to knowledge graphs and retrieval. Each tier has a distinct role, and they work together to answer queries that no single store could handle alone.

### Three-Tier Hybrid Store

| Tier | Backend | What it stores |
|------|---------|----------------|
| **Chunks + entities** | SQLite (simple mode) or PostgreSQL (full mode) | Text chunks with embeddings; named entity records with content-address hashes |
| **Knowledge graph** | PostgreSQL (`kg_triples`) | Subject-predicate-object triples with `valid_from`/`valid_to` timestamps |
| **Vector embeddings** | pgvector (full mode) | 768-dimensional Snowflake Arctic embeddings on chunks and vault notes |

### Entity Deduplication via Content-Address Hashing

Named entities (people, projects, libraries, concepts) extracted during indexing are stored in a `kg_entities` table and deduplicated using a content-address hash derived from the entity's canonical name. Two mentions of "PostgreSQL" in different session notes resolve to a single entity row — the hash acts as a stable identity, so the graph stays normalized even as new content is indexed.

### Graph-Completion Search Pipeline

Standard vector search finds semantically similar chunks. Graph-completion search goes further:

1. **Vector seeds** — a semantic search returns the top-K most relevant chunks.
2. **Graph traversal** — the entities mentioned in those chunks are looked up in `kg_triples`; their immediate neighbors are fetched (one hop).
3. **Candidate expansion** — the neighbor entities' associated chunks are added to the result set.
4. **Re-rank** — the expanded candidate set is re-scored by the cross-encoder, which reads each (query, result) pair together. Results are sorted by this final relevance score.

This means a query about "the PAI daemon" can surface a session note that mentions the daemon only indirectly — because a connected entity (the Unix socket, the launchd service) appears in both the graph and the note.

### Feedback Loop with Relevance Scoring

Every search result that is subsequently retrieved via `memory_get` (i.e., actually read by the model) generates a positive feedback signal. These signals are stored and used to adjust future search weights using an exponential moving average (EMA):

```
new_weight = alpha * signal + (1 - alpha) * old_weight
```

The default alpha is 0.1, so recent positive signals gradually raise a chunk's effective score without overriding the semantic baseline. This creates a personalization loop: content you actually use rises in future rankings; content you skip does not.

### Access Timestamp Tracking

Every chunk row carries a `last_accessed_at` timestamp updated on each `memory_get` call. This supports recency boost (content accessed recently scores higher) and enables future eviction policies for very large knowledge bases.

### Multi-Tenant Support

PAI isolates memory by project. Every chunk, entity, and observation row carries a `project_id` foreign key. Searches default to the current project; the `all_projects: true` flag (or `--all` CLI option) lifts the filter. Knowledge-graph triples carry a `project_id` as well, so cross-project tunnels (`memory_tunnels`) are detected explicitly rather than accidentally.

## Embedding Backends

Semantic search needs vectors. PAI embeds with `Snowflake/snowflake-arctic-embed-m-v1.5` (768 dims, CLS pooling, L2-normalized, 512-token context) and can run it on two backends:

| id | what it is | speed (Apple M5) |
|----|------------|------------------|
| `transformers-cpu-q8` | in-process transformers.js, q8, CPU. Default, no server. | ~8 chunks/s |
| `ollama-f16` | local Ollama server (Metal GPU), F16 GGUF of the same model | ~50 chunks/s |

Both live behind one contract (`src/memory/backends/types.ts`: `id`, `model`, `dims`, `maxTokens`, `available()`, `embed()`); the daemon embed pass, `pai memory embed [--background]` and query embedding in search all go through the configured backend. A remote `http` backend (for example an MLX server) is a future addition behind the same contract.

### Commands

```
pai memory backend detect                 # probe ollama, then transformers-cpu; recommend the fastest available
pai memory backend provision ollama       # download the F16 GGUF from Hugging Face and `ollama create` it
pai memory backend use <id> [--model <n>] # write embedding.backend (and embedding.model) to config
pai memory reembed [--backend <id>] [--yes]
```

`pai setup` runs the same detection (also with `--yes`). A fresh install adopts the fastest available backend; an existing install is only told what is available.

- **provision** is idempotent (skipped when the model exists on the server), needs no sudo, verifies the download's size and SHA-256, and imports it under the configured model name (default `arctic-embed-m-v1.5-f16`).
- **reembed** prints the chunk count and an ETA from a quick throughput probe and refuses without `--yes`. It sets every stored vector to NULL in bounded batches (never one giant transaction; an interrupted run is resumed by running it again), then records the new binding. `pai memory embed` or the daemon pass refills the vectors; keyword search keeps working meanwhile.

Config (`pai config get embedding`):

```yaml
embedding:
  backend: ollama-f16            # default: transformers-cpu-q8
  model: arctic-embed-m-v1.5-f16 # model name on the Ollama server
  ollama:
    baseUrl: http://127.0.0.1:11434
```

### Why vectors cannot be mixed

Vectors from different backends of the "same" model differ: q8-CPU against F16/fp32 vectors has a cosine of only about 0.97, so a query embedded by one backend ranks an index embedded by the other noticeably worse, and nothing signals it. The index is therefore bound to the backend that produced its vectors: backend id, model and dimensions are stored with the index (SQLite table `embedding_binding`, Postgres `pai_embedding_binding`), set on the first embed. An index that holds vectors but no binding is treated as `transformers-cpu-q8`.

When the configured backend differs from the recorded one, PAI does not embed and does not query with it. It reports `index embedded with X, configured Y: run pai memory reembed to switch`, the embed pass pauses, and searches fall back to keyword-only with that note. It never silently falls back to another backend.

When the configured backend is unavailable (for example Ollama is not running), embedding pauses with the chunks left unembedded and is retried by the next pass; queries go keyword-only with a visible note.

### Token cap

Ollama cuts inputs longer than 510 tokens differently from the model itself (cosine about 0.45 against the reference). For `ollama-f16`, each text is therefore cut to 510 content tokens with the model's own tokenizer at embed time (the count is logged). Chunk boundaries in the database are not changed.
