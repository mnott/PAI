# Architecture Decisions

**PAI Knowledge OS** | Captured 2026-03-13

---

## Overview

This document records key architecture decisions made during a design session on 2026-03-13. Each decision is recorded in Architecture Decision Record (ADR) format with context, rationale, and status.

---

## ADR-001: Monetization via Encrypted Module Loading (Level 4 Protection)

**Status:** Decided

### Context

PAI ships open source code via npm. Premium features (semantic search, observability, zettelkasten, creative) need protection beyond honor-system feature flags, which are trivially patched. A "check to patch out" if statement provides no real protection - an attacker just removes the branch.

### Decision

Premium modules ship as AES-256 encrypted blobs inside the npm package. The JavaScript source code for premium features does not exist in the package - only encrypted binary data.

**How it works:**

1. Paying users receive a signed JWT containing the AES decryption key for the current published version.
2. The daemon decrypts premium modules in memory only - no decryption to disk, no plaintext file ever written.
3. Decrypted code is loaded via Node's VM module or dynamic import from a data URL.
4. Keys expire every 30 days. The daemon calls a lightweight refresh endpoint (subscription validation only - no server-side computation of user features).
5. Local-first philosophy is fully preserved: all computation happens on the user's machine.

**Accepted tradeoff:** Someone who pays for one month and extracts the in-memory decrypted code gets a frozen snapshot with no future updates. This is acceptable - they paid for one month, they get one month of value.

### Rationale

The protection spectrum runs from "flag you patch out" to "code that does not exist until the key builds it." AES-256 in-memory loading lands near the strong end of that spectrum. No JavaScript to decompile, no if statement to remove. The only attack surface is memory extraction during runtime, which requires elevated privileges and targeted effort - a sufficient deterrent for a developer tool.

Key refresh keeps honest subscribers honest without requiring a persistent server connection for every feature invocation.

---

## ADR-002: Repository Split

**Status:** Decided

### Context

Premium module source code must never appear in public git history. A single public repository cannot hold both open source code (community-visible, forkable) and premium code (proprietary, encrypted on publish).

### Decision

Two Git repositories:

- **Public:** github.com/mnott/PAI - open source core, MIT licensed, community-visible (stars, issues, pull requests)
- **Private:** hosted on Matthias Nott's personal Git server - premium module source code, full version history

Two npm packages, both published publicly on npm:

- **@tekmidian/pai** - core package, unencrypted TypeScript, MIT license
- **@tekmidian/pai-pro** - premium package, encrypted blobs, useless without a valid license key

No private npm tokens or scoped registry needed. Anyone can run `npm install @tekmidian/pai-pro`. Nobody can use it without paying for a key. Obscurity is not the protection - encryption is.

**Installation flow:**

```
npm install @tekmidian/pai          # free, works immediately
npm install @tekmidian/pai-pro      # optional, installs encrypted blobs
pai activate <key>                  # unlocks premium features
```

Build pipeline: single private repository produces two npm outputs. The public repository receives only the core output.

**Clean start:** The existing GitHub repository (github.com/mnott/PAI) and npm package (@tekmidian/pai) will be wiped and re-initialized at v0.1.0. No external users exist yet, so no migration burden.

### Rationale

Public packages on npm remove all friction for potential users evaluating the product. The encryption barrier (not a registry barrier) is what separates free from paid. Community contributions flow through the public repo. Premium development stays private. The two-output build pattern is straightforward: one source of truth, two published artifacts.

---

## ADR-003: Multi-Tenancy from Day One

**Status:** Decided

### Context

Single-user local tools commonly defer multi-tenancy until paying customers demand it. Schema migrations on production databases with real user data are painful, risky, and often incomplete. PAI has a credible path to team and enterprise use - delaying multi-tenancy means a future migration under customer pressure.

### Decision

Every database table gets a `tenant_id` column (UUID) from the initial schema. This applies to both PostgreSQL (memory and embeddings storage) and SQLite (local registry). A default tenant is auto-generated at setup time for single-user installations - the user never sees or touches it.

All queries include `WHERE tenant_id = current_tenant`. All indexes become composite on `(tenant_id, existing_index_columns)`.

**Four-level growth path:**

