# Credits

PAI Knowledge OS builds on ideas, patterns, and architectures from other projects. This file documents those debts clearly and generously.

---

## mempalace

**Repository:** https://github.com/milla-jovovich/mempalace
**Author:** milla-jovovich
**Shipped in PAI:** v0.8.6+

mempalace introduced a layered approach to AI memory — the idea that not all context is equally urgent, and that a well-structured wake-up sequence can give an AI assistant a meaningful sense of continuity without flooding the context window from the start.

PAI adapted and extended these ideas:

- **4-layer wake-up context** (`memory_wakeup` MCP tool) — L0 loads a stable identity file (`~/.pai/identity.txt`), L1 loads the essential story from recent session notes. L2 (on-demand topic queries) and L3 (deep `memory_search`) are pulled as needed rather than eagerly at session start.
- **Temporal knowledge graph** (`kg_add`, `kg_query`, `kg_invalidate`, `kg_contradictions` tools) — A `kg_triples` table with `valid_from`/`valid_to` columns lets facts expire and contradict each other over time, rather than accumulating in a flat, undated blob.
- **Memory taxonomy** (`memory_taxonomy` tool) — A shape-of-memory browser that surfaces projects, sessions, counts, and recent activity at a glance, letting both the user and the model understand the scope and structure of what is indexed.
- **Mid-session auto-save** — The Stop hook now fires every 15 human messages (configurable via `PAI_AUTO_SAVE_INTERVAL`). It pushes a session-summary work item and blocks the Stop event to continue the session. A `stop_hook_active` flag prevents the save from triggering itself in a loop.
- **Palace graph / tunnels** (`memory_tunnels` tool) — Cross-project concept detection via FTS vocabulary in SQLite or `ts_stat` in PostgreSQL. Surfaces shared concepts that connect otherwise separate projects, revealing unexpected intellectual bridges.

---

## graphify

**Repository:** https://github.com/safishamsi/graphify
**Author:** safishamsi
**Shipped in PAI:** v0.8.5

graphify approaches knowledge graphs as living structures that evolve through use — with community detection, confidence scores, and feedback loops that improve retrieval over time.

PAI adapted these patterns for its Zettelkasten and vault intelligence layer:

- **God-note detection** (`zettel_god_notes`) — Surfaces notes with disproportionately high in-degree link counts — the notes that have become hubs rather than nodes, which often indicates they should be split or restructured.
- **Confidence tagging on vault links** — The `vault_links` table carries a `confidence` column on each directed link, allowing the system to distinguish high-confidence wikilinks (explicit `[[Note Name]]` syntax) from lower-confidence inferred connections.
- **Query feedback loop** — Queries and their results are logged to `~/.config/pai/queries/` so that repeated searches on the same concept improve future retrieval through accumulated signal.
- **Community detection** — Louvain community detection (`zettel_communities`) partitions the vault link graph into thematic clusters. graphify uses the Leiden algorithm; PAI uses Louvain for its simpler implementation surface while achieving comparable quality on typical vault sizes.

---

## Letta claude-subconscious

**Repository:** https://github.com/letta-ai/claude-subconscious
**Author:** Letta
**Shipped in PAI:** v0.7.7

Letta's claude-subconscious demonstrated the `UserPromptSubmit` hook pattern for persistent rule injection — the insight that rules injected only at session start can be forgotten after compaction or `/clear`, but a hook that fires before every prompt cannot be evaded.

PAI's **whisper rules** system (`src/hooks/ts/user-prompt/whisper-rules.ts`) applies this pattern directly. Rules from `~/.claude/whisper-rules.md` are injected as a system reminder before every user prompt. They survive compaction, `/clear`, and session restarts.

---

## claude-mem

**Repository:** https://github.com/thedotmack/claude-mem
**Author:** thedotmack
**Shipped in PAI:** early versions

claude-mem established the pattern of automatic observation capture with a rule-based classifier and progressive context injection — capturing what Claude does, classifying it by type, and surfacing the most relevant observations at the right moment.

PAI's observation system (`PostToolUse` hook, observation store in PostgreSQL, `memory_search` context injection) grew from this foundation.

---

## Fabric

**Repository:** https://github.com/danielmiessler/fabric
**Author:** Daniel Miessler
**Relationship:** Inspiration for the name and philosophy; different product

Daniel Miessler coined "Personal AI Infrastructure" and built Fabric — a Python CLI for augmenting human capabilities with reusable AI prompt patterns. If you have not seen Fabric, go look at it. It is excellent and solves a different problem extremely well.

PAI Knowledge OS starts from the same name and philosophy but takes a different direction: persistent memory, session continuity, and deep Claude Code integration rather than prompt patterns and pipe-through workflows. See [FEATURE.md](../../FEATURE.md) for a detailed comparison.

---

## Obsidian

**Website:** https://obsidian.md
**Relationship:** Vault format, zettelkasten structure

PAI's Obsidian bridge (`pai obsidian sync`, `zettel_*` tools) works with Obsidian's markdown-and-wikilinks vault format. Obsidian's conventions for bidirectional links, graph view, and folder structure shaped how PAI models its own vault intelligence layer.

---

## Niklas Luhmann

**Relationship:** The Zettelkasten method itself

The zettelkasten (German: slip box) is a note-taking and knowledge management method developed by sociologist Niklas Luhmann (1927-1998), who used it to produce 70 books and 400 scholarly articles over his lifetime. The method's core principle — atomic notes connected by explicit links, with no hierarchical filing — is the intellectual foundation for PAI's vault intelligence features.

---

## SAP Business Objects Crystal Reports

**Relationship:** Federation architecture (ADR-004, ADR-005)

The federation model for PAI's content storage architecture (local replica, sync on reconnect, conflict archive) is inspired by the Business Objects Crystal Reports platform architecture — specifically its incoming and outgoing file repositories for data federation between disconnected clients and a central server. See ADR-005 in [architecture-decisions.md](architecture-decisions.md).

---

## Document History

| Date | Event |
|------|-------|
| 2026-04-07 | Initial version. Credits for mempalace (v0.8.6), graphify (v0.8.5), Letta (v0.7.7), claude-mem (early), Fabric (inspiration), Obsidian, Luhmann, SAP Business Objects. |
