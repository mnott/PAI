# PAI Knowledge OS - Executive Summary

[Back to Index](index.md)

---

## Market Opportunity

AI coding assistants are the fastest-growing category in developer tools. Claude Code, GitHub Copilot, and Cursor collectively serve millions of developers. But they all share a critical limitation: **they forget everything between sessions**.

Every new session starts cold. Developers re-explain context, re-describe architecture, re-state preferences. Industry estimates suggest this costs 15-30 minutes per session - multiplied across millions of developers, that is hundreds of millions of hours of wasted productivity annually.

The market for AI developer memory infrastructure is wide open. No established player owns this space. Claude Code specifically has zero built-in persistent memory.

## Product Positioning

**PAI Knowledge OS is the only Knowledge Operating System for AI coding assistants.**

It is not a single-purpose MCP server. It is not a prompt library. It is a complete infrastructure layer that gives AI assistants persistent memory, session continuity, automatic observation capture, and knowledge graph intelligence - all running locally, with no cloud dependencies.

## Architecture Overview

```
Claude Code Session
    |
    +-- MCP Shim (stdio) -----> PAI Daemon (launchd service)
    |                               |
    +-- 26 Lifecycle Hooks          +-- Scheduler: index every 5 min
    |                               +-- Async embeddings (Snowflake Arctic, 768-dim)
    +-- 18 On-Demand Skills         +-- Storage (SQLite or PostgreSQL + pgvector)
    |                               +-- Observation Store
    +-- Statusline + Tab UI         +-- Vault Indexer (Zettelkasten)
```

**Four layers work together:**

1. **Daemon** - A persistent launchd service that owns indexing, embedding generation, and request proxying. Communicates over a Unix socket using NDJSON. Multiple Claude Code sessions share one daemon.

2. **MCP Server** - Exposes 9 tools, 18 skills, and 11 resources to Claude Code. The shim is stateless; all intelligence lives in the daemon.

3. **Hook System** - 26 lifecycle hooks across 6 events (SessionStart, PreCompact, PostToolUse, Stop, etc.) that intercept Claude Code's session lifecycle for context preservation, observation capture, and UI updates.

4. **Skill System** - 18 on-demand prompts loaded only when needed, covering planning, review, journaling, research, sharing, Zettelkasten operations, and creative workflows.

## Modular Plugin System

PAI v0.7.0 introduces a plugin architecture with 8 modules organized into 3 tiers:

| Tier | Price | Modules | Value |
|------|-------|---------|-------|
| **Free** | $0 | Core, Productivity, UI, Context Preservation | Memory, sessions, projects, planning, review, sharing |
| **Pro** | $9/mo | + Semantic Search, Observability | Vector search, reranking, automatic observation capture |
| **Enterprise** | $29/mo | + Zettelkasten, Creative Studio | Knowledge graph intelligence, art direction, voice |

The Free tier is genuinely useful on its own - keyword search, session management, project registry, 5 hooks, 6 productivity skills, full UI customization, and context preservation that survives compaction.

## Competitive Landscape

| Competitor | What They Do | How PAI Differs |
|------------|-------------|-----------------|
| **Fabric** (Daniel Miessler) | Python CLI for prompt patterns | Different problem: patterns vs. memory. Complementary, not competitive. |
| **superpowers/obra** | Plugin format for AI tools | Similar plugin approach; PAI has deeper Claude Code integration. |
| **Standalone MCPs** | Individual tools (memory, search) | PAI is an integrated system, not a collection of parts. |
| **GitHub Copilot** | Code completion with project indexing | No persistent cross-session memory. No observation capture. |
| **Manual note-taking** | Developer writes notes themselves | PAI automates capture, indexing, and injection. |

## Revenue Path

Target: $5k MRR within 6 months of commercial launch.

- **Mix**: ~250 Pro ($9/mo) + ~90 Enterprise ($29/mo) = $4,860 MRR
- **Strategy**: Open source core builds trust and adoption; premium features (semantic search, observability, Zettelkasten) provide clear upgrade value
- **Distribution**: GitHub stars as social proof, Product Hunt launch, Reddit/X community, technical blog content

## Key Metrics (Current)

- 449K+ indexed chunks across 77+ projects (real production usage)
- 9 MCP tools, 18 skills, 26 hook registrations, 11 resources
- Cross-platform: Claude Code (full), Cursor (MCP), Gemini CLI (MCP)
- All processing local - no cloud API keys required for core functionality

## Next Steps

See the detailed [Marketing Plan](marketing-plan.md) for the month-by-month path to $5k MRR, the [Pricing](pricing.md) page for tier details, and the [Roadmap](roadmap.md) for the technical path to v1.0.0.
