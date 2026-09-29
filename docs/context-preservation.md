# Context Preservation

When Claude's context window fills up, it compresses the conversation. Without PAI, everything from before that point is lost — Claude forgets what it was working on, what files it changed, and what you asked for.

PAI intercepts this compression with a two-stage relay:

1. **Before compression** — PAI extracts session state from the conversation transcript: your recent requests, work summaries, files modified, and current task context. This gets saved to a checkpoint.

2. **After compression** — PAI reads that checkpoint and injects it back into Claude's fresh context. Claude picks up exactly where it left off.

This happens automatically. You don't need to do anything — just keep working, and PAI handles the continuity.

## What Gets Preserved

- Your last 3 requests (so Claude knows what you were asking)
- Work summaries and captured context
- Files modified during the session
- Current working directory and task state
- Session note checkpoints (persistent — survive even full restarts)

## Surviving a Restart, and Surviving a Crash

Compaction continuity above is one path. Closing the session and opening a new one is another, and it works differently:

- **`## Continue` in the project's `TODO.md`** is the handover. `pai pause` writes a model-authored checkpoint there; the SessionStart hook reads it back and injects it. You do not have to say "go" — it arrives on its own.
- **A rolling autosave keeps it fresh.** `pai session autosave` runs from the UserPromptSubmit and PostToolUse hooks (rate-limited, ~4 minutes) and records recent prompts plus the state of the working tree. The model is never invoked on `/exit` and never on Ctrl+C, so a checkpoint written *at* exit is impossible — it has to already exist. This is what makes an interrupted session survivable.
- **Authored beats automatic.** The autosave writes in "auto" mode and will not overwrite a model-authored checkpoint for the same session. Preservation is keyed on the Claude session UUID rather than the session note's name, because the stop hook renames and renumbers that note before the handover runs.

## Session Lifecycle Hooks

PAI runs hooks at every stage of a Claude Code session:

| Event | What PAI Does |
|-------|--------------|
| **Session Start** | Loads project context, detects which project you're in, auto-registers new projects, creates a session note, injects recent observations, and **injects the previous session's `## Continue` checkpoint** so a restart resumes with full context |
| **User Prompt** | Cleans up temp files, updates terminal tab titles, injects whisper rules and advisor mode guidance, refreshes the rolling autosave checkpoint |
| **Pre-Compact** | Saves session state checkpoint, pushes `session-summary` work item to daemon, sends notification |
| **Post-Compact** | Injects preserved state back into Claude's context |
| **Tool Use** | Classifies tool calls into structured observations (decision/bugfix/feature/refactor/discovery/change), refreshes the rolling autosave checkpoint (rate-limited) |
| **Session End** | Pushes `session-summary` work item to daemon for AI-powered note generation |
| **Stop** | Pushes `session-summary` work item to daemon, sends notification |

All hooks are TypeScript compiled to `.mjs` modules. They run as separate processes and communicate via stdin (JSON input from Claude Code) and stdout (context injection back into the conversation). Hooks are thin relays — they capture minimal data and immediately push work items to the daemon queue, which handles all heavy processing asynchronously.
