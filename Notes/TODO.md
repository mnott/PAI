## Continue

> **Last session:** 0025 - 2026-04-13 - Fixed Advisor Strict Mode To Delegate Instead Of Hoard
> **Paused at:** 2026-04-13T06:43:37.776Z
>
> Working directory: /Users/i052341/Daten/Cloud/Development/ai/PAI
> Work completed:
> - Added swarm mode guidance to strict and critical advisor modes.

---

## Live Testing Checklist (session 0007)

*Tests run from a fresh Claude session in `~` (home directory).*

### /sessions skill
- [x] **T1: /sessions overview** — Skill triggers, project list + session list work, routing reports "not set" for `~`. **PASS**
- [x] **T1b: Active sessions detection** — Built `pai session active` command. Detects open tabs via JSONL timestamps. Skill updated to show active sessions first. **PASS (needs live retest)**
- [ ] **T2: Consolidate workflow** — Run `consolidate PAI sessions` → should group/organize sessions
- [ ] **T3: ProjectInfo from ~** — Run `what project is this?` → should report no project or offer routing
- [ ] **T4: Session search** — Run `search sessions for notification` → should find relevant sessions

### /route skill
- [ ] **T5: /route from ~** — Run `/route` → should detect no project, offer to tag session
- [ ] **T6: Route to a project** — Run `route to PAI` → should set routing for current session

### Setup & Idempotency
- [ ] **T7: Setup invokable by prompt** — Run `set up PAI` → should trigger setup skill, detect existing config, skip all steps
- [ ] **T8: Idempotent reinstall** — Run setup on pre-configured system → nothing should break

### PAI MCP & Search
- [ ] **T9: PAI memory search** — Run `search PAI for "notification"` → MCP `memory_search` should fire and return chunks
- [ ] **T10: PAI registry search** — Run `search PAI registry for "whazaa"` → should find Whazaa project

### Daemon & Notifications
- [ ] **T11: Daemon status** — Run `pai daemon status` → should report running
- [ ] **T12: Notification test** — Run `pai notify test` → notification should arrive
- [ ] **T13: Daemon logs** — Run `pai daemon logs -n 10` → should show recent log lines

### Session Auto-Routing
- [ ] **T14: Auto-route on session start** — Start a session in a PAI project directory → should auto-detect and route
- [ ] **T15: Auto-route edge case** — Start in `~` → should handle gracefully (no crash, no false match)

### Voice & Multilingual (if Whazaa active)
- [ ] **T16: Whisper multilingual** — Send a non-English voice note via WhatsApp → should transcribe correctly

---

## Monetization Roadmap

### Phase 1: Tier Realignment (this week)
- [ ] Move auto-notes, topic splitting, whisper rules, reconstruct, consolidate into Pro tier
- [ ] Update `Notes/docs/pricing.md` with new tier boundaries
- [ ] Update `FEATURE.md` tier columns
- [ ] Update `PLUGIN-ARCHITECTURE.md` module-to-tier mapping
- [ ] Update `README.md` to clarify what's free vs Pro
- [ ] Add tier gate stubs in code (check license, degrade gracefully)

### Phase 2: License Key System (next week)
- [ ] Design key format (JWT or signed token with expiry + tier)
- [ ] Build validation server (lightweight, on SeriousLetter infra or standalone)
- [ ] Local key cache — validate once, cache for 7 days, work offline
- [ ] AES-256 encrypted blob build pipeline for @tekmidian/pai-pro
- [ ] Two-package publish: `@tekmidian/pai` (MIT, free) + `@tekmidian/pai-pro` (encrypted, proprietary)
- [ ] `pai license activate <key>` CLI command
- [ ] Graceful degradation: Pro features show "upgrade to Pro" message when unlicensed

### Phase 3: Payment & Landing Page (week after)
- [ ] Landing page at pai.tekmidian.com (or tekmidian.com/pai)
- [ ] Stripe Checkout integration (monthly + annual plans)
- [ ] Key delivery via email on purchase
- [ ] Annual discount logic ($79/yr Pro, $249/yr Enterprise)
- [ ] GitHub README badge linking to landing page
- [ ] "Upgrade" link in PAI statusline for free users

### Phase 4: Launch
- [ ] LinkedIn post (from elevator-pitches.md)
- [ ] X thread (7 tweets from elevator-pitches.md)
- [ ] Target Claude Code community: r/ClaudeAI, Claude Code Discord, Hacker News
- [ ] First 100 users goal — track with GitHub stars + Stripe conversions
- [ ] Collect feedback, iterate on tier boundaries

---

## Open: Next Steps

