# Escalation

Escalation is work moving up a level when a lower one cannot finish it.

## What happens today

**Automatic, per run**

1. A local worker that loops or hits its time limit (`--max-minutes`, default
   `workers.defaultMaxMinutes` 60, or `--deadline`) is stopped. See
   [loop guard and limits](loop-guard-and-limits.md).
2. On exit its uncommitted edits are **salvaged**: committed on the worker's
   branch and logged as `WORKER-SALVAGE`. The report ends `~` (stopped, not
   failed outright).
3. After two failed local attempts on the same `--label`, the next
   `pai worker run` goes to the cloud (`route: cloud (escalated: 2 failed local
   attempts)`). `--force-local` turns this off.
4. Under policy `prefer-local` or `auto`, a local run with a bad report is
   repeated once on the cloud ([routing policy](routing-policy.md)).

**Automatic, per plan or queue**

`pai plan run` gives a failed part one local retry with the failure tail
appended. In a plan that runs on a local provider the third attempt is one
Sonnet worker (`--force-local` turns this off); a part the route classifier
sends to the cloud gets two Sonnet attempts; `--escalate sonnet` adds the
Sonnet attempt to a plan that is not local. If the last attempt fails the part
is `needs-decision`. `pai queue run` makes two local attempts per item and then
stops at `needs-decision`; the cloud step is manual: two `again` rounds mark the
item `cloud`, and `pai queue run --escalate sonnet` runs one Sonnet worker on it.

## Tier to tier

A run that ends in trouble goes one tier up on its own when one of four
triggers fires:

- **context**: the run used more than `contextFraction` of its model's window;
- **missing tool**: it needed a tool it does not have;
- **repeated failure**: the same task failed `failures` times;
- **loop stop**: the loop guard stopped the run and it left committed or salvaged
  work. It escalates at once, without waiting for a second failure; a loop stop
  with nothing saved falls back to the repeated-failure rule.

What happens then depends on the tier the run was on:

- **t2 to t1**: the task is re-run on the t1 model list. The new run's spec starts
  with an instruction to merge the stopped run's branch, including the salvaged
  edits, so it continues instead of starting over. The stopped run's status shows
  `escalated -> <id>` and the ledger records `WORKER-ESCALATE`.
- **t1 to t0**: nothing is re-run. The owning session gets one message saying what
  was tried and why it stopped, and decides. It never goes to PAILot.

A task escalates out of a tier once. A local run that committed and is kept for
review is not escalated: its commits are the result to review.

The keys sit under `workers.escalate` in workers.yaml (shipped defaults shown):

| Key | Default | Meaning |
|---|---|---|
| `workers.escalate.enabled` | `true` | Escalation on or off. |
| `workers.escalate.contextFraction` | `0.7` | Share of the context window that triggers it. |
| `workers.escalate.failures` | `2` | Failed attempts of one task that trigger it. |
| `workers.escalate.triggers` | `[context, missing-tool, repeated-failure, loop-stop]` | Which triggers are on; drop `loop-stop` to make loop stops wait for `failures`. |

## Doing it by hand

To move a job up yourself, or when escalation is off:

1. `pai worker pending` lists finished workers whose branch holds unmerged work,
   including salvaged branches.
2. Start the next worker on the stronger route, pointing it at that branch: say so
   in the spec. `pai worker resume ID "<instruction>"` continues a finished
   worker's conversation, but on the same provider and model, so it does not move up.
3. For one job, pick the route yourself: `--cloud`, `--provider NAME`, or
   `--model`. For a session, `pai worker route set --session self t2
   anthropic/sonnet` ([session profiles](session-profiles.md)).
4. A worker that is stuck on one bounded step can ask a stronger model with
   `pai worker help`.
5. Merge with `pai worker merge ID --verify "<command>"`.
