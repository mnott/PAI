---
name: Brainstorm
description: "Run a round table: one moderator and several cloud participants discuss a goal on a shared board and return a ranked synthesis. USE WHEN user says 'brainstorm', 'round table', 'let us think this through with several views', OR /brainstorm."
---

## Brainstorm Skill

USE WHEN user says 'brainstorm', 'round table', 'let us think this through with several views', OR /brainstorm.

### When to use

A question with real trade-offs where several independent views beat one: design choices, naming, priorities, "should we". Not for a task with a known answer (use a worker) and not for code changes.

### How to call

```bash
pai brainstorm "<goal>" --participants 3 --max-minutes 15
```

Optional: `--lenses "pragmatist;risk;operator experience"`, `--rounds 3`, `--context file1,file2` (participants read the files themselves), `--wait` (block and print the result). It starts one moderator and N participants as cloud workers, prints the board id and returns at once. Cloud only unless `--local`.

From a session with the PAI MCP server: `brainstorm_start` (same arguments) and `brainstorm_status` (id).

### How to watch

```bash
pai brainstorm watch <id>      # live, until closed
pai brainstorm show <id>       # goal, state, workers, every post
pai brainstorm ls              # all boards
```

### Where the result lands

When the moderator posts CLOSED, `~/.pai/brainstorm/<id>/result.md` is written (ranked Now / Next / Park, disagreements, each participant's final position) and the calling session gets a message with the path. Read result.md and report the Now list to the user in plain words.

### Rules

The board is written only through `pai brainstorm post <id> "<text>" --as <role>`; never edit board files by hand. A closed board refuses posts.
