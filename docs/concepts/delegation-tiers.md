# Delegation tiers

PAI splits a job over three levels. A level is a **tier**: a role with an
ordered list of models. A tier is not a fallback rank; a worker does not run
"on t2 because t1 failed".

| Tier | Name | Who it is | Shipped model list (first available serves) |
|---|---|---|---|
| `t0` | Session | The interactive session you talk to. | `anthropic/opus`, `glm/glm-5.3` |
| `t1` | Orchestrator | Splits a job, plans, reviews. Its workers implement the parts. | `anthropic/sonnet`, `glm/glm-5.3-flash` |
| `t2` | Worker | Implements the parts, runs quick checks. | `local`, `anthropic/sonnet`, `glm/glm-5.3-flash` |

Opus serves the session while the Anthropic budget lasts; when it is out, the
next entry (glm) serves. Sonnet plans. Workers go local first.

## Why local first, and when cloud comes first

Local tokens are free and the cloud is limited. So the worker tier starts with
`local`. A cloud model is placed ahead of local only for two reasons: **context
width** (a job that does not fit the local model's window) or **reasoning**
(planning, reviewing, deciding what a failing test means). That is why t0 and t1
list cloud models first and t2 lists local first. The reason sits in each row's
`note`.

## "First available"

A list is read left to right. An entry is skipped when its provider is disabled
or in cooldown, when its budget is at its wall (see
[routing policy](routing-policy.md)), or, for a local model, when its server is
not running. PAI never starts a local server to satisfy a route. The first entry
left serves; the rest is the fallback order.

## Class to tier

Each tier names the classes it serves in its `classes` key. The tier with
`default: true` (t2) serves every other class.

| Tier | Classes |
|---|---|
| t1 | `orchestrate`, `plan` |
| t2 | `implement`, `research`, `draft`, `review`, `complex`, `simple`, `spotcheck` |

`pai worker run --class implement` therefore resolves through the t2 list.
`pai worker classes` lists classes and where each runs; `classes set <class>
<provider>` pins one to a provider.

## Reading and editing the table

```
pai worker route                                  # flow line, one row per tier, one per class
pai worker route set t2 gyro-m,anthropic/sonnet   # replace a tier's list (a class sets its tier)
pai worker route set t2 gyro-m,anthropic/sonnet --note "context width"
pai worker classes                                # classes and where they run
```

A cloud entry is `provider/model` (`glm/glm-5.3-flash`, `anthropic/opus`,
`glm/fast`); a local one is the provider name (`gyro-m`). The first line of
`pai worker route` is the flow: what each tier resolves to right now. The
cockpit's Routing section shows the same table read-only; edit with
`pai worker route set` or in the file. For one session only, see
[session profiles](session-profiles.md).

## Where it lives

The table is the `tiers:` list in `workers.yaml`. The shipped default is
`src/config/defaults/workers.yaml`; your `~/.pai/workers.yaml` is merged over
it, and arrays replace. A `tiers:` block in your file therefore **replaces the
shipped list wholesale**, with no concatenation; copy the rows you want to keep.
`pai config get <key> --source` shows which file a value came from. Row keys
seen in the shipped file: `id`, `name`, `description`, `models`, `classes`,
`session` (the tier PAI starts sessions on), `default`, `note`.

## Worked example: a programming job

1. You ask the session (t0, opus) to add a feature that touches six files.
2. The session starts an orchestrator: `pai worker run --orchestrate` (class
   `orchestrate`, t1, sonnet). It splits the job into parts of a few files and
   writes one spec per part. Code edits are denied to it.
3. Each part starts as `pai worker run --class implement` (t2). The list begins
   with `local`, so a running local model takes it, in its own worktree and
   branch. With no local server running, `anthropic/sonnet` serves.
4. The orchestrator reviews each diff and merges with a gate
   (`pai worker merge ID --verify "<command>"`). A failing gate reverts the
   merge and keeps the branch.
5. The session runs its own final checks and reports to you.

A part that a local worker cannot finish moves up; see [escalation](escalation.md).
