---
name: Tasks
description: "Run the task bus — read cross-session work from the tracker, dispatch it to the sessions that own it, and file new findings. USE WHEN user says 'morning routine', 'what needs doing', 'run the routine', 'check my tasks', 'dispatch tasks', 'file a finding', 'add this to todoist', 'what did we find', OR /tasks."
---

## Tasks Skill

USE WHEN user says 'morning routine', 'what needs doing', 'run the routine', 'check my tasks', 'dispatch tasks', 'file a finding', 'add this to todoist', 'what did we find', OR /tasks.

### What This Skill Does

The task bus is shared state that outlives any one session. Session-local work stays in each project's `Notes/TODO.md`; the bus carries work that is **broader than one session** — findings discovered sideways, and work that belongs to a project other than the one you are sitting in.

Three workflows: **morning routine**, **file a finding**, **triage**.

### Pre-Action Check (MANDATORY)

Run this before anything else. If it reports the bus is not configured, say so and stop — do not attempt to work around it by calling the Todoist MCP directly.

```bash
pai task list --limit 1
```

If it prints "Task bus is not configured", tell the user to run `pai setup` and complete the Task Bus step. Nothing else in this skill will work.

---

## Workflow 1 — Morning Routine

**Trigger:** "morning routine", "what needs doing", "run the routine".

### Step 1 — Read what is open

```bash
pai task list --today
```

This shows tasks due today or overdue. Drop `--today` for everything open.

### Step 2 — Report before acting

Group what you found by owner and present it. Lead with anything overdue or `p1`.

Do **not** dispatch silently. The user should see the list before sessions start receiving work.

### Step 3 — Dispatch

```bash
pai task dispatch --today --dry-run   # always preview first
pai task dispatch --today             # then, once the user approves
```

Outcomes and what each means:

| Symbol | Outcome | Meaning |
|---|---|---|
| `→` | delivered | Sent to an already-running session |
| `+` | spawned | No session was running; one was launched, then sent to |
| `?` | unrouted | No owner resolved — the task stays in the findings inbox |
| `!` | unlaunchable | An owner resolved but it has no PAI alias to launch |
| `·` | skipped | Auto-dispatch is off, or no transport — reported only |

**On `!` unlaunchable:** the fix is `pai project name <identifier> <shortname>`. Only projects with a curated alias can be dispatched to. Say this rather than reporting a vague failure.

**On `?` unrouted:** this is normal, not an error. It means triage is pending — see Workflow 3.

### Step 4 — Report honestly

State what actually reached a session and what did not. If nothing was dispatched because auto-dispatch is off, say that plainly — do not imply work was handed off when it was not.

---

## Workflow 2 — File a Finding

**Trigger:** "file a finding", "add this to todoist", or **any time you discover something outside the current task**.

This is the point of the bus. When you notice something while doing something else, file it rather than only mentioning it in passing — mentions get lost.

```bash
pai task add "Short actionable title" \
  --owner <project> \
  --body "Full procedure AND reasoning" \
  --priority p2 \
  --url "hook://..."
```

### Rules

- **`--body` is not optional in practice.** Put the full procedure and the reasoning in it — enough that the task is actionable months later, or by the user alone, without re-deriving anything. A title alone is a reminder that something was once known, which is worthless later.
- **Omit `--owner` when you genuinely do not know.** The task lands in the findings inbox for triage. Guessing an owner is worse than leaving it unrouted.
- **Prefer `hook://` URLs over file paths** for `--url`. Get one with `mcp__hook__hookmark_link`. They survive renames and moves, and open in DEVONthink To Go on iOS. Fall back to a plain path if Hookmark is unavailable.
- **Do not file generic checklist items.** A recurring item earns its place only because something *actually failed silently*. Otherwise the routine becomes noise and gets ignored.

---

## Workflow 3 — Triage

**Trigger:** "triage", "what did we find", or weekly as part of the routine.

```bash
pai task list --limit 100
```

Look at everything marked `unrouted`. For each, decide with the user: assign an owner, act on it now, or delete it.

Assigning an owner means adding a `pai:<project>` label on the tracker. The label is authoritative and beats the container the task sits in, so it survives being moved.

**The findings inbox should normally be empty.** If it is filling up, the bus has become another place for items to rot — say so. That is the failure mode worth naming out loud, and it is a judgement about the system, not about the user.

---

## Ownership — How Tasks Find Their Session

Resolution order:

1. A `pai:<project>` label — **authoritative**
2. The enclosing sub-project name matched against PAI aliases — fallback
3. Otherwise unrouted

An explicit label that matches nothing does **not** fall through to the container. That is deliberate: the user meant to route it somewhere specific, and quietly sending it elsewhere would be worse than not routing it at all.

## Notes

- `pai task done <id>` closes a task on the tracker. Dispatched tasks tell the receiving session to do this, so work is not dispatched twice.
- The bus never reads the tracker back into PAI state. It is one-way: PAI and its sessions write, a routine reads.
- Full architecture and the verified API constraints: `Notes/docs/task-bus.md`.
