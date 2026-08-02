# PAI Knowledge OS - Product Roadmap

[Back to Index](index.md)

---

## Roadmap Overview

```
v0.7.0 (Current)     v0.8.0              v0.9.0             v1.0.0
March 2026            May 2026            July 2026          September 2026
Plugin Architecture   Plugin CLI          License System     Marketplace
Module manifests      Enable/disable      Tier gating        Third-party plugins
Cross-platform        Build integration   Graceful degrade   Community repository
User extensions       Module health       Upgrade prompts    Plugin dependencies
Tier annotations      Import/export       Payment system     Public API
```

---

## Phase 1: Plugin Architecture (v0.7.0 - Current)

**Status: Shipped**

### What Shipped

- **Module manifest system** - 8 modules with `plugin.json` declarations
- **Cross-platform manifests** - Claude Code (`.claude-plugin/`), Cursor (`.cursor/`), Gemini CLI (`gemini-extension.json`)
- **User extension points** - `user-extensions/skills/`, `user-extensions/hooks/`, `src/daemon-mcp/prompts/custom/`
- **Tier annotations** - Free/Pro/Enterprise markers on all modules (informational, no enforcement)
- **26 hook registrations** across 6 modules
- **18 skill stubs** across 5 modules
- **9 MCP tools** with daemon-backed execution

### Architecture Decisions

- Modules are directory-based (`plugins/<name>/plugin.json`)
- Build system unchanged - `bun run build` handles everything
- Symlink deployment for hooks and skills
- No breaking changes from v0.6.x

---

## Phase 2: Plugin CLI (v0.8.0 - May 2026)

**Status: Planned**

### What Ships

- **`pai plugins list`** - Show installed modules with tier, hook count, skill count, and status
- **`pai plugins enable <module>`** - Activate a module (creates hooks, deploys skills)
- **`pai plugins disable <module>`** - Deactivate a module (removes hooks, unlinks skills)
- **`pai plugins info <module>`** - Detailed module information
- **Build system integration** - `pai-plugin.json` drives platform manifest generation
- **Module health checks** - Verify hooks are deployed, skills are symlinked, dependencies met
- **Import/export** - Export module configuration for sharing across machines

### Why This Matters

Users can customize their PAI installation. Disable the UI module if you don't want tab management. Disable creative if you don't use art direction. This is the foundation for selective tier gating.

### Technical Details

- `pai plugins disable <module>` removes hook registrations from `~/.claude/settings.json` and unlinks skills from `~/.claude/skills/`
- Core module cannot be disabled (required: true)
- Dependency resolution prevents disabling a module that other enabled modules depend on
- State stored in `~/.config/pai/plugins.json`

### Aligned Marketing

- Blog post: "Customize Your PAI Installation" (module management)
- Blog post: "The Architecture of a Plugin System for AI Assistants"
- Content demonstrates PAI's flexibility and professionalism

---

## Phase 3: License System (v0.9.0 - July 2026)

**Status: Planned**

### What Ships

- **`pai license activate <key>`** - Activate a license key
- **`pai license status`** - Show current license tier and expiration
- **`pai license deactivate`** - Remove license from this machine
- **Signed JWT** for offline validation (no phone-home required)
- **License file** at `~/.config/pai/license.json`
- **Tier gating** - Premium features check license at invocation time
- **Graceful degradation** - Premium features return "upgrade to Pro/Enterprise" messages, never crash
- **Upgrade prompts** - Contextual suggestions when free users try premium features

### Gating Strategy

```
User calls memory_search with mode: "semantic"
    |
    +-- Check license tier
    |
    +-- If Pro or Enterprise: execute normally
    |
    +-- If Free: return message:
        "Semantic search requires PAI Pro ($9/mo).
         Falling back to keyword search.
         Upgrade: https://pai.dev/pricing"
```

### What Gets Gated

| Feature | Required Tier |
|---------|---------------|
| Semantic search (mode: semantic) | Pro |
| Hybrid search (mode: hybrid) | Pro |
| Cross-encoder reranking | Pro |
| Observation capture and query | Pro |
| Session summaries | Pro |
| Progressive injection | Pro |
| Zettelkasten operations (6) | Enterprise |
| Vault indexer | Enterprise |
| Art direction skill | Enterprise |
| Story explanation skill | Enterprise |
| Voice/prosody skill | Enterprise |

### Payment Integration

- Stripe for subscription management
- License keys generated on purchase
- Annual plans: $79/yr (Pro), $249/yr (Enterprise)
- GitHub Sponsors integration (optional alternative)

### Aligned Marketing

- Product Hunt launch (major event)
- Blog post: "PAI Goes Commercial: What's Free, What's Pro, What's Enterprise"
- Conversion optimization begins
- First newsletter sponsorships

---

## Phase 4: Marketplace (v1.0.0 - September 2026)

**Status: Planned**

### What Ships

- **Plugin marketplace** - Browse, install, and manage community plugins
- **Third-party plugin support** - Standard plugin format for external developers
- **Plugin dependency resolution** - Automatic installation of dependencies
- **Community plugin repository** - GitHub-based registry of vetted plugins
- **Plugin SDK** - Documentation and tools for plugin authors
- **Public API** - REST API alongside Unix socket for broader integration
- **Windows support** - Service manager alternative to launchd

### Marketplace Architecture

```
pai marketplace search "obsidian"
pai marketplace install @author/plugin-name
pai marketplace update
pai marketplace publish  (for plugin authors)
```

Plugins are npm packages with a `pai-plugin.json` manifest. The marketplace is a curated registry (initially GitHub-based, potentially custom later).

### Plugin SDK

- TypeScript template project
- Hook scaffolding
- Skill scaffolding
- MCP prompt scaffolding
- Testing utilities
- Documentation generator

### Why v1.0.0

This is the milestone where PAI transitions from a single-author project to a platform. Third-party plugins create a flywheel: more plugins attract more users, more users attract more plugin authors.

### Aligned Marketing

- v1.0.0 launch event
- "PAI Marketplace: The Plugin Ecosystem for AI Memory" blog post
- Conference talks (if accepted from Month 4 submissions)
- Enterprise outreach with case studies
- Community plugin contest

---

## Beyond v1.0.0

### Potential Future Directions

| Feature | Description | Timing |
|---------|-------------|--------|
| **Team/Org features** | Shared knowledge bases across team members | v1.1.0 |
| **Multi-model support** | Extend beyond Claude Code to other AI assistants | v1.2.0 |
| **Cloud sync** (optional) | Optional encrypted cloud backup | v1.3.0 |
| **Analytics dashboard** | Web UI for usage analytics and search patterns | v1.2.0 |
| **Advanced Zettelkasten** | AI-generated note summaries, automatic linking | v1.1.0 |
| **Plugin marketplace UI** | Web-based plugin browser | v1.1.0 |
| **Mobile companion** | View session notes and search from phone | v2.0.0 |
| **Voice interface** | Full voice control via AIBroker integration | v1.2.0 |

### Decision Criteria

Features are prioritized by:
1. Revenue impact (does it drive conversions?)
2. Retention impact (does it reduce churn?)
3. Community demand (GitHub issues, Discord requests)
4. Technical feasibility (can we ship it in one release cycle?)
5. Strategic alignment (does it strengthen PAI's market position?)

---

## Release Cadence

- **Major versions** (v0.x.0): Every 8-10 weeks
- **Patch versions** (v0.x.y): As needed for bug fixes
- **All versions**: Published to npm as `@tekmidian/pai`
- **Release process**: version bump, build, publish, single commit, push
- **Changelog**: Every release includes detailed changelog in GitHub Releases
