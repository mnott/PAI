export const tasks = {
  description:
    "Run the task bus — read cross-session work from the tracker, dispatch it to the sessions that own it, and file findings",
  content: `## Task Bus

USE WHEN user says 'morning routine', 'what needs doing', 'run the routine', 'check my tasks', 'dispatch tasks', 'file a finding', 'add this to todoist', 'what did we find', OR /tasks.

The bus is shared state that outlives any one session. Session-local work stays in each project's \`Notes/TODO.md\`; the bus carries work that is **broader than one session** — findings discovered sideways, and work belonging to a project other than the one you are in.

### Pre-Action Check (MANDATORY)

\`\`\`bash
pai task list --limit 1
\`\`\`

If this prints "Task bus is not configured", tell the user to run \`pai task config --token\` (hidden prompt, no wizard) or \`pai setup\` for the guided version, then stop. \`pai task config\` with no flags shows the current settings with the token redacted. Do not work around it by calling the Todoist MCP directly — the bus resolves ownership against the PAI registry, which the raw MCP knows nothing about.

---

### Workflow 1 — Morning Routine

**Trigger:** "morning routine", "what needs doing", "run the routine".

**Step 1 — Read what is open**
\`\`\`bash
pai task list --today      # due today or overdue; drop --today for everything
\`\`\`

**Step 2 — Report before acting.** Group by owner, lead with overdue and \`p1\`. Never dispatch silently — the user sees the list before sessions start receiving work.

**Step 3 — Dispatch**
\`\`\`bash
pai task dispatch --today --dry-run   # always preview
pai task dispatch --today             # then, once approved
\`\`\`

| Symbol | Outcome | Meaning |
|---|---|---|
| \`→\` | delivered | Sent to an already-running session |
| \`+\` | spawned | None running; one was launched, then sent to |
| \`?\` | unrouted | No owner resolved — stays in the findings inbox |
| \`!\` | unlaunchable | Owner resolved but has no PAI alias to launch |
| \`·\` | skipped | Auto-dispatch off, or no transport — reported only |

On \`!\`: the fix is \`pai project name <identifier> <shortname>\`. Only aliased projects can be dispatched to — say this rather than reporting a vague failure.

On \`?\`: normal, not an error. Triage is pending.

**Step 4 — Report honestly.** State what actually reached a session. If nothing was dispatched because auto-dispatch is off, say so plainly rather than implying work was handed off.

---

### Workflow 2 — File a Finding

**Trigger:** "file a finding", "add this to todoist", or **any time you discover something outside the current task**.

\`\`\`bash
pai task add "Short actionable title" \\
  --owner <project> \\
  --body "Full procedure AND reasoning" \\
  --priority p2 \\
  --url "hook://..."
\`\`\`

Rules:
- **\`--body\` is not optional in practice.** Enough that the task is actionable months later, or by the user alone, without re-deriving anything. A bare title is a reminder that something was once known — worthless later.
- **Omit \`--owner\` when you genuinely do not know.** It lands in the findings inbox for triage. Guessing is worse than leaving it unrouted.
- **Prefer \`hook://\` URLs over file paths** for \`--url\` (get one via \`mcp__hook__hookmark_link\`). They survive renames and open in DEVONthink To Go on iOS. Plain paths are the fallback.
- **No generic checklist items.** A recurring item earns its place only because something *actually failed silently*. Otherwise the routine becomes noise and gets ignored.

---

### Workflow 3 — Triage

**Trigger:** "triage", "what did we find", or weekly.

\`\`\`bash
pai task list --limit 100
\`\`\`

For each \`unrouted\` item, decide with the user: assign an owner, act now, or delete. Assigning means adding a \`pai:<project>\` label on the tracker — authoritative, and it survives the task being moved.

**The findings inbox should normally be empty.** If it is filling up, the bus has become another place for items to rot. Say so — that is a judgement about the system, not about the user.

---

### Ownership

1. A \`pai:<project>\` label — **authoritative**
2. Enclosing sub-project name matched against PAI aliases — fallback
3. Otherwise unrouted

A label matching nothing does **not** fall through to the container. The user meant somewhere specific; quietly routing elsewhere is worse than not routing.

### Notes

- \`pai task done <id>\` closes a task. Dispatched tasks instruct the receiving session to do this, so work is not dispatched twice.
- One-way by design: PAI and its sessions write; a routine reads. Nothing reads the tracker back into PAI state.
- Architecture and verified API constraints: \`Notes/docs/task-bus.md\`.
`,
};
