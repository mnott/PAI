# Automatic Session Notes

Every session is documented without you doing anything. A background daemon reads the session's JSONL transcript, combines it with recent git history, and spawns a headless Claude CLI process that writes a structured note. This happens while you work, not only at the end: the Stop hook triggers a checkpoint every 15 human messages (override with the `PAI_AUTO_SAVE_INTERVAL` environment variable), and the PreCompact hook triggers one when Claude's context compacts.

List the notes with `pai notes [PROJECT] [--limit N]`; they are also searchable (`pai memory search`, [Search](search.md)).

## What a note contains

- **Work Done**: what was accomplished
- **Key Decisions**: choices and their rationale
- **Known Issues**: bugs, blockers, open questions
- **Next Steps**: where to pick up

A summary with no body beyond headers never creates or updates a note, so empty stubs are not born.

## Which model writes it

The summarizer uses a model tier by trigger and feeds it the tail of the transcript, cut to a size the tier can take:

| Trigger | Tier | Transcript limit |
|---------|------|------------------|
| Compaction (PreCompact hook) | sonnet | 200K characters |
| Mid-session auto-save (Stop hook, bypasses the cooldown) | haiku | 50K characters |

A caller can request opus (500K characters). Session end itself is handled mechanically (checkpoint and status), not by a model run. The tier is resolved to a model id on the active provider.

## One note per topic

Each summary starts with a `TOPIC:` line. The daemon compares it with the title of the day's latest note by Jaccard word overlap; below 15% overlap a new note is created, otherwise the existing note is updated. Notes within a month are numbered in sequence: `0042 - 2026-03-24 - Session Name.md`, `0043 - 2026-03-24 - Different Topic.md`.

A 30-minute per-project cooldown stops redundant updates; the auto-save trigger skips it so the latest state is always captured.

## Titles

Titles are validated before a note is created: task-notification strings, `[object Object]`, hex hashes, bare numbers and similar artifacts are rejected, and a title must describe the work and stay short.

## How the daemon runs Claude

The daemon runs under launchd with a minimal PATH, so the Claude CLI is looked up at `~/.local/bin/claude` first, then on PATH. The spawned process does not receive `ANTHROPIC_API_KEY`, so it authenticates through your Claude subscription instead of the billable API.