- [x] Test `/sessions` skill in a fresh Claude session — T1 passed
- [x] Review `~/.claude/History/session-history.md` — clean
- [x] MCP Companion Skill pattern — added ## Preferences + ## Pre-Action Check to Workspace, Jobs, Whatsapp, DEVONthink; added routing rule to CORE
- [x] Test `/review week` — first live test PASS (session 0009)
- [x] Vault indexer: parse markdown links alongside wikilinks (v0.5.7)
- [ ] **Test Obsidian Knowledge Plugin end-to-end** — install in Obsidian, verify all 5 graph views render
- [ ] **Add CSS for latent ideas panel** — pai-ideas-panel, pai-idea-card classes need styling
- [ ] **Test idea_materialize** — write a new vault note from a latent idea
- [ ] **Wait for vault embeddings** — only ~5 of 37K chunks embedded; semantic edges + clusters depend on this
- [ ] Test `/journal` for first journal entry
- [ ] Update vault-fixer to detect broken markdown links (not just wikilinks)
- [ ] Phase 2 journal data layer — journal table in federation.db
- [ ] Run skill-creator eval/benchmarking on key skills (Jobs, CORE, Research) — backlog
- [ ] Run skill-creator trigger optimization on 30+ skills — backlog
- [ ] Consider: should `pai` auto-detect when run inside Claude and output JSON vs Rich?
- [ ] Write PAI User Manual (document all features, commands, and workflows)
- [ ] Explore Ollama + Aider local setup for token-saving coding tasks
- [ ] Build MCP-Ollama bridge for PAI (delegate subtasks to local models via tool calls)
- [ ] Set up image generation MCP (separate project) — FAL.ai MCP recommended (600+ models, Flux/Imagen/SD). Can send generated images to WhatsApp via Whazaa. See: https://github.com/raveenb/fal-mcp-server

---

## Open: Remaining Feature Requests

*Only items that are genuinely not yet implemented.*

### Needs Live Testing (can't verify in current session)

- [ ] **Setup invokable by prompt** — see T7/T8 above
- [ ] **Idempotent on reinstall** — see T7/T8 above
- [ ] **Session auto-routing verification** — see T14/T15 above
- [ ] **Whisper multilingual voice** — see T16 above

### Post-v1 Roadmap (deferred)

- [ ] **Multilingual search** — Translate non-English queries to English before BM25/vector search, translate response back. Large effort.
- [ ] **Hooks for additional lifecycle events** — Low context warning, session start, topic shift. Would move orchestration from CLAUDE.md into PAI hooks. Large architectural change.
- [ ] **Improve /relocate UX** — Claude Code's CWD is fixed per session. Architectural limitation. Defer until Claude Code supports CWD change.

---

## Resolved Since Last Update

### Sessions 0001–0013 — 18 Releases (v0.7.2 → v0.9.6), Mar 19 – Apr 9

Shipped across 22 days in a single mega-session spanning multiple compactions:

| Version | Feature |
|---------|---------|
| v0.7.2 | Auto-registration, one-note-per-session, Reconstruct skill |
| v0.7.3 | Automatic AI-powered session notes via daemon |
| v0.7.4 | Auto-register on parent match |
| v0.7.5 | Tiered model selection (opus/sonnet/haiku) |
| v0.7.6 | Find claude binary in launchd |
| v0.7.7 | Whisper rules hook |
| v0.7.8 | Strip API key from daemon (prevent billing) |
| v0.8.0 | Topic-based note splitting |
| v0.8.1 | /whisper skill, remove hardcoded defaults |
| v0.8.2 | Reduce topic split sensitivity |
| v0.8.3 | /consolidate skill |
| v0.8.4 | Store TOPIC in HTML comment |
| v0.8.5 | God-note detection, confidence tagging, Louvain communities, query feedback |
| v0.9.0 | 4-layer wake-up, temporal KG, taxonomy, tunnels, mid-session auto-save |
| v0.9.1 | KG backfill CLI, shared kg-extraction module |
| v0.9.2 | Stop-hook first-run safeguard |
| v0.9.3 | Silence stop-hook diagnostics |
| v0.9.4 | Remove exit(2) noise |
| v0.9.5 | Budget-aware advisor mode |
| v0.9.6 | Statusline auto-writes budget to advisor |

### Session 0017 — v0.9.7 (current session)
- [x] Advisor mode label in statusline (strict/conserve/critical/normal with color coding)
- [x] 📌 prefix for manually forced modes vs auto-calculated
- [x] Statusline preserves manual mode/forceModel — no longer overwrites with "auto"
- [x] Natural language advisor mode switching ("go easy on the budget", "lock it down", etc.)
- [x] Fixed threshold table drift in advisor prompt (60/80/92 matching whisper-rules.ts)
- [x] Published @tekmidian/pai@0.9.7

