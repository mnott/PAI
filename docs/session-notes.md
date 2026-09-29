# Automatic Session Notes

## Automatic Session Notes — by Topic

PAI's headline feature: **every session is automatically documented.** No manual note-taking, no "pause session" commands, no forgetting to save what you did.

When you work, a background daemon watches your session **continuously**. Every time Claude's context compacts — which happens automatically as the conversation grows — the daemon reads the JSONL transcript, combines it with your git history, and spawns a headless Claude process to write a structured session note. Not just at session end. Midway through your work, while you're still coding. The notes build up in real time as you go — what was built, what decisions were made, what problems were hit, what's left to do.

**When you change topics mid-session, PAI creates a new note.** If you start the day debugging audio, then pivot to a Flutter rewrite, you get two notes — not one giant file mixing unrelated work:

```
Notes/2026/03/
  0001 - 2026-03-23 - Phase 1 Research and Architecture.md
  0002 - 2026-03-24 - Background Audio and iOS Conflicts.md
  0003 - 2026-03-24 - Flutter Rewrite with Whisper.md     ← auto-split, same day
```

Topic detection uses Jaccard word similarity between the new summary's topic and the existing note's title. Below 30% overlap = new note.

**Model tiering:** Opus for final session summaries (best quality, runs once). Sonnet for mid-session checkpoints (good quality, runs on compaction). All using your Max plan — no API charges.

This is not a template or a skeleton. These are real notes with build error chronologies, architectural decisions with rationale, code snippets, and "what was tried and failed" sections. The kind of notes you'd write yourself if you had time.

## Automatic Session Notes

PAI automatically writes structured session notes after every session ends — no manual journaling required. The daemon spawns a headless Claude CLI process (using your Max plan, not the API) to summarize the JSONL conversation transcript combined with recent git history.

### What Gets Generated

Each session note contains:

- **Work Done** — concrete description of what was accomplished
- **Key Decisions** — choices made and their rationale
- **Known Issues** — bugs found, blockers, or open questions
- **Next Steps** — where to pick up in the next session

The summarizer uses tiered model selection based on the trigger:

| Trigger | Model | Timeout | JSONL Limit |
|---------|-------|---------|-------------|
| Session end (Stop hook) | Opus | 5 minutes | 500K bytes |
| Auto-compaction (PreCompact hook) | Sonnet | 2 minutes | 200K bytes |

### Topic-Based Note Splitting

When a session covers multiple distinct topics, PAI creates separate notes rather than one long note for the whole session. The summarizer outputs a `TOPIC:` line describing the subject of the current work. PAI compares this against the existing note title using Jaccard word similarity — when similarity falls below 30%, a new note is created automatically.

Notes within the same day are numbered sequentially: `0042 - 2026-03-24 - Session Name.md`, `0043 - 2026-03-24 - Different Topic.md`, and so on.

### One Note Per Session

Each compaction within a session updates the existing note rather than creating a new one. The 30-minute cooldown between summaries prevents redundant updates. Stop hook triggers bypass the cooldown with a force flag to ensure the final state is always captured.

### Garbage Title Filter

Session note titles are validated before creation. Over 20 patterns are rejected, including: task notification strings, `[object Object]`, hex hashes, bare numbers, and other non-descriptive artifacts that can appear in session transcripts. Titles must describe actual work done and are capped at 60 characters.

### Finding the Claude Binary

The daemon runs under launchd with a minimal PATH that does not include `~/.local/bin/`. PAI resolves the Claude CLI binary by checking `~/.local/bin/claude` first, then falling back to PATH lookup, before spawning headless summarization processes.

### Stripping the API Key

When spawning headless Claude CLI processes for summarization, the daemon strips `ANTHROPIC_API_KEY` from the subprocess environment. This forces the spawned process to authenticate via your Max plan (free) rather than using the API key (billable). Without this, every automatic session note would incur API charges.