| Level | Description | Target |
|-------|-------------|--------|
| Level 1 | Single user, single machine, multiple sessions | v0.1 |
| Level 2 | Single user, multiple machines (remote database) | future |
| Level 3 | Multiple users, shared knowledge (team tenant) | future |
| Level 4 | Federated PAI instances querying each other | future |

### Rationale

Adding `tenant_id` to every table at schema creation costs nearly nothing - one column, one index, one filter clause. Retrofitting it later into a live production schema with real customer data is a multi-week project with downtime risk. The asymmetry is clear: pay a small cost now or a large cost later. The four-level model provides a concrete roadmap so the schema can be validated against future use cases today.

---

## ADR-004: Content Storage Architecture

**Status:** Decided

### Context

PAI currently treats the filesystem as the source of truth for all content. Session notes, project files, and indexed documents all live on disk. This model works for single-user local use but does not extend to shared team knowledge or multi-machine sync.

### Decision

Three content storage modes. Each project declares its mode via an `origin` field:

- **filesystem** (default): Files on disk are the source of truth. The database is a search index and cache. This is the current model. No behavioral change for existing users.
- **database**: The database is the source of truth. Files are exports and views. Used for shared or team content where multiple machines need access to the same data.
- **vault**: An Obsidian vault is the source of truth. The database maintains bidirectional sync with the vault.

**Shared knowledge** flows through the database, not through filesystem sharing (no shared network drives, no Dropbox folders full of markdown files).

Chunks are stored with `tenant_id` and a visibility flag (`private` or `shared`). File metadata stores the original filesystem path as context, but chunk content is self-contained so it remains usable without filesystem access (necessary for multi-machine and team scenarios).

Session notes can live in any mode: filesystem for project-specific notes, database mode for shared team knowledge.

### Rationale

The filesystem mode preserves full backward compatibility and the local-first guarantee for individual users. The database mode is the bridge to collaboration without requiring filesystem sharing. The vault mode honors the significant investment many users have in Obsidian-based knowledge systems. Declaring mode per-project rather than globally allows gradual migration and mixed deployments.

---

## ADR-005: Federation Model (Business Objects Inspired)

**Status:** Decided

### Context

Remote and shared database access requires offline capability. A tool that stops working when the network is unavailable is not a professional tool. The architecture needs a sync model that handles disconnected operation gracefully.

### Decision

Each local PAI instance maintains a replica of the user's tenant data. The user works against the local replica at all times. When online, the replica syncs with the remote database.

**Inspired by:** SAP Business Objects Crystal Reports platform architecture - specifically the concept of incoming and outgoing file repositories for data federation.

Sync operates at the database level with conflict resolution using last-write-wins with a conflict archive (conflicting versions are preserved, not discarded).

The `content` table stores full documents alongside chunks:

```
content_id      UUID, primary key
tenant_id       UUID, foreign key
content_type    text (session-note, project-file, vault-note, ...)
full_text       text
metadata_json   jsonb
created_at      timestamp
updated_at      timestamp
sync_status     text (local, synced, conflict)
```

### Rationale

Local replica means zero latency for all reads and writes. Sync is background and non-blocking. The conflict archive prevents data loss in concurrent edit scenarios. Storing full documents (not just chunks) in the content table enables the system to reconstruct context without requiring filesystem access - essential for multi-machine scenarios where the original file may not exist on the current machine.

---

## ADR-006: Conversation as Knowledge (Meeting Minutes Model)

**Status:** Implemented (v0.7.3)

### Context

Current session notes capture outcomes: "wrote cover letter", "modified 3 files". They do not capture reasoning: why this approach was chosen, what alternatives were considered and rejected, what the user's actual intent was. The reasoning is often more valuable than the artifact. A meeting without minutes loses its institutional knowledge. A Claude Code session without reasoning capture loses the thinking that produced the output.

### Decision

The daemon accesses Claude Code's JSONL conversation transcript, which is written in real time to `.claude/projects/` during every session.

An AI-powered summarization step extracts discussion-quality content from the raw transcript:
- Decisions made and their rationale
- Reasoning chains and problem-solving approaches
- Rejected alternatives and why they were rejected
- User intent (the goal behind the request, not just the request)

Summarization uses a headless Claude Code session with the Haiku model (covered by Max plan subscription - no additional API cost).

Result: session notes read like meeting minutes, not action item lists.

### Rationale