### Session 0008 — Stop Hook Continue Fix
- [x] Fixed stop hook to call `updateTodoContinue()` on normal session end — previously only pre-compact hook wrote ## Continue
- [x] Improved fallback text in `updateTodoContinue()` to include working directory instead of generic "check session note"
- [x] Build verified — all 15 hooks compiled clean

### Session 0042 — Auto-Compact Fix & Local AI Research
- [x] Enabled `autoCompactEnabled: true` in `~/.claude.json` — fixes sessions dying at 200k token limit
- [x] Researched Claude Code auto-compaction: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env var controls threshold, PreCompact hook exists, no PostCompact yet
- [x] Researched local AI coding assistants: Aider (best CLI), Goose (best agent), Continue.dev (best editor), all via Ollama
- [x] Researched MCP-Ollama bridge pattern — multiple implementations exist (ollama-mcp, ollama-mcp-bridge)
- [x] Researched contextplus (code intelligence MCP) and llm-tldr (code compression) — contextplus complementary, llm-tldr fragile
- [x] Researched Mistral Devstral models: Small 2 (24B, 68% SWE-bench), Devstral 2 (123B, 72.2% SWE-bench)
- [x] Mac Studio RAM analysis: 96GB sweet spot today, 128GB+ for 2-year future-proofing

### Session 0007 — Path Decoder Fix, Active Sessions, Registry Cleanup
- [x] Fixed path decoder bug: `smartDecodeDir()` walks filesystem to decode lossy Claude Code encoding (34→25 skipped projects, 9 recovered)
- [x] Added case-insensitive matching for macOS (TEKmidian → TEKMidian)
- [x] Fixed stale session-registry.json overriding smart decoder
- [x] Cleaned up Devon registry entries after devonthink-mcp → Devon rename
- [x] Built `pai session active` command — detects open Claude Code tabs via JSONL timestamps
- [x] Updated /sessions skill to show active sessions prominently
- [x] Updated FEATURE.md DEVONthink link to github.com/mnott/Devon
- [x] Committed and pushed 4 commits

*Items verified as already implemented during session 0006 code review.*

- [x] **Security review** — Grep pass: zero personal data in tracked source. All `/Users/` use example names. Templates use `${HOME}`.
- [x] **Screenshots to /tmp** — Already in `claude-md.template.md` (lines 103-108): writes to `/tmp/pai-screenshot-*.png`.
- [x] **Setup invokable by prompt (code exists)** — SKILL.md has USE WHEN triggers for "set up PAI", "install PAI", "give Claude a memory". 11-step guide with idempotent checks.
- [x] **User customizations survive PAI updates** — `update.ts` (474 lines): stash → pull → pop → build → restart → CLAUDE.md refresh (checks "Generated by PAI Setup" marker) → registry scan.
- [x] **Idempotent on reinstall (code exists)** — setup.ts checks existing files, offers merge/keep/replace for CLAUDE.md, skips already-done steps.
- [x] **Clean up "New Session.md" placeholders** — Ran `pai session cleanup pai --execute`: 11 deleted, 15 renamed, 40 moved to YYYY/MM/.
- [x] **Empty session notes after kill** — session-stop.sh calls `pai session cleanup --execute`. For SIGKILL, Claude Code hooks may not fire — platform limitation.
- [x] **Intermediate session notes** — pre-compact.sh and session-stop.sh both call `pai session checkpoint` and `pai session handover`. Writes `## Continue` to TODO.md.
- [x] **PAI collaboration on TODO.md** — Already in `claude-md.template.md` (lines 395-406): read-before-write, append-only, user owns checkboxes, atomic writes.
- [x] **SQLite vs PostgreSQL clarity** — Added storage architecture table to ARCHITECTURE.md: Registry = always SQLite, Memory = factory-switchable (SQLite simple / PostgreSQL full).
- [x] **Docker/PostgreSQL survive restart** — `docker-compose.yml` line 7: `restart: unless-stopped`. Daemon uses launchd `KeepAlive`.
- [x] **Embedding process nice** — Daemon calls `setPriority(process.pid, 10)` on startup. macOS has no ionice equivalent.
- [x] **PAI daemon indexing progress view** — `pai daemon logs` fully implemented with `-f` (follow) and `-n` (lines) options. Logs at `/tmp/pai-daemon.log`.
- [x] **PAI as first search** — Already in `claude-md.template.md` (lines 39-53): "PAI-First Search Protocol" with `memory_search → registry_search → project_info → Glob/Grep`.
- [x] **Notifications daemon-routed and mode-switchable** — Full CLI: `pai notify status`, `pai notify set --mode voice`, `pai notify set --enable macos --disable ntfy`, `pai notify test`, `pai notify send`.
- [x] **Whisper multilingual voice (code exists)** — Whisper large-v3-turbo detects language automatically. No explicit config needed.
- [x] `.claude` in git repo — `.gitignore` has `.claude/*` with `!.claude/skills/` exception.
- [x] FEATURE.md comparison — Complete (36 rows). Lives at `FEATURE.md`.
- [x] Templates — Setup skill handles CLAUDE.md template with diff/merge/skip.
- [x] Hooks for handover — pre-compact.sh and session-stop.sh call handover + checkpoint.
- [x] Session cleanup — session-stop.sh calls `pai session cleanup --execute`.

