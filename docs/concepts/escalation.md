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
appended; a second failure is `needs-decision`. With `--escalate sonnet` one
Sonnet worker runs instead. `pai queue run --escalate sonnet` runs the items
marked cloud the same way.

## Tier to tier: manual today

The tiers table has no `escalation` key in code today, and nothing moves a t2 job
to t1 on its own for large context, a missing tool or repeated failure beyond the
rules above. The manual path:

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
