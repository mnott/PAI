# Lessons

## What it is

A lesson is a short note about how to work in a project or in general: a workflow, a correction you gave, a debugging step, a gotcha or a convention. Lessons are kept apart from your other memory and are review-gated. A new lesson is only a candidate. It reaches agents once you approve it.

Each lesson is one Markdown file with YAML frontmatter under `<PAI home>/lessons`. Memory search indexes the folder. Secrets are redacted before a lesson is stored.

## States

| State | Meaning |
|---|---|
| `candidate` | Proposed or added, not yet reviewed. |
| `approved` | Reviewed and in use. |
| `rejected` | Reviewed and dropped. |
| `superseded` | Replaced by another approved lesson. |

Only candidates can be approved or rejected. Only approved lessons can be promoted or superseded.

## When to use it

- You gave the same correction twice and want it to stick.
- You found a project gotcha that the next session should know.
- A lesson proved itself and should become a skill in the project.

## Commands

```
pai lessons list [--state S] [--project P] [--json]
pai lessons show ID
pai lessons add --title T --kind K --applies-when W [--project P] [--body B]
pai lessons propose [TRANSCRIPT]
pai lessons approve ID
pai lessons reject ID
pai lessons supersede ID --by ID2
pai lessons promote ID [--project DIR] [--force] [--agents]
```

- `--kind` is one of `workflow`, `correction`, `debugging`, `gotcha`, `convention`.
- `--project` is a project slug, default `global`.
- `propose` reads a transcript (default: the newest of this directory) and adds candidates from user messages that start with a correction. It makes no model call.
- `propose --draft` has a model draft the candidates instead: it reads the user messages (system reminders, command tags and tool output stripped, with the assistant text before each as context), and returns lessons where the user corrected the assistant or stated a standing rule, each with a title, kind, applies-when, body and the quoted user text as evidence. The model is the running local model (the one `--local` workers use); with none running it falls back to the routed default. Invalid output is dropped, secrets are redacted, and lessons matching an existing title or near-identical body are skipped. The model rates each item `strength` 1-5 and `standing` true or false. All chunks of the transcript are drafted first; items that are not standing or have strength below 3 are dropped, near-duplicates are merged and counted, and the list is sorted by strength, then by how often the rule recurred, and capped at `lessons.draft.max` only at the end. `--dry-run` prints the candidates without writing.
- `promote` writes the lesson as `<project>/.claude/skills/<slug>/SKILL.md`. With `--agents` it also writes under `.agents/skills`. It refuses to overwrite an existing skill unless you pass `--force`.
- `supersede` needs the replacement given with `--by` to exist and be approved.

Claude reads lessons through the MCP tool `memory_lessons`.

## Config keys

- `lessonsIndex.enabled`: index `<PAI home>/lessons` for memory search. Default `true`.
- `lessons.draft.max`: the most candidates `propose --draft` returns after ranking. Default `10`.

## Worked example

1. At the end of a session run `pai lessons propose`. It adds the candidates it found.
2. `pai lessons list --state candidate` shows them with their ids.
3. `pai lessons show run-tsc-first` to read one. If it is right, `pai lessons approve run-tsc-first`. If not, `pai lessons reject run-tsc-first`.
4. Later you write a better version, approve it, and run `pai lessons supersede run-tsc-first --by run-tsc-and-tests`.
5. When the lesson is stable, `pai lessons promote run-tsc-and-tests --project ~/code/app` turns it into a project skill.

## Related

- [Memory](../memory.md), [skills](../skills.md)
- [`pai lessons`](../commands/lessons.md)
