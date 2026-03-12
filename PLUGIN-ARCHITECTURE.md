# PAI Plugin Architecture

Technical reference for PAI's modular plugin system, cross-platform support, user extensions, and monetization tiers.

---

## Overview

PAI is structured as a modular plugin system with 8 named modules organized into 3 pricing tiers. The architecture supports Claude Code (full integration), Cursor (MCP only), and Gemini CLI (MCP only).

```
PAI Knowledge OS
├── Core (free, required)
│   ├── Memory engine (keyword search, SQLite)
│   ├── Session management
│   ├── Project registry
│   ├── 5 essential hooks
│   └── 3 essential skills
├── Free Extensions
│   ├── Productivity (Plan, Review, Journal, Research, Share)
│   ├── UI Customization (tab titles, statusline, tab colors)
│   └── Context Preservation (compression, relay, checkpoint)
├── Pro Extensions
│   ├── Semantic Search (pgvector, reranking, hybrid)
│   └── Observability (capture, classify, summarize)
└── Enterprise Extensions
    ├── Zettelkasten Intelligence (6 graph operations)
    └── Creative Studio (art, story, voice/prosody)
```

---

## Module System

### Module Manifest

Each module has a `plugins/<module>/plugin.json` that declares:

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

### Module Inventory

| Module | Tier | Hooks | Skills | Description |
|--------|------|-------|--------|-------------|
| `core` | free | 6 | 3 | Memory engine, sessions, projects, security |
| `productivity` | free | 2 | 6 | Plan, Review, Journal, Research, Share, Createskill |
| `ui` | free | 2 | 0 | Tab titles, statusline, tab coloring |
| `context-preservation` | free | 3 | 0 | Context compression and relay |
| `semantic-search` | pro | 0 | 0 | pgvector, reranking, hybrid search |
| `observability` | pro | 13 | 2 | Event capture, classification, summaries |
| `zettelkasten` | enterprise | 0 | 5 | Graph operations, vault intelligence |
| `creative` | enterprise | 0 | 2 | Art direction, story, voice/prosody |

### Hook Distribution

Total: 26 hook registrations across 6 modules.

**Core (6):** load-core-context, load-project-context, initialize-session, security-validator, stop-hook, pai-session-stop.sh

**Productivity (2):** sync-todo-to-md, cleanup-session-files

**UI (2):** update-tab-titles, update-tab-on-action

**Context Preservation (3):** context-compression-hook, pai-pre-compact.sh, post-compact-inject

**Observability (13):** capture-all-events (7 events), observe, inject-observations, capture-tool-output, capture-session-summary, subagent-stop-hook

### Skill Distribution

Total: 18 skills across 5 modules.

**Core (3):** Sessions, Route, Name

**Productivity (6):** Plan, Review, Journal, Research, Share, Createskill

**Observability (2):** Observability, SearchHistory

**Zettelkasten (5):** VaultConnect, VaultContext, VaultEmerge, VaultOrphans, VaultTrace

**Creative (2):** Art, StoryExplanation

---

## Directory Structure

```
PAI/
├── .claude-plugin/
│   └── plugin.json              # Claude Code plugin manifest
├── .cursor/
│   └── plugin.json              # Cursor plugin manifest
├── gemini-extension.json        # Gemini CLI extension manifest
├── pai-plugin.json              # Canonical module manifest (build reads this)
│
├── plugins/                     # Module definitions
│   ├── core/
│   │   ├── plugin.json          # Module metadata
│   │   ├── hooks/
│   │   │   └── hooks.json       # Core hook definitions
│   │   └── skills/              # (populated by build symlinks)
│   ├── productivity/
│   │   ├── plugin.json
│   │   ├── hooks/
│   │   │   └── hooks.json
│   │   └── skills/
│   ├── ui/
│   │   ├── plugin.json
│   │   └── hooks/
│   │       └── hooks.json
│   ├── context-preservation/
│   │   ├── plugin.json
│   │   └── hooks/
│   │       └── hooks.json
│   ├── semantic-search/
│   │   └── plugin.json
│   ├── observability/
│   │   ├── plugin.json
│   │   ├── hooks/
│   │   │   └── hooks.json
│   │   └── skills/
│   ├── zettelkasten/
│   │   ├── plugin.json
│   │   └── skills/
│   └── creative/
│       ├── plugin.json
│       └── skills/
│
├── user-extensions/             # User customization point (gitignored)
│   ├── README.md
│   ├── hooks/
│   │   └── .gitkeep
│   └── skills/
│       └── .gitkeep
│
├── src/                         # Source code (unchanged)
├── dist/                        # Build output (unchanged)
├── templates/                   # Setup templates (unchanged)
└── scripts/                     # Build scripts
```

---

## Cross-Platform Support

### Claude Code (Full Integration)

Claude Code gets the complete PAI experience:

