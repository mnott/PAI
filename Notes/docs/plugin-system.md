# PAI Knowledge OS - Plugin System

[Back to Index](index.md)

---

## Overview

PAI v0.7.0 is structured as a modular plugin system with 8 named modules organized into 3 pricing tiers. The architecture supports Claude Code (full integration), Cursor (MCP only), and Gemini CLI (MCP only).

```
PAI Knowledge OS
+-- Core (free, required)
|   +-- Memory engine (keyword search, SQLite)
|   +-- Session management
|   +-- Project registry
|   +-- 5 essential hooks
|   +-- 3 essential skills
+-- Free Extensions
|   +-- Productivity (Plan, Review, Journal, Research, Share)
|   +-- UI Customization (tab titles, statusline, tab colors)
|   +-- Context Preservation (compression, relay, checkpoint)
+-- Pro Extensions
|   +-- Semantic Search (pgvector, reranking, hybrid)
|   +-- Observability (capture, classify, summarize)
+-- Enterprise Extensions
    +-- Zettelkasten Intelligence (6 graph operations)
    +-- Creative Studio (art, story, voice/prosody)
```

---

## The 8 Modules

### Module Inventory

| Module | Tier | Hooks | Skills | Description |
|--------|------|-------|--------|-------------|
| `core` | Free | 6 | 3 | Memory engine, sessions, projects, security |
| `productivity` | Free | 2 | 6 | Plan, Review, Journal, Research, Share, Createskill |
| `ui` | Free | 2 | 0 | Tab titles, statusline, tab coloring |
| `context-preservation` | Free | 3 | 0 | Context compression and relay |
| `semantic-search` | Pro | 0 | 0 | pgvector, reranking, hybrid search |
| `observability` | Pro | 13 | 2 | Event capture, classification, summaries |
| `zettelkasten` | Enterprise | 0 | 5 | Graph operations, vault intelligence |
| `creative` | Enterprise | 0 | 2 | Art direction, story, voice/prosody |

**Totals:** 26 hook registrations + 18 skills across 8 modules.

### Module Manifests

Each module has a `plugins/<module>/plugin.json`:

```json
{
  "name": "pai-core",
  "displayName": "PAI Core",
  "description": "Core memory engine, session management, and project registry",
  "version": "0.7.0",
  "tier": "free",
  "required": true,
  "depends": [],
  "hooks": "hooks/hooks.json",
  "skills": ["Sessions", "Route", "Name"]
}
```

---

## Module Details

### Core (Free - Required)

The foundation. Cannot be disabled.

**Hooks (6):** load-core-context, load-project-context, initialize-session, security-validator, stop-hook, pai-session-stop.sh

**Skills (3):** Sessions (lifecycle management), Route (cross-project linking), Name (naming conventions)

**Features:**
- Memory engine with keyword search (BM25)
- Session note creation and tracking
- Project auto-detection from working directory
- Registry management (77+ projects, 449K+ chunks)
- Security validation on shell commands

### Productivity (Free)

Day-to-day developer workflows.

**Hooks (2):** sync-todo-to-md, cleanup-session-files

**Skills (6):** Plan, Review, Journal, Research, Share, Createskill

**Features:**
- Forward-looking planning from TODOs and recent activity
- Retrospective reviews with themed narratives
- Structured journaling with timestamps
- Research methodology with source tracking
- Platform-aware social media content generation (LinkedIn, X, Bluesky)
- Skill scaffolding for creating new PAI skills

### UI (Free)

Terminal customization for visual context.

**Hooks (2):** update-tab-titles, update-tab-on-action

**Features:**
- Rich statusline: model, MCPs, context meter, auto-compact indicator
- Dynamic tab titles based on current project and activity
- Tab color coding by project or session type

### Context Preservation (Free)

Survives Claude Code's context compaction - the feature that makes PAI essential.

**Hooks (3):** context-compression-hook, pai-pre-compact.sh, post-compact-inject

**Features:**
- PreCompact state extraction from conversation transcript
- Checkpoint persistence in session notes
- Two-stage relay: PreCompact saves, SessionStart injects
- Preserves: last 3 requests, work summaries, files modified, task state

