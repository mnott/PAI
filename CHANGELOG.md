# Changelog

All notable changes to PAI Knowledge OS are documented here.

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
