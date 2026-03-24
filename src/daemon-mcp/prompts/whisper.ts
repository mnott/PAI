export const whisper = {
  description:
    "Manage whisper rules — persistent behavioral constraints injected on every prompt",
  content: `## Whisper Rules Management

USE WHEN user says 'whisper', 'add whisper rule', 'remove whisper rule', 'list whisper rules', 'show whisper rules', '/whisper', OR wants to manage persistent behavioral rules.

Manage the rules that PAI injects into every prompt via the whisper-rules hook.

Rules are stored in \`~/.claude/whisper-rules.md\` — one rule per line, plain text.
The hook reads this file on every UserPromptSubmit and injects it as a \`<system-reminder>\`.
Rules survive compaction, /clear, and session restarts.

### Usage

- \`/whisper\` — show current rules
- \`/whisper add <rule>\` — add a new rule
- \`/whisper remove <number>\` — remove rule by line number
- \`/whisper list\` — list rules with line numbers
- \`/whisper clear\` — remove all rules (with confirmation)

### Workflow

**Show current rules:**
Read \`~/.claude/whisper-rules.md\` and display each rule with a line number.
If the file doesn't exist, say "No whisper rules configured."

**Add a rule:**
Append the rule as a new line to \`~/.claude/whisper-rules.md\`.
Create the file if it doesn't exist.
Do NOT add duplicate rules — check if a similar rule already exists.

**Remove a rule:**
Read the file, remove the line at the given number, write the file back.
Show the removed rule for confirmation.

**Clear all rules:**
Ask for confirmation first ("This will remove all N rules. Confirm?").
Only proceed if the user explicitly confirms.

### Important

- Rules should be short, imperative statements (1-2 lines max)
- Every rule is injected on EVERY prompt — keep the list focused on truly critical rules
- Too many rules dilute their effectiveness and waste tokens
- The file does not exist by default — PAI ships the hook, the user adds their own rules
- Rules are global (shared across all sessions and projects)
`,
};