The JSONL transcript already exists on disk - Claude Code writes it automatically. This is not new data collection; it is mining existing data. Headless Haiku is cheap (Max plan covers it) and sufficient for summarization tasks. The meeting minutes framing is the right mental model: a summary that captures "we decided X because Y, we rejected Z because it would require W" is dramatically more useful for future context recovery than "session ran for 47 minutes, produced 2 files."

---

## ADR-007: Daemon as Session Lifecycle Owner

**Status:** Implemented (v0.7.1 — work queue; v0.7.3 — session summaries)

### Context

Current hooks do meaningful work synchronously: they write session notes, update TODOs, run summarization. This means the user waits at session boundaries. A hook that takes 30 seconds to summarize a long session is a 30-second user-visible pause.

### Decision

Hooks become thin relays: fire, grab the minimal required data, push to the daemon socket, exit immediately. The daemon owns the work queue.

**Daemon responsibilities:**
- Session summaries (AI-powered, asynchronous)
- Note file creation and updates
- TODO file updates
- Topic detection and session boundary detection

**Work queue:** Persisted to disk. The daemon can restart and resume pending work without losing queue items. Housekeeping prevents unbounded backlog accumulation.

**Headless Claude Code spawning:** The daemon spawns headless Claude Code sessions (Haiku model) for AI tasks. These are fire-and-forget subprocesses managed by the daemon, not by hooks.

**User experience:** "End session" completes in under one second from the user's perspective. All background processing continues after the session ends. The user is never blocked by cleanup.

### Rationale

Separating "trigger" (hook) from "work" (daemon) is the standard pattern for reliable background processing. Persisting the work queue to disk adds crash recovery with minimal complexity. The latency improvement is significant: sub-second vs. potentially 30+ seconds for long sessions. Users who immediately start a new session after ending one are not blocked by the previous session's cleanup.

---

## ADR-008: Topic-Based Sessions (Auto-Detection)

**Status:** Implemented (v0.8.0 — Jaccard-based splitting; embedding-based detection deferred)

### Context

Current sessions are manually bracketed: the user explicitly runs "start session" and "end session". This is friction. It also assumes the user knows when a topic shift has occurred, which requires conscious attention to session management instead of the actual work.

### Decision

Sessions are no longer manually bracketed. Sessions are topic-based: one coherent unit of work about one subject.

**Detection mechanism:** Embedding similarity between the current activity vector and the established session topic vector. When cosine similarity drops below a configurable threshold, a topic boundary is detected.

On topic boundary detection:
1. Current session is auto-summarized and closed (daemon handles this asynchronously)
2. New session is auto-opened
3. User is notified (non-blocking, informational)

**Tier differentiation:**
- Free (v0.1): embedding-based detection (fast, local, no AI cost)
- Pro and above: headless AI detection (richer semantic understanding, can distinguish "working on feature X in project Y" from "asking a question about unrelated topic Z")

### Rationale

Embedding-based detection is already available (PAI has an embeddings pipeline). The similarity calculation is fast and runs entirely locally with no AI cost. Manual session management is cognitive overhead that conflicts with the goal of a tool that "just works." Automatic detection removes that overhead. The Pro tier upgrade (headless AI detection) handles edge cases where embedding similarity alone gives false positives (e.g., asking a clarifying question in the middle of a long work session).

---

## ADR-009: Testing Strategy

**Status:** Decided

### Context

PAI modifies system-level configuration: shell profiles, Claude Code settings, daemon startup, database initialization. A bug in the setup flow on a developer's machine that already has PAI installed is invisible until a new user hits it. Integration tests against an existing installation are not reliable proxies for the new-user experience.

### Decision

A separate macOS user account on the development laptop serves as a clean sandbox. This account has a fresh home directory with no `.claude`, no PAI configuration, and no running daemon.

**Test script flow:**
1. Create the test user
2. Install Bun
3. Install Claude Code
4. Run `pai setup` from scratch
5. Verify all components initialized correctly

This test runs as part of the release checklist for every version before publishing to npm.

**Database testing:** A single PostgreSQL Docker container serves both the primary user (`pai` database) and the test user (`pai-test` database). Multi-user isolation is tested at the database level through separate database names, not separate containers.

### Rationale

The only reliable test of a setup flow is running it on a clean system. A separate OS user provides that guarantee without requiring a dedicated test machine or VM. The Docker multi-database pattern tests the multi-tenancy assumptions cheaply. Running this as a mandatory release gate (not an optional check) ensures the new-user experience is validated on every release.