### Semantic Search (Pro)

Intelligence upgrade for the memory engine.

**Hooks:** None (uses core's search infrastructure with upgraded backend)

**Features:**
- 768-dimensional Snowflake Arctic embeddings
- pgvector HNSW indexes for cosine similarity search
- Hybrid mode: keyword + semantic with normalized score blending
- Cross-encoder reranking (ms-marco-MiniLM, 23MB)
- Recency boost with configurable half-life

### Observability (Pro)

Automatic activity tracking and progressive context.

**Hooks (13):** capture-all-events (7 event registrations), observe, inject-observations, capture-tool-output, capture-session-summary, subagent-stop-hook

**Skills (2):** Observability, SearchHistory

**Features:**
- Rule-based tool call classification (decision/bugfix/feature/refactor/discovery/change)
- Content-hash deduplication (30-second window)
- Progressive context injection at session start
- Session summaries (requested, investigated, learned, completed, next steps)
- Observation search and statistics

### Zettelkasten (Enterprise)

Knowledge graph intelligence on Obsidian vaults.

**Skills (5):** VaultConnect, VaultContext, VaultEmerge, VaultOrphans, VaultTrace

**Features:**
- 6 computational operations: Explore, Surprise, Converse, Themes, Health, Suggest
- Vault indexing with symlink following and inode deduplication
- Full wikilink parsing (wikilinks, embeds, markdown links)
- Graph + embedding dual representation
- Structural health audits (dead links, orphans, isolated clusters)

### Creative (Enterprise)

Specialized content creation workflows.

**Skills (2):** Art, StoryExplanation

**Features:**
- Visual art direction and aesthetic guidance
- Narrative explanations of technical concepts
- Voice agent template and prosody guidelines
- TTS integration (Kokoro local, ElevenLabs)

---

## Hook Distribution by Event

| Event | Module | Hook | Injection |
|-------|--------|------|-----------|
| SessionStart | core | load-core-context | Yes |
| SessionStart | core | load-project-context | Yes |
| SessionStart | core | initialize-session | Yes |
| SessionStart | context-preservation | post-compact-inject | Yes (compact only) |
| SessionStart | observability | inject-observations | Yes |
| PreToolUse | core | security-validator | Yes (Bash only) |
| PostToolUse | observability | observe | No |
| PostToolUse | observability | capture-tool-output | No |
| PostToolUse | ui | update-tab-on-action | No |
| PostToolUse | productivity | sync-todo-to-md | No (TodoWrite only) |
| UserPromptSubmit | productivity | cleanup-session-files | No |
| UserPromptSubmit | ui | update-tab-titles | No |
| PreCompact | context-preservation | context-compression-hook | No (writes temp file) |
| PreCompact | context-preservation | pai-pre-compact.sh | No |
| Stop | core | stop-hook | No |
| SessionEnd | observability | capture-session-summary | No |
| SubagentStop | observability | subagent-stop-hook | No |
| All events | observability | capture-all-events | No |

---

## Skill Distribution by Module

| Module | Skill | Trigger |
|--------|-------|---------|
| core | Sessions | Session lifecycle management |
| core | Route | Cross-project session linking |
| core | Name | Session and project naming |
| productivity | Plan | "plan my week", "what should I focus on" |
| productivity | Review | "review my week", "what did I do today" |
| productivity | Journal | "journal this thought" |
| productivity | Research | "research best practices for..." |
| productivity | Share | "share on LinkedIn", "tweet about..." |
| productivity | Createskill | "create a new skill" |
| observability | Observability | "show observations", "what did I change" |
| observability | SearchHistory | "search history", "search patterns" |
| zettelkasten | VaultConnect | "suggest vault connections" |
| zettelkasten | VaultContext | "use vault as context" |
| zettelkasten | VaultEmerge | "what themes are emerging" |
| zettelkasten | VaultOrphans | "find orphaned notes" |
| zettelkasten | VaultTrace | "trace idea lineage" |
| creative | Art | "art direction", "visual guidance" |
| creative | StoryExplanation | "explain this as a story" |

---

## Cross-Platform Support

### Claude Code (Full Integration)

All capabilities available:

| Capability | Support |
|------------|---------|
| MCP Tools (9) | Full |
| MCP Resources (11) | Full |
| MCP Prompts (18) | Full |
| Hooks (26 registrations) | Full |
| Skills (18 SKILL.md stubs) | Full |
| Statusline | Full |
| Tab management | Full |

### Cursor (MCP Only)

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "pai": {
      "command": "node",
      "args": ["/path/to/PAI/dist/daemon-mcp/index.mjs"]
    }
  }
}
```

| Capability | Support |
|------------|---------|
| MCP Tools (9) | Full |
| MCP Resources | Not supported |
| MCP Prompts | Not supported |
| Hooks | Not supported |
| Skills | Not supported (use Cursor Rules) |

### Gemini CLI (MCP Only)

Same MCP tool access, no hooks or skills. Manifest: `gemini-extension.json`.

---

## User Extension Points

Three extension locations that survive `git pull` and PAI updates:

### Custom Skills

Create `user-extensions/skills/MySkill/SKILL.md`:

```markdown
---
name: MySkill
description: "What the skill does. USE WHEN user says 'trigger phrase'."
---