| Capability | Support |
|------------|---------|
| MCP Tools (9) | Full |
| MCP Resources (11) | Full |
| MCP Prompts (18) | Full |
| Hooks (26 registrations) | Full |
| Skills (18 SKILL.md stubs) | Full |
| Statusline | Full |
| Tab management | Full |

Manifest: `.claude-plugin/plugin.json`

### Cursor (MCP Only)

Cursor supports MCP servers but not Claude Code's hook or skill system:

| Capability | Support |
|------------|---------|
| MCP Tools (9) | Full |
| MCP Resources | Not supported |
| MCP Prompts | Not supported |
| Hooks | Not supported |
| Skills | Not supported (use Cursor Rules instead) |

Manifest: `.cursor/plugin.json`

To use PAI with Cursor, add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "pai": {
      "command": "node",
      "args": ["/path/to/PAI/dist/daemon-mcp/index.mjs"]
    }
  }
}
```

### Gemini CLI (MCP Only)

Gemini CLI supports MCP servers via extensions:

| Capability | Support |
|------------|---------|
| MCP Tools (9) | Full |
| Hooks | Not supported |
| Skills | Not supported |

Manifest: `gemini-extension.json`

### Codex (Future)

OpenAI's Codex supports MCP. When available, a `codex-extension.json` can follow the same pattern.

---

## User Extensions

PAI provides three extension points that survive git pull and PAI updates.

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

Run `bun run build` to deploy. The build script discovers and symlinks custom skills into `~/.claude/skills/`.

### Custom Hooks

Create `user-extensions/hooks/my-hook.ts` or `user-extensions/hooks/my-hook.sh`:

TypeScript hooks are compiled during build. Shell hooks are symlinked directly. Register in `~/.claude/settings.json` under the appropriate hook event.

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
| `~/.claude/skills/user/` | N/A (outside repo) | Never touched | Claude Code scanner |

---

## Monetization Architecture

### Tier Model

| Tier | Price | Modules |
|------|-------|---------|
| Free | $0 | core, productivity, ui, context-preservation |
| Pro | $9/mo or $79/yr | Free + semantic-search, observability |
| Enterprise | $29/mo or $249/yr | Pro + zettelkasten, creative |

### Gating Strategy (Future)

The tier annotations in `pai-plugin.json` are structural markers for future license gating. The planned approach:

1. License key stored in `~/.config/pai/license.json`
2. Signed JWT for offline validation (no phone-home)
3. Checked at daemon startup and premium MCP tool invocation
4. Graceful degradation: premium features return "upgrade required" message
5. `pai license activate <key>` CLI command

Currently (v0.7.0): all features ship as free. Tier annotations are informational only.

### What Justifies Each Tier

**Pro** ($9/mo):
- Semantic search is a significant infrastructure requirement (PostgreSQL + pgvector)
- Cross-encoder reranking adds meaningful relevance improvement
- Observability provides professional-grade session tracking
- The value: "Your AI remembers better and you can see what it learned"

**Enterprise** ($29/mo):
- Zettelkasten requires Obsidian + significant graph computation
- 6 specialized operations (explore, surprise, converse, themes, health, suggest)
- Creative studio for specialized content creation workflows
- The value: "Your knowledge graph is actively maintained by AI"

---

## Build System Integration

The existing build system continues to work unchanged:

```bash
bun run build
# = tsdown (compile TS)
# + node scripts/build-hooks.mjs --sync (compile hooks, symlink to ~/.claude/Hooks/)
# + node scripts/build-skill-stubs.mjs --sync (generate skills, symlink to ~/.claude/skills/)
```

The plugin manifests (`pai-plugin.json`, `.claude-plugin/plugin.json`, etc.) are static JSON files maintained alongside the codebase. They declare the module structure but do not participate in the build process.

Future enhancement: a `scripts/build-plugin-manifest.mjs` that generates manifests from the module plugin.json files, ensuring version consistency.

---

## Migration Path

### From Pre-Plugin PAI (v0.6.x)

No migration needed. The plugin architecture is purely additive:

1. All existing symlinks continue to work
2. `~/.claude/settings.json` hook registrations unchanged
3. MCP server registration unchanged
4. User skills in `~/.claude/skills/user/` unchanged
5. Custom prompts in `src/daemon-mcp/prompts/custom/` unchanged

### For New Users

`pai setup` handles everything. The setup wizard installs all modules by default. Users can selectively disable modules later.

---

## Future Roadmap

### Phase 1 (v0.7.0 — Current)
- Module manifest system
- Cross-platform manifests
- User extension points
- Tier annotations (no enforcement)

### Phase 2 (v0.8.0)
- `pai plugins list` — show installed modules and tiers
- `pai plugins enable/disable <module>` — selective module activation
- Build system reads `pai-plugin.json` to generate platform manifests

### Phase 3 (v0.9.0)
- License validation system
- `pai license activate <key>` command
- Graceful tier gating with upgrade prompts

### Phase 4 (v1.0.0)
- Plugin marketplace integration
- Third-party plugin support
- Plugin dependency resolution
- Community plugin repository