---

## ADR-010: Clean Start Plan

**Status:** Decided

### Context

The current public GitHub repository (github.com/mnott/PAI) contains version history that predates the architecture decisions documented here. The current npm package (@tekmidian/pai) is at v0.7.0 with no external users. Continuing from the current state means carrying forward architecture decisions that have since been superseded and a version number that implies maturity the product does not yet have.

### Decision

**Wipe and restart:**

1. Delete the public GitHub repository content and re-initialize with a clean git history
2. Unpublish the @tekmidian/pai npm package
3. Create a private repository on Matthias Nott's personal Git server for premium module source code
4. Publish fresh at v0.1.0

**Invariants:**
- No premium source code ever appears in public git history (not even in an early commit)
- The private repository is the single source of truth for the full codebase
- The public repository receives only the open source core output

### Rationale

No external users exist on the current package. The cost of a clean start is zero user disruption and a small amount of local work. The benefit is a clean public history that starts from the right architecture, a version number that accurately represents the product's maturity, and no risk of premium code leaking through historical git objects. Starting at v0.1.0 also sets accurate expectations for early adopters.

---

## ADR-011: Whisper Rules — Persistent Rule Injection via UserPromptSubmit

**Status:** Implemented (v0.7.7)

### Context

Critical operating rules defined in `CLAUDE.md` (no email sending, git commit format, no API key exposure) are lost when Claude Code compacts its context window or when the user runs `/clear`. There is no built-in mechanism to make rules permanent across these events. Users discovered that important constraints were silently dropped mid-session.

### Decision

A `UserPromptSubmit` hook (`whisper-rules.mjs`) reads `~/.claude/whisper-rules.md` and injects its contents as a system reminder on every user prompt submission, before Claude processes the message. The rules fire unconditionally — no session state is required.