## My Skill Instructions

Your skill content here...
```

Run `bun run build` to deploy. Build discovers and symlinks custom skills into `~/.claude/skills/`.

### Custom Hooks

Create `user-extensions/hooks/my-hook.ts` or `user-extensions/hooks/my-hook.sh`.

TypeScript hooks compile during build. Shell hooks are symlinked directly. Register in `~/.claude/settings.json` under the appropriate event.

### Custom MCP Prompts

Create `src/daemon-mcp/prompts/custom/my-prompt.ts`:

```typescript
export const myPrompt = {
  description: "What the prompt does",
  content: `## My Prompt
USE WHEN user says 'trigger phrase'...
Your prompt content here...`,
};
```

Run `bun run build` to generate the skill stub.

### Extension Safety

| Location | Gitignored | PAI Updates | Discovery |
|----------|------------|-------------|-----------|
| `user-extensions/skills/` | Yes | Never touched | Build sync |
| `user-extensions/hooks/` | Yes | Never touched | Build compile |
| `src/daemon-mcp/prompts/custom/` | Yes | Never touched | Build generate |

---

## Module Dependency Graph

```
creative --------+
                 |
zettelkasten ----+--> observability ---+--> semantic-search --+
                                      |                      |
                     context-preservation                    |
                                      |                      |
                     ui ------+       |                      |
                              |       |                      |
                     productivity ----+--> core <-------------+
```

Core is required by everything. Free modules (productivity, ui, context-preservation) depend only on core. Pro modules (semantic-search, observability) extend core's search and capture infrastructure. Enterprise modules (zettelkasten, creative) build on the full stack.

---

## Creating a Custom Plugin

To create a new module:

1. Create `plugins/my-module/plugin.json`:

```json
{
  "name": "pai-my-module",
  "displayName": "My Module",
  "description": "What it does",
  "version": "0.7.0",
  "tier": "free",
  "required": false,
  "depends": ["core"],
  "hooks": "hooks/hooks.json",
  "skills": ["MySkill"]
}
```

2. Add hooks in `plugins/my-module/hooks/hooks.json`
3. Add skills in `user-extensions/skills/MySkill/SKILL.md`
4. Run `bun run build`

Future versions (v0.8.0+) will add `pai plugins list`, `pai plugins enable/disable`, and build system integration with `pai-plugin.json`.

---

## Monetization Architecture

### Tier Model

| Tier | Price | Modules |
|------|-------|---------|
| Free | $0 | core, productivity, ui, context-preservation |
| Pro | $9/mo or $79/yr | Free + semantic-search, observability |
| Enterprise | $29/mo or $249/yr | Pro + zettelkasten, creative |

### License Gating (Planned - v0.9.0)

Currently (v0.7.0): all features ship as free. Tier annotations are informational only.

Planned approach:
1. License key stored in `~/.config/pai/license.json`
2. Signed JWT for offline validation (no phone-home)
3. Checked at daemon startup and premium tool invocation
4. Graceful degradation: premium features return "upgrade required"
5. `pai license activate <key>` CLI command
