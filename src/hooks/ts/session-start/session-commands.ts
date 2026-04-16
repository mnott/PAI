#!/usr/bin/env node

/**
 * session-commands.ts
 *
 * Tiny SessionStart hook that injects critical session commands inline.
 * Stays under 2KB to avoid persisted-output truncation.
 *
 * This runs BEFORE load-core-context so these commands are always available
 * even when the full CORE skill gets truncated.
 */

const commands = `<system-reminder>
SESSION COMMANDS (always available):

- "go" / "continue" / "weiter" → Read Notes/TODO.md, find ## Continue section, resume work
- "pause session" → Save state to TODO.md, update session note, stop (no compact)
- "end session" → Finalize note, commit if needed, start fresh next time
- "cpp" → Release workflow: version bump → build → npm publish → git add ALL → ONE commit → git push

When user says "go" with no other context, ALWAYS check TODO.md first.

IMPORTANT: Full PAI context may be truncated due to size. For complete instructions (response format, workflows, principles), READ: ~/.claude/Skills/CORE/SKILL.md
</system-reminder>`;

console.log(commands);
