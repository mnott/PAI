# Changelog

All notable changes to PAI Knowledge OS are documented here.

---

## [Unreleased]

### Added

- **Machine-wide fallback** — `pai worker fallback on [provider]` switches
  every NEW Claude Code process on the machine (interactive sessions,
  task-bus sessions, the daemon's headless summarizer) to a worker provider
  when the Anthropic plan runs out, until `pai worker fallback off`. `on`
  writes the provider's base URL, token (read from its key file at switch
  time — it then sits in settings.json until `off`), the three
  `ANTHROPIC_DEFAULT_*_MODEL` pins, its extra env, `ENABLE_TOOL_SEARCH` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` into the `env` block of
  `~/.claude/settings.json` and pins the top-level `model`; the replaced
  values are saved under `workers.fallback.saved` in the pai config and
  `off` restores settings.json exactly. `fallback status` reports the state,
  lists running Claude Code sessions (AIBroker registry when populated, else
  `ps` — running sessions keep their provider until restarted) and the
  `FALLBACK-ACTIVE.md` note `on` leaves in the workers log dir. The settings
  path is overridable via `CLAUDE_SETTINGS_PATH` for dry runs; the Agent
  hook keeps routing subagents to workers while on. MCP `worker_fallback`
  (on/off/status) and the Worker skill phrases ("switch everything to glm",
  "fallback on", "back to anthropic", "fallback off", "is fallback on").

## [0.38.0] — 2026-09-17

### Added

- **Task classes** — roles became classes: `workers.classes` maps the nine
  standard task classes (draft, plan, implement, review, research, spotcheck,
  simple, complex, image) to a provider, `provider/fast`, or an object with
  routing constraints. Providers carry `costTier` (1 cheapest … 5, default 3)
  and `tags` (code, vision, image-gen, long-context, fast, reasoning); a class
  may set `maxCostTier`, `requireTags` and its own `order`, and auto-routing
  fails with the exclusion reason of every provider when nothing qualifies.
  `--class` replaces `--role` (kept as alias); `pai worker classes
  list/set/unset` manages them; old `roles` configs keep parsing and migrate
  to `classes` on first write.
- **Chains** — `pai worker run --chain draft,implement[,review]`: the draft
  stage turns the brief into a spec file under `<logDir>/specs/<chain id>.md`
  (goal, constraints, files likely touched, acceptance checks, verification
  commands), implement runs with that spec plus the original brief, review
  reads the diff against the spec and produces the structured report. Each
  stage is its own worker (own id and pane, `parent` set to the chain id);
  `ps` shows chains as trees; a failed stage (or a draft without a spec)
  stops the chain.
- **Agent definitions as workers** — `pai worker run --agent <name>` loads
  `~/.claude/agents/<name>.md`: the body becomes `--append-system-prompt`,
  `tools` the allowlist, `model` maps to a class (haiku→simple, sonnet→
  implement, opus→complex) unless `--class` is given; the label defaults to
  `<agent>: <first 50 chars of prompt>`.
- **MCP `worker_classes`** (list/set/unset, with `max_cost_tier`/
  `require_tags`) and **MCP `worker_run`** — start a worker or chain from
  chat, returning the id immediately. `worker_providers` gained `cost_tier`/
  `tags` on add and an `update` action. The Worker skill maps preference
  phrases ("route research to X", "cheap only for drafts", "show the routing
  table") onto these tools and never sends the user to a config file.

- **Chat line in the follow pane** — `pai worker follow <id>` on a TTY is a
  chat, not a tail: the transcript scrolls in an ANSI scroll region, the
  prompt row (`› `, readline editing) and the ticker row stay fixed, and
  Enter says the line to the running worker or resumes the finished one
  (the pane follows the fresh run). Commands `/help`, `/quit`,
  `/resume <text>`, `/status`; Ctrl-C leaves on an empty prompt and clears a
  draft, Ctrl-D leaves; the echoed `»` row appears once (the mirrored
  operator event is swallowed); the auto-exit countdown holds while the
  prompt has unsent text. Non-TTY output keeps the plain behaviour.

### Changed

- **Worker ids no longer collide** — two workers or chains starting in the
  same second of one process get a monotonic `-01`, `-02` suffix instead of
  overwriting each other's status and transcript files.
- **Viewer-side wrapping with an unbroken gutter bar** — `follow`/`replay`
  wrap rows at the terminal width (whitespace-preferred, hard-wrap fallback,
  ANSI escapes never split, diff colours carried onto continuation rows),
  and every continuation row carries a blank-time gutter that keeps the `│`
  bar, so no content lands left of it. Piped output keeps the terminal's own
  wrapping.

## [0.37.0] — 2026-09-17

### Added

- **Worker providers** — subagents run on endpoints you configure (any
  Anthropic-compatible API, any OpenAI-compatible API, or the Codex CLI)
  instead of the main session's Anthropic account.
  Typed `workers` section in `~/.config/pai/config.json`; `pai worker` CLI
  group (run, ps, follow, replay, pane, log, status-line, providers, roles,
  on/off, install); MCP tools `worker_status`, `worker_providers`,
  `worker_roles`, `worker_toggle`, `worker_ps`, `worker_replay`. A PreToolUse
  hook denies the Agent tool and rewrites delegation to `pai worker run`
  (bypass: `ALLOW_ANTHROPIC_AGENTS=1` or `pai worker off`). Provider routing
  with roles, cooldowns, quota probes and automatic rerouting; per-worker
  status files, an append-only ledger, iTerm follow panes, and a status-line
  entry. The glm/glm-run/glm-ps/glm-log commands survive as shims
  (`pai worker install` migrates and moves previous versions to
  `<name>.pre-pai`).
  See [docs/worker.md](docs/worker.md).

- **Worker proxy for OpenAI-protocol providers** — providers with
  `protocol: "openai"` + `upstreamUrl` run through a built-in translating
  proxy (Anthropic Messages API in, OpenAI Chat Completions out): system,
  multi-turn text, tool_use/tool_result ↔ tool_calls, tools ↔ functions,
  streaming SSE with streamed tool-call arguments, usage and error mapping.
  Loopback only, started on demand by `run` (pid file under the logDir),
  managed by hand with `pai worker proxy [--port N|stop]`; the config is
  re-read per request. The worker holds a placeholder token; the real one
  stays inside the proxy. `providers test` goes through it.

- **Codex engine for workers** — a provider with `engine: "codex"` runs
  `codex exec --json` instead of Claude Code; its JSONL events are folded
  into the same status fields, transcript shape and final print. Flags with
  no Codex equivalent (`--allowedTools`, MCP) are dropped with a ledger
  note; `providers test` reports `codex not installed` when the CLI is
  missing.

- **Stamped transcripts, gutter and liveness** — every mirrored event in
  `<id>.jsonl` carries an ISO `_ts`; `follow`/`replay` render a dim
  `HH:MM:SS │ ` gutter (worker-tagged when several run at once, day
  separator on rollover), and a TTY liveness line
  `⋯ <n>s since last event · <last action>` overwritten in place.

- **The worker contract** — headless runs append a system prompt fixing the
  final answer: one JSON message with `changed`/`commands`/`checks`/`open`/
  `notes`. The runner parses it (notes become the table's one-liner,
  `--output-format json` gains a `report` field) and the viewer renders it
  as a compact block. A caller's `--append-system-prompt` is applied
  alongside. Panes count down `pane.autoExitSecs` (now default 60).

- **say / resume** — headless runs keep stdin open (`--input-format
  stream-json`): `pai worker say <id> "<text>"` (or `worker_say`) forwards a
  message over the per-worker Unix socket while it runs, mirrored as `»`
  operator events; after the result, stdin closes 2 s later unless another
  message arrives. `pai worker resume <id> "<text>"` (or `worker_resume`)
  continues the same Claude session on the same provider (`↩ <label>`); a
  `follow` pane reads its own stdin the same way.

- **Context meter and worker MCP allowlist** — status files track
  `contextTokens`/`contextWindow` (init event, provider `contextWindow`, or
  200k); the `ps` table and status line show `ctx 84k/200k (42%)` past 60 %
  (yellow >70, red >85), the pane liveness always. Headless workers start
  with no MCP servers by default (server definitions cost context and
  startup); opt in per run with `--mcp office` / `--mcp memory,github` or a
  role's `"mcp": [...]`, expanded from `workers.mcpSets` + `~/.claude.json`
  into a filtered `<id>.mcp.json`; unknown names fail fast;
  `pai worker mcp list` shows what exists. Pane commands are now
  `exec pai worker follow …` (one process, direct signals).

### Fixed

- **Worker follow panes never got their profile** — reading iTerm's
  preferences went through `plutil -convert json` on the whole plist, which
  refuses real iTerm preferences (they contain `<date>` objects:
  "Invalid object in plist for JSON format"), so the `pai-worker` dynamic
  profile was never written and panes opened with the default profile. The
  read now uses key-scoped `plutil -extract`; and when the preferences
  cannot be read at all, the profile is still written — font
  `Menlo-Regular <fontSize>`, no parent, reason on stderr once — instead of
  being skipped.

### Changed

- **`workers.pane.fontScale` → `workers.pane.fontSize`** (default 13) — the
  pane profile's font is the default profile's family at that point size
  (`MesloLGLNFM-Regular 13` on a machine whose default is
  `MesloLGLNFM-Regular 18`) rather than a scaled size. A legacy `fontScale`
  value in the config is tolerated and ignored. `pai worker pane <id>
  --check` now also prints the profile file's path, whether it exists, and
  the font it contains or would write.

---

## [0.8.6] — 2026-04-07

### Added

- **4-layer wake-up context** — `memory_wakeup` MCP tool loads identity (L0, from `~/.pai/identity.txt`), essential story (L1, from recent session notes), with on-demand topic queries (L2) and deep search (L3) available during the session. Called automatically by the `SessionStart` hook. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Temporal knowledge graph** — New `kg_triples` table with `valid_from`/`valid_to` timestamps. Four MCP tools: `kg_add` (add a time-bounded fact), `kg_query` (query facts valid at a given point in time), `kg_invalidate` (expire a fact), `kg_contradictions` (surface conflicting facts). Facts can now evolve over time rather than accumulating as an undated flat store. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Memory taxonomy** — `memory_taxonomy` MCP tool returns a structured overview of all indexed content: per-project session and chunk counts, embedding coverage, and recent activity. Useful as both a user-facing status tool and a model-facing context signal. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Mid-session auto-save** — The Stop hook now fires a session-summary work item every 15 human messages (configurable via `PAI_AUTO_SAVE_INTERVAL` env var or `autoSaveInterval` in `config.json`). Returns `continue: true` to block the Stop event and keep the session running. A `stop_hook_active` flag on the work item prevents save loops. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Cross-project tunnel detection** — `memory_tunnels` MCP tool detects concepts shared across multiple projects by comparing FTS vocabulary (SQLite: FTS5 `vocab` virtual table; PostgreSQL: `ts_stat()`). Returns ranked concept-tunnel pairs with a tunnel strength score. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

### Previously shipped (v0.8.5) — credited here for completeness

- **God-note detection** (`zettel_god_notes`) — Surfaces notes with disproportionately high in-degree link counts. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Confidence tagging on vault links** — The `vault_links` table carries a `confidence` column on each directed link. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Query feedback loop** — Queries and results are logged to `~/.config/pai/queries/` to improve future retrieval. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Community detection** (`zettel_communities`) — Louvain community detection partitions the vault link graph into thematic clusters. Inspired by [graphify](https://github.com/safishamsi/graphify), which uses the Leiden algorithm.

---

## [0.8.0] — 2026-03-24

### Added

- **Topic-based note splitting** — The session summarizer now outputs a `TOPIC:` line. PAI compares this against the existing session note title using Jaccard word similarity. Topics with less than 30% similarity trigger creation of a new note, so a single session covering distinct subjects produces separate, focused notes.
- **Multi-note-per-day numbering** — When topic splitting creates additional notes in the same day, they receive sequential session numbers (e.g., 0042, 0043) rather than overwriting or appending to the existing note.
- **Garbage title filter** — Over 20 patterns are rejected as session note titles: task notification strings, `[object Object]`, hex hashes, bare numbers, and other artifacts that can appear in JSONL transcripts. Titles must describe actual work done, capped at 60 characters.
- **Topic-detect worker** (`src/daemon/topic-detect-worker.ts`) — Processes `topic-detect` work items using a BM25-based detector against the PAI memory database to identify project-level topic shifts.

---

## [0.7.8] — 2026-03-20

### Fixed

- **API key stripping** — The daemon now removes `ANTHROPIC_API_KEY` from the environment of spawned headless Claude CLI processes. This forces the CLI to authenticate via the Max plan subscription rather than the API billing path, preventing unintended API charges for automatic session summarization.

---

## [0.7.7] — 2026-03-18

### Added

- **Whisper rules hook** (`src/hooks/ts/user-prompt/whisper-rules.ts`) — A `UserPromptSubmit` hook that injects critical operating rules on every prompt submission. Rules are read from `~/.claude/whisper-rules.md` and survive compaction, `/clear`, and session restarts. Inspired by the Letta claude-subconscious pattern.

---

## [0.7.6] — 2026-03-16

### Fixed

- **Claude binary discovery** — `findClaudeBinary()` now checks `~/.local/bin/claude` before PATH resolution. The launchd environment used by the daemon does not include `~/.local/bin/`, which is the standard install location for Claude CLI. Sessions running under launchd can now spawn headless summarization processes reliably.

---

## [0.7.5] — 2026-03-15

### Added

- **Tiered model selection for summarization** — Session summary worker uses Opus (5-minute timeout, 500K JSONL bytes) for Stop-hook-triggered summarizations and Sonnet (2-minute timeout, 200K JSONL bytes) for PreCompact-triggered summarizations. Haiku is available as a budget option.

---

## [0.7.4] — 2026-03-14

### Fixed

- **Auto-register on parent match** — Fixed a case where broad parent projects (home directory, top-level `apps/` folder) were swallowing new projects that should have been auto-registered. `load-project-context` now detects when the current working directory contains its own project signals (`.git`, `package.json`, `pubspec.yaml`, etc.) even when a parent project matches, and registers the CWD as a separate project.

---

## [0.7.3] — 2026-03-13

### Added

- **AI-powered session notes via daemon** — The daemon now automatically generates structured session notes by spawning a headless Claude CLI process to summarize JSONL transcripts plus recent git history. Notes include: Work Done, Key Decisions, Known Issues, and Next Steps.
- **Session summary worker** (`src/daemon/session-summary-worker.ts`) — Processes `session-summary` work items from the daemon queue.
- **PreCompact and Stop hooks push session-summary items** — Both hooks enqueue summarization work rather than doing it synchronously. The Stop hook uses a `force: true` flag to bypass the 30-minute cooldown.
- **30-minute cooldown** — Prevents redundant summary updates during rapid compaction cycles in active sessions.

---

## [0.7.2] — 2026-03-10

### Added

- **Auto-registration of new projects** — The `load-project-context` SessionStart hook detects project signals (`.git`, `package.json`, `pubspec.yaml`, `Makefile`, `go.mod`, etc.) in the current working directory and registers the project automatically on first encounter.
- **One note per session** — PreCompact hook creates at most one session note per session (not one per compaction). Subsequent compactions update the existing note rather than creating new ones.
- **Garbage title filter** — Initial 20+ pattern list rejects non-descriptive titles from JSONL artifacts.
- **`/reconstruct` skill** (`src/daemon-mcp/prompts/reconstruct.ts`) — Retroactively creates session notes from JSONL transcripts and git history for sessions where automatic capture did not run or produced no output.

---

## [0.7.1] — 2026-02-28

### Added

- **Daemon work queue** (`src/daemon/work-queue.ts`) — Persistent file-backed queue at `~/.config/pai/work-queue.json`. Hooks become thin relays that push items and exit; the daemon processes items asynchronously with exponential backoff retry.
- **Thin relay hooks** — Stop, SessionEnd, and PreCompact hooks refactored to enqueue work items rather than doing synchronous work.
- **Session note fixes** — Various fixes to session note creation and numbering.

### Changed

- Work queue item types: `session-end`, `session-summary`, `note-update`, `todo-update`, `topic-detect`.

---

## [0.7.0] — 2026-02-20

### Added

- **Modular plugin architecture** — PAI restructured into 8 named modules across 3 pricing tiers (free, pro, enterprise).
- **Cross-platform manifests** — `pai-plugin.json` (canonical), `.claude-plugin/plugin.json` (Claude Code), `.cursor/plugin.json` (Cursor), `gemini-extension.json` (Gemini CLI).
- **User extension points** — `user-extensions/skills/` and `user-extensions/hooks/` directories (gitignored, survive `git pull`).
- **Module definitions** — `plugins/<module>/plugin.json` for each of the 8 modules.

---

## [0.6.6] — 2026-02-15

### Fixed

- SessionEnd hook abort race condition.

---

## [0.6.5] — 2026-02-12

### Added

- Symlink deployment for hooks and shell scripts (PAI-owned files symlinked from `~/.claude/` to source/build directories).
- Dynamic daily budget configuration.

---

## [0.6.4] — 2026-02-10

### Fixed

- Count directories correctly when numbering session notes.
