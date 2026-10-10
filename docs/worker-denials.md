# Hook denials

A hook or permission rule can refuse a worker's tool call. PAI records these so
a spec that contradicts the worker contract shows up instead of silently
costing the worker turns.

## What is recorded

Per denial: time, tool, hook, the first ~120 characters of the denied input and
the first ~200 characters of the reason. Up to 50 entries per run are kept; the
true total stays in the count. The runner records them; a worker cannot write or
remove them.

A denial is flagged **spec conflict** when the same hook, tool and reason was
denied twice or more in the run, or the denied input shares 20 or more
consecutive characters with the spec (the spec asked for something the contract
forbids).

## Where you see it

- `pai worker ps`, the pane footer: `denied 3`, or `denied 3 spec?` when any is flagged.
- `pai worker replay <id>`: one line per denial, `!` marking a likely spec conflict.
- The worker report (`denials` in the result).

## Use it to fix specs

`denied N spec?` means: read the flagged lines in `pai worker replay <id>`, find
the instruction in your spec they came from (a heredoc, a long foreground wait,
a forbidden command), and rewrite the spec the way the contract wants it (write
payloads to a file first, run long jobs detached). A repeated denial that no
spec explains belongs in a deterministic rule or the project's
[`.pai/worker.md`](worker-rules.md).

## Set up for a project

Nothing; always on.

## Troubleshooting

- No marker but the worker struggled: only denials the harness reports are
  counted; check `pai worker replay <id>`.
- Same denial in every run: add the guidance to `.pai/worker.md` so the worker
  avoids it up front.
