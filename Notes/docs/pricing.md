# PAI Knowledge OS - Pricing

[Back to Index](index.md)

---

## Three Tiers, One Philosophy

PAI is open source (MIT). The core is free forever. Premium tiers add advanced intelligence features that require significant infrastructure or computational depth.

---

## Free - $0/month

**Perfect for individual developers.**

Everything you need for persistent AI memory.

### Included

- **Core Memory Engine** - Keyword search (BM25 via FTS5), auto-indexing every 5 minutes
- **Session Management** - Numbered session notes, auto-creation, tagging, cross-referencing
- **Project Registry** - Auto-detection from working directory, aliases, tags, health audits
- **5 Essential Hooks** - Session start, project detection, session initialization, security validation, session stop
- **6 Productivity Skills** - Plan, Review, Journal, Research, Share, Createskill
- **UI Customization** - Statusline (model, MCPs, context meter), tab titles, tab colors
- **Context Preservation** - Survives context compaction with two-stage relay. Your work is never lost.
- **SQLite Storage** - Zero dependencies beyond Bun. No Docker needed.
- **Cross-Platform MCP** - Works with Cursor and Gemini CLI (MCP tools only)

### What You Can Do

- Search past sessions by keyword
- Pick up where you left off every morning
- Survive context compaction without losing state
- Plan your week, review your work, journal your thoughts
- Share on LinkedIn, X, and Bluesky from your actual work
- Manage unlimited projects and sessions

---

## Pro - $9/month or $79/year (save 27%)

**For developers who want their AI to truly understand their codebase.**

Everything in Free, plus search intelligence and observability.

### Added in Pro

- **Semantic Search** - 768-dimensional Snowflake Arctic embeddings. Find things by meaning, not just words.
- **Hybrid Search** - Keyword + semantic combined with normalized score blending. Best overall result quality.
- **Cross-Encoder Reranking** - ms-marco-MiniLM model (23MB, local) re-scores every result for relevance. Catches what keyword and vector search miss.
- **Recency Boost** - Recent content scores higher with configurable half-life. Default 90 days.
- **Automatic Observation Capture** - Every significant tool call classified and stored: decision, bugfix, feature, refactor, discovery, change.
- **Progressive Context Injection** - Claude starts every session already knowing what you did. Three layers: compact index, timeline, on-demand detail.
- **Session Summaries** - Structured end-of-session summaries: requested, investigated, learned, completed, next steps.
- **PostgreSQL + pgvector** - Full-featured database with HNSW indexes for production-grade search.

### Why Upgrade

The Free tier finds things you can name. The Pro tier finds things you can describe. Ask "how does the reconnection logic work?" and Pro finds it even if you never used those exact words. Observations mean Claude knows what you did yesterday without you telling it.

---

## Enterprise - $29/month or $249/year (save 28%)

**For knowledge workers building a second brain.**

Everything in Pro, plus knowledge graph intelligence and creative tools.

### Added in Enterprise

- **Zettelkasten Intelligence** - 6 graph operations on your Obsidian vault:
  - **Explore** - Follow trains of thought through wikilink chains
  - **Surprise** - Discover semantically close but graph-distant notes
  - **Converse** - Let the vault "talk back" with unexpected connections
  - **Themes** - Detect emerging note clusters across folders
  - **Health** - Structural audit: dead links, orphans, isolated clusters
  - **Suggest** - Proactive link suggestions using semantics + tags + graph
- **Vault Indexer** - Full Obsidian vault indexing with symlink following, inode deduplication, and wikilink graph construction
- **Creative Studio**:
  - **Art Direction** - Visual art direction and aesthetic guidance
  - **Story Explanations** - Turn complex architecture into understandable narratives
  - **Voice/Prosody** - TTS integration with Kokoro (local) and ElevenLabs

### Why Upgrade

If you maintain an Obsidian vault, Enterprise transforms it from a static note collection into an active knowledge graph. PAI finds connections you missed, detects themes you didn't realize were emerging, and keeps your vault structurally healthy. The creative tools help you communicate technical ideas to non-technical audiences.

---

## Tier Comparison

| Feature | Free | Pro | Enterprise |
|---------|:----:|:---:|:----------:|
| Keyword search (BM25) | Yes | Yes | Yes |
| Session management | Yes | Yes | Yes |
| Project registry | Yes | Yes | Yes |
| Context preservation | Yes | Yes | Yes |
| Plan, Review, Journal, Research, Share | Yes | Yes | Yes |
| Statusline + tab UI | Yes | Yes | Yes |
| Semantic search (vector) | - | Yes | Yes |
| Hybrid search | - | Yes | Yes |
| Cross-encoder reranking | - | Yes | Yes |
| Recency boost | - | Yes | Yes |
| Observation capture | - | Yes | Yes |
| Progressive injection | - | Yes | Yes |
| Session summaries | - | Yes | Yes |
| Zettelkasten (6 operations) | - | - | Yes |
| Vault indexer | - | - | Yes |
| Art direction | - | - | Yes |
| Story explanations | - | - | Yes |
| Voice/prosody | - | - | Yes |

---

## FAQ

### Is it really local?

Yes. PAI runs entirely on your machine. The daemon, the database, the embeddings, the reranker - everything. No data leaves your computer. No API keys needed for core functionality. The embedding model (Snowflake Arctic) and reranker (ms-marco-MiniLM) run locally via @huggingface/transformers.

### Do I need Docker?

Only for the Pro and Enterprise tiers (PostgreSQL + pgvector). The Free tier uses SQLite and needs nothing beyond Bun.

### What about my data?

Your data lives in two places: `~/.pai/registry.db` (SQLite, always) and the PostgreSQL database (full mode). Both are on your machine. PAI includes backup and restore commands. You can export everything at any time.

### Can I use it with Cursor?

Yes. PAI's 9 MCP tools work with Cursor via MCP. Add the PAI MCP server to `.cursor/mcp.json`. You get memory search, project management, and session listing. Cursor doesn't support hooks or skills, so you get MCP tools only.

### Can I use it with Gemini CLI?

Yes. Same MCP tools work with Gemini CLI via `gemini-extension.json`.

### What happens if I stop paying?

If you downgrade from Pro or Enterprise, premium features gracefully degrade. Your data remains intact - it's all local. You keep keyword search, session management, and all Free tier features. Semantic search results and observations stay in the database but require Pro to query.

### Is there a trial?

Currently (v0.7.0), all features are free. Tier gating is planned for v0.9.0. You can try everything today at no cost.

### How does annual pricing work?

Annual plans save ~28%: Pro at $79/year (vs $108/year monthly) and Enterprise at $249/year (vs $348/year monthly). Payment is upfront for the year.

### Can I switch tiers?

Yes. Upgrade or downgrade at any time. Upgrades take effect immediately. Downgrades take effect at the end of the current billing cycle.

### Is there an organization/team plan?

Not yet. Enterprise is currently per-developer. Team licensing with shared knowledge bases is on the roadmap for post-v1.0.0.

### What's included in updates?

All tiers receive updates. Free users get core improvements. Pro and Enterprise users get improvements to their respective modules. New modules may be added to existing tiers or introduced as new tiers.