---

## Completed (Archive)

### Session 0006 — TODO Triage, Build Fixes, Session Cleanup, Full Code Review
- [x] Triaged all 20+ open questions from user into 7 categories
- [x] Fixed 4 TypeScript build errors (backup.ts, restore.ts, setup.ts, ipc-client.ts) — clean build
- [x] Security grep pass — zero personal data in tracked source files
- [x] Session cleanup — 11 empty deleted, 15 renamed, 40 moved to YYYY/MM/
- [x] Full code review: verified hooks, update.ts, setup.ts, notify CLI, daemon logs, template, docker-compose
- [x] Added storage architecture documentation to ARCHITECTURE.md
- [x] Resolved 17 TODO items that were already implemented but not marked done

### Session 0001 — PAI Session Navigator
- [x] Built `pai` CLI (1700+ lines Python, Typer + Rich)
- [x] Created `/sessions` skill with 8 workflows
- [x] Built enriched session history at `~/.claude/History/session-history.md`

### PAI Knowledge OS Phases 0-7
- [x] Phase 0: Registry SQLite, CLI, git init
- [x] Phase 1: Session slug generation, rename, registry lookup
- [x] Phase 2: BM25 memory engine (14K+ chunks)
- [x] Phase 2.5: Vector embeddings (bge-small-en-v1.5, 16K+ chunks)
- [x] Phase 3: MCP server (6 tools) registered in ~/.claude.json
- [x] Phase 4: Obsidian bridge (symlinks + topic pages)
- [x] Phase 5: Project lifecycle (promote, move, archive)
- [x] Phase 6: Setup wizard + session cleanup
- [x] Phase 7: Public repo preparation (npm publish as @tekmidian/pai, GitHub)
- [x] Session Router skill (/route command, vector search, auto-route on session start)
- [x] Topic shift detection (BM25 scoring)
- [x] Unified notification framework (ntfy, WhatsApp, macOS, CLI)
- [x] Session handover command (## Continue in TODO.md)
- [x] PAI.md marker file system with YAML frontmatter
- [x] FEATURE.md comparison with Daniel Miessler's Fabric

### Companion Projects
- [x] Whazaa — WhatsApp bridge (IPC architecture, TTS, voice notes, screenshots, /sessions)
- [x] Coogle — Google Workspace MCP daemon (Gmail, Calendar, IPC multiplexing)
- [x] DEVONthink MCP — 28 upstream + 5 custom tools, published @tekmidian/devonthink-mcp
- [x] Statusline — context meter, MCP names, published with PAI@0.2.0
- [x] Fabric migration — native pattern execution, YouTube via Scribe MCP

---

## Key Artifacts

| What | Where |
|------|-------|
| PAI source | `/Users/i052341/dev/ai/PAI/` (dev copy) or `/Users/i052341/Daten/Cloud/Development/ai/PAI/` |
| PAI CLI | `pai` → `dist/cli/index.mjs` |
| PAI daemon | `dist/daemon/index.mjs` (launchd: `com.pai.pai-daemon`) |
| PAI MCP shim | `dist/daemon-mcp/index.mjs` (registered in `~/.claude.json`) |
| PAI registry | `~/.pai/registry.db` (SQLite) |
| Setup skill | `.claude/skills/setup/SKILL.md` |
| Hooks | `src/hooks/pre-compact.sh`, `src/hooks/session-stop.sh` |
| Templates | `templates/claude-md.template.md`, `templates/pai-project.template.md` |
| Notifications | `src/notifications/` (router.ts, 4 providers) |
| FEATURE.md | `FEATURE.md` (36-row comparison with Fabric) |
| Whazaa source | `~/dev/ai/Whazaa/` |
| Coogle source | `~/dev/ai/coogle/` |
| DEVONthink MCP | `~/dev/ai/Devon/` |

---
*Links:* [[Ideaverse/AI/PAI/Notes/Notes|Notes]]

---

*Last updated: 2026-04-13T06:43:37.776Z*
