# Queue (`pai queue`)

A local queue for small incremental changes: "the tooltip says Sav", "move this button", "fix this compile error". You add one sentence per change, a local worker does each in its own worktree branch, and you review the results as a batch. Nothing is merged until you accept it.

```
pai queue add "the save button tooltip says Sav" [--files a,b] [--image shot.png] [--project SLUG]
pai queue run [--parallel N]          # drain pending items; merges nothing
pai queue review                      # ready items: id, sentence, diff stat, gate, proof path
pai queue accept q1 q3                # merge with the gate, then the install command
pai queue reject q2 --why "wrong button"
pai queue again q4 "still not: clipped on the left"
pai queue run --escalate sonnet       # the items marked cloud
pai queue list                        # every item and its state
```

There is no spec step. The worker task is your sentence, the files and image if given, the project's `rules`, and a fixed footer: relative paths only, `git add` then commit, keep the change small (the size limits), no full test suite, report with an R message.

## Project settings: `.pai/queue.yaml`

All keys optional.

```yaml
provider: local        # default: the active local provider
gate: xcodebuild ...   # run in the worker's worktree before "ready", and as the merge check on accept (default: none)
proof: ./shot.sh       # prints a path (e.g. a PNG) on its last stdout line; run in the worktree
install: ./install.sh  # run in the checkout after a successful accept
max_files: 6           # more files than this: too-big
max_lines: 200         # more added + removed lines than this: too-big
max_parallel: 2        # default: the provider's maxConcurrent
rules: Use tabs.       # extra text appended to every worker spec
```

Without a `gate` no build or test runs at all; the queue never runs a full test suite on its own.

## States

| state | meaning |
|---|---|
| pending | waiting for `run` |
| running | a worker is on it |
| ready | committed branch within the limits; gate (if any) passed; diff stat, proof and report stored |
| too-big | the diff exceeds `max_files`/`max_lines`; not retried, a candidate for a bigger tier |
| needs-decision | failed twice (one local retry with the failure tail appended) or the spawn was refused |
| cloud | two `again` rounds done; `pai queue run --escalate sonnet` runs one Sonnet worker on it |
| accepted / rejected | done |

`run` reuses the plan runner's machinery (`pai plan`, see [plan-runner.md](plan-runner.md)): `pai worker run --worktree`, the real-commit check, spawn-refusal handling, and `pai worker merge --verify` on accept. Items that name the same file never run together.

`again` re-queues the item with the previous attempt's diff and your note appended to the spec. The second `again` marks it for the cloud instead.

## State file

One JSON file per project under the PAI home, `queue/<project>-<hash>.json`; the repository never holds queue state. Worker branches stay as `worker/<id>` until accepted or `pai worker gc`.

## Detached runs and events

`pai queue run --detach` starts the drain as a detached process (registered under `<logDir>/runs/`, see [plan-runner.md](plan-runner.md)) and returns; it survives the starting session. A run with an originating session reports to it through AIBroker `send_to_session`, one AG2-style line plus a plain sentence (`S i=queue:<project> z=<kind> | ... — ...`):

- `ready`: batched, at most one message per 10 minutes, listing the ready items in plain words; whatever the throttle held back is sent when the run ends.
- `needs-decision`: at once, per item, with the failure tail.

Nothing goes to PAILot from the queue. An unreachable AIBroker is logged and the run goes on.
