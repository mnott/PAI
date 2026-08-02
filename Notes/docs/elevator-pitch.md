# PAI Knowledge OS - Elevator Pitch

[Back to Index](index.md)

---

## Tagline

**"Your AI finally remembers."**

---

## The Problem

Claude Code forgets everything between sessions. Every morning, you re-explain your project, your decisions, your architecture, your preferences. You are the memory. And it costs you 15-30 minutes per session, every single time.

## The Solution

PAI Knowledge OS gives Claude Code persistent memory, session continuity, and a local knowledge graph - all running on your machine, with zero cloud dependencies.

1. **A background daemon indexes everything** - your session notes, project files, and decisions are chunked, embedded, and stored locally. Five minutes after you discuss something, it is searchable.

2. **Claude starts every session already knowing what you did** - progressive context injection loads recent observations, open tasks, and project state automatically. You say "Go" and Claude picks up exactly where the last session ended.

3. **Search by meaning, not just words** - ask "how does the reconnection logic work?" and PAI finds it, even if you never used those exact words. Hybrid search combines keyword matching, vector similarity, cross-encoder reranking, and recency weighting.

## What Makes PAI Different

PAI is not another MCP server. It is a complete operating system layer for AI-assisted development - daemon, hooks, skills, plugins, and observability - designed specifically for Claude Code's architecture. Nothing else provides session continuity that survives context compaction, automatic observation capture, or Zettelkasten-style intelligence on your knowledge graph.

## Call to Action

Install it in 5 minutes. Tell Claude:

> Clone https://github.com/mnott/PAI and set it up for me

Then ask Claude what you were working on yesterday. It knows.
