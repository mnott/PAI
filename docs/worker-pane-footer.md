# Worker pane footer and long jobs

The last lines of a follow pane tell you what the worker is, how full its
context is, and what it is waiting for.

## What it shows

```
<label or goal>
<model> · <context used> / <window> · started HH:MM · <elapsed> · denied N spec?
```

- **Model and context.** `model · 84k / 200k`: the model the worker runs and
  the context tokens used against the model's window. Only the used part shows
  when the window is unknown; the part is dropped when nothing is known yet.
- **Waiting on.** While the worker blocks in `pai worker wait-on`, the footer
  replaces the goal with
  `waiting on: <job> · running 4m12s · log: <last log line>`. The running time is
  the job's own age; a finished job reads `· ended`. `pai worker ps` and the
  replay transcript show the same line.
- **Denials.** `denied N` / `denied N spec?`, see [worker-denials.md](worker-denials.md).

## Long-job recipe

A foreground command that runs for minutes starves operator messages and
supervision, so workers run long jobs detached and wait in bounded slices:

```
nohup sh -c 'CMD; echo $? > /tmp/job.rc' > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid
pai worker wait-on $(cat /tmp/job.pid) --log /tmp/job.log
```

Repeat the second line until it exits 0.

`wait-on` options: `--log <file>` (last lines printed on return; `<file>.rc` holds the exit code), `--max <secs>` (default 110, capped
at 115), `--tail <n>` (log lines, default 20). Exit codes: `0` the pid is gone, `3` still
running at `--max` (call again), `2` the pid never existed or is not yours. The recipe
keeps the job's own exit code in `/tmp/job.rc`.

## Set up for a project

Nothing to configure. To make workers follow the recipe, the contract already
says so; for project-specific long commands add a line to `.pai/worker.md`
([worker-rules.md](worker-rules.md)).

## Troubleshooting

- Footer shows no context: the first turn has not finished yet.
- `waiting on: pid N · ended` while the job still runs: the pid was reused or
  the recipe's `$!` pointed at the wrapper; write the pid of the `nohup` line.
- `wait-on` exit 2: the pid file is empty or the job died instantly; read the log.