The implementation is inspired by [Letta's claude-subconscious](https://github.com/letta-ai/letta) pattern for persistent rule injection in Claude environments.

**Key properties:**
- Fires on every prompt, not just session start
- Survives compaction (UserPromptSubmit fires post-compaction)
- Survives `/clear` (new sessions trigger it immediately on the first prompt)
- User-customizable: edit `~/.claude/whisper-rules.md` to change the rules
- Zero overhead: file read is fast; injection payload is small

### Rationale

Session start hooks only fire once per session. A rule injected at session start can be forgotten by the model after a long conversation or a compaction event. `UserPromptSubmit` fires before every model invocation, making it impossible for rules to drift out of context. The file-based approach (`~/.claude/whisper-rules.md`) gives users a single, discoverable location to manage their persistent rules without editing hook source code.

---

## ADR-012: API Key Stripping for Headless Claude CLI Processes

**Status:** Implemented (v0.7.8)

### Context

The daemon spawns headless Claude CLI processes for AI-powered session summarization (via `session-summary-worker.ts`). The daemon process inherits `ANTHROPIC_API_KEY` from its environment. When Claude CLI finds an API key, it uses the Anthropics API directly — every summarization invocation incurs API billing charges. Users with Max plan subscriptions (which include free Claude usage) were being charged for summarizations that should be free.

### Decision

Before spawning any headless Claude CLI subprocess, `session-summary-worker.ts` deletes `ANTHROPIC_API_KEY` from the subprocess environment:

```typescript
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
// spawn Claude CLI with env
```

Without an API key, Claude CLI authenticates via the Max plan session (browser-based OAuth stored in `~/.claude/`). This uses the subscription entitlement rather than the API metered billing path.

### Rationale

Users who pay for a Max plan subscription expect that their AI assistant tool uses that subscription for all Claude operations. Silently using the API key (and incurring per-token charges) when a Max plan subscription covers the same operations is a violation of the principle of least surprise. The fix is minimal, correct, and has no user-visible downside: Max plan users see zero charges, API-key-only users (without a Max plan) will need to ensure Claude CLI is configured for their authentication method, but the PAI installation documentation covers this.

---

## ADR-013: One Session Note Per Topic (Jaccard Splitting)

**Status:** Implemented (v0.8.0)

### Context

Early implementations of automatic session notes created one note per compaction event. In a long session with many compactions, this produced 10-15 nearly-identical notes covering the same work — cluttering the Notes directory and degrading search quality (duplicate chunks compete in ranking). At the same time, sessions that genuinely shift topics (starting with UI work, ending with backend refactoring) should produce separate notes, not one long note that covers everything.

### Decision

The session summary worker outputs a `TOPIC:` line as the first line of every summary. This line describes the subject of the current work in 60 characters or fewer.

When writing a session note, the worker compares the `TOPIC:` value against the existing session note's title using Jaccard word similarity (intersection over union of word sets, stop words excluded). The threshold is 30%:

- Similarity >= 30%: update the existing note (same topic, continuation of prior work)
- Similarity < 30%: create a new note with the next sequential number

Notes within the same day are numbered sequentially using the existing PAI session numbering system. A garbage-title filter (20+ rejection patterns) prevents non-descriptive artifacts from becoming note titles.

### Rationale

Jaccard similarity is cheap to compute (no embeddings required), interpretable, and robust enough for the task. A threshold of 30% catches genuine topic shifts (UI vs. backend, project A vs. project B) while tolerating rephrasing of the same topic ("database indexing" and "indexer performance" share enough words to stay above threshold). The 20+ garbage title patterns catch the most common artifacts from JSONL transcripts without requiring an AI classification step for every note creation.

---

---

## ADR-014: Four-Layer Wake-Up Context

**Status:** Implemented (v0.8.6)
**Inspired by:** [mempalace](https://github.com/milla-jovovich/mempalace) by milla-jovovich

### Context

Every PAI session starts cold from Claude's perspective. Session notes and indexed memory exist, but without a structured loading strategy, the model either gets too little context (answering questions without relevant history) or too much context (flooding the window with everything indexed, inflating token cost and diluting signal).

Two failure modes exist: under-loading (Claude doesn't know what it should know) and over-loading (Claude knows too much at once, and the useful signal is buried). The mempalace project demonstrated that a layered loading strategy resolves both failure modes.

### Decision

Context loads in four layers, triggered by the `memory_wakeup` MCP tool (called automatically by the `SessionStart` hook):

- **L0 — Identity:** `~/.pai/identity.txt` — stable, always loaded, describes who the user is, their style, key projects. Small and fixed; never exceeds a few hundred tokens.
- **L1 — Essential story:** The most recent N session notes (configurable via `wakeupL1Count`). Gives Claude recent work history without loading the entire archive.
- **L2 — Topic queries:** On-demand retrieval for the current conversation topic. The model calls `memory_search` with a focused query when a specific question requires more context.
- **L3 — Deep search:** Full `memory_search` with cross-encoder reranking, invoked when L2 is insufficient or the user explicitly asks for a deep lookup.

L0 and L1 are injected eagerly. L2 and L3 are lazy — the model decides when to go deeper.

### Consequences

- Sessions start faster (L0+L1 are small and cheap) while still having meaningful context
- The model does not need to be told what it knows — L1 gives it a working summary
- Token budget is used proportionally to the complexity of the session, not front-loaded
- `~/.pai/identity.txt` is the single place where the user can define their permanent context

---

## ADR-015: Temporal Knowledge Graph with valid_from / valid_to

**Status:** Implemented (v0.8.6)
**Inspired by:** [mempalace](https://github.com/milla-jovovich/mempalace) by milla-jovovich

### Context

PAI's memory system accumulates facts over time. The problem is that facts change: a person changes jobs, a technology stack gets replaced, a project changes direction. Without time-bounding, the knowledge graph accumulates contradictions with no way to resolve them — old facts compete with new ones in search results, and Claude cannot tell which version is current.

Flat, undated knowledge storage fails in practice because the world changes and accumulation without expiry becomes noise.

### Decision

A `kg_triples` table stores subject-predicate-object triples with `valid_from` and `valid_to` timestamps:

```sql
kg_triples (
    id UUID, tenant_id UUID,
    subject TEXT, predicate TEXT, object TEXT,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to   TIMESTAMPTZ,    -- NULL = currently valid
    confidence REAL DEFAULT 1.0,
    source TEXT
)
```

Four MCP tools cover the lifecycle: `kg_add`, `kg_query`, `kg_invalidate`, `kg_contradictions`.

`kg_query` defaults to the current timestamp, so by default only currently-valid facts are returned. Historical queries are possible by passing an explicit `as_of` timestamp. `kg_contradictions` uses predicate inversion rules to identify triples that directly conflict within overlapping validity windows.

### Consequences

- Facts can be superseded without deletion — history is preserved
- Historical queries are possible (what did we believe in March?)
- Contradiction detection surfaces when old and new facts overlap without proper invalidation
- The knowledge graph grows but remains queryable and interpretable over time

---

## ADR-016: Mid-Session Auto-Save via Stop Hook

**Status:** Implemented (v0.8.6)
**Inspired by:** [mempalace](https://github.com/milla-jovovich/mempalace) by milla-jovovich

### Context

The session-summary pipeline (ADR-007) runs at session end: the Stop hook pushes a work item to the daemon, which spawns a headless Claude process to summarize the JSONL transcript. This works well for sessions that complete normally. It does not protect against sessions that run for many hours, sessions interrupted by system crashes, or very long sessions where context drifts significantly from the early work.

A session that runs for 200 human messages has very different early-session and late-session content. A single summary at the end may not capture the full arc of work accurately.

### Decision

The Stop hook tracks the number of human messages in the current session. Every N messages (default 15, configurable via `PAI_AUTO_SAVE_INTERVAL` or `autoSaveInterval` in `config.json`), the hook:

1. Pushes a `session-summary` work item to the daemon
2. Returns a `continue: true` response to Claude Code, blocking the Stop event and keeping the session alive

This produces incremental session notes during long sessions, not just at the end.

**Loop prevention:** The `session-summary` work item includes a `stop_hook_active: true` flag. The daemon checks this flag before processing: if set, it does not re-enqueue a save for the same session within the cooldown window. This prevents the save from triggering another Stop event.

### Consequences

- Long sessions get periodic snapshots even if they run for hours
- Interrupted sessions lose at most N messages of work (not the entire session)
- The daemon's existing cooldown logic (30-minute minimum between summaries) still applies, so rapid-fire stops do not overwhelm the queue
- Setting `PAI_AUTO_SAVE_INTERVAL=0` disables the feature entirely

---

## ADR-017: Cross-Project Tunnel Detection

**Status:** Implemented (v0.8.6)
**Inspired by:** [mempalace](https://github.com/milla-jovovich/mempalace) by milla-jovovich

### Context

PAI indexes content from many projects. Projects are treated as independent silos: you search within a project or across all projects, but there is no mechanism to surface concepts that meaningfully connect multiple projects. These cross-project concept bridges — the same design pattern appearing in two codebases, a vendor name appearing in both session notes and job applications — are often the most interesting insights the memory system could surface, but they are invisible to per-project search.

### Decision

The `memory_tunnels` MCP tool detects cross-project concepts using FTS vocabulary analysis:

- **SQLite mode:** Queries the FTS5 `vocab` virtual table to extract per-project term frequencies. Terms that appear significantly (above a frequency threshold) in three or more distinct projects are candidates.
- **PostgreSQL mode:** Uses `ts_stat()` on each project's indexed `tsvector` content to extract term frequencies, then cross-compares across projects using the same threshold.

Results are returned as ranked concept-tunnel pairs: the concept text, the list of projects it appears in, and a tunnel strength score (normalized, IDF-weighted, scaled by the number of participating projects).

**Tunnel strength formula:**

```
strength = mean_tf_idf_across_projects * log(participating_project_count + 1)
```

Normalization ensures that very common English words (which appear in every project) score low despite high frequency.

### Consequences

- Users can discover unexpected connections between projects they thought of as separate
- The model can use tunnels as a starting point for synthesis across projects
- Performance is acceptable for typical PAI installations (hundreds of projects, hundreds of thousands of chunks) because the analysis runs on pre-computed FTS indexes, not raw text
- Tunnel detection runs on demand (via `memory_tunnels`), not continuously, to avoid index overhead

---

## Document History

| Date | Event |
|------|-------|
| 2026-03-13 | Initial capture from architecture design discussion. All 10 decisions recorded. Author: Matthias Nott. Transcribed by AI assistant. |
| 2026-03-24 | Added ADR-011 (whisper rules), ADR-012 (API key stripping), ADR-013 (topic-based note splitting). Updated ADR-006/007/008 status to "implemented" in prior sections. |
| 2026-04-07 | Added ADR-014 (four-layer wake-up context), ADR-015 (temporal knowledge graph), ADR-016 (mid-session auto-save), ADR-017 (cross-project tunnel detection). All four inspired by mempalace. |
