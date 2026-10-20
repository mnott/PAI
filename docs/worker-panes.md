# Worker panes

Every `pai worker run` opens a small follow pane next to your session, so you
see what the worker does without asking. When the worker ends, the pane closes.

## What it does

- **Auto-open.** A new worker splits a pane beside the session that launched it:
  tmux split when `$TMUX` is set, else an iTerm2 split on macOS, else nothing
  (the command prints `pai worker follow <id>` for you to run yourself). Several
  workers of one session stack top to bottom in one column.
- **Host resolution by tty.** The pane opens next to the iTerm2 session that
  really hosts you. PAI finds it by the tty of the launching process and matches
  it against the live iTerm2 sessions; `ITERM_SESSION_ID` is only a fallback and
  only when that session is live. A reattached iTerm2 session keeps a stale id in
  the environment, which is why the tty wins.
- **The pane owns the process.** The pane is opened first and runs
  `pai pane exec <id>`; the worker's claude (a plan runner, a `pai pane run`
  command) is that wrapper's child. The wrapper renders the child's output in
  the pane (a worker: the `worker follow` rendering, fed by the child's
  stream-json directly), writes `<PAI home>/state/pane-exec/<id>.exit` (exit code,
  end time) and exits when the child exits, so the pane closes with it (profile
  `pai-worker`, Close Sessions On End). The caller (`pai worker run`, `pai pane
  run`) waits for the child's exit and returns its exit code. Either side going
  away takes the other with it: the caller killed kills the child, the pane
  closed kills the child. With no terminal at all (no iTerm2, no tmux) the
  command runs directly, recorded as `PANE-NOTERMINAL`. A pane that cannot be
  opened for any other reason fails the start; `--no-pane` and the operator's
  hidden-run override run directly.
- **Pool spares** are infrastructure of the pool host and get no pane while idle.
  The pane rule wins over the pool: with a terminal a run spawns fresh through
  its pane instead of claiming a spare.

## Set up for a project

Nothing per project. Opt out for one run with `--no-pane`. Font size comes from
`workers.pane.fontSize` ([workers-config.md](workers-config.md)). `pai project
init` ([worker-project-setup.md](worker-project-setup.md)) checks the host
resolution for you.

## See it working

```
pai worker pane <id>                 # open (or reopen) the pane of one worker
pai worker pane <id> --check         # is it open? plus profile path, font, window bounds
pai worker pane --close-ended        # close every pane whose worker or pane run has ended
pai worker pane --close-ended --dry-run   # list what would close
```

`pai worker pane` prints `host session: <uid> via tty|env` on stderr, or
`host session: none (<reason>)`.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `host session: none (iTerm2 not running or unreachable)` | iTerm2 is not running, or its Python API is off. Start it, enable Scripting, retry `pai worker pane <id>`. |
| `no live iTerm2 session matched` | The terminal is not iTerm2 or tmux. Use `pai worker follow <id>`. |
| Panes of ended workers or pane runs stay open | `pai worker pane --close-ended`. |
| No pane at all | Check `pai project health` in the project: the `iTerm host session` line says why. |

See also: [worker-pane-footer.md](worker-pane-footer.md).

## Background commands: `pai pane run`

Everything a session starts that does not run in its own pane runs in a pane. A shell command Claude Code backgrounds (a test suite, a build, a sample loop) goes through one command:

```
pai pane run --label tests -- npx vitest run
```

- **Placement** is a worker pane's: a split of the starting session's own tab, never a new window or tab, never a stolen focus.
- **The pane** shows the command's live output, then its exit code, and closes itself five seconds later, whatever the exit code. The full output stays in `<PAI home>/logs/panes/<id>.log`; a leftover ended pane-run pane is swept by `pai worker pane --close-ended` and reported by the auditor as `STILL OPEN`.
- **The caller blocks** until the command ends, prints the last 40 lines and exits with the command's exit code, so the harness's background-task notification still arrives. SIGTERM, SIGINT or SIGHUP to the caller (TaskStop) kill the command's whole process group.
- **Listed** in `pai worker ps` and the cockpit worker panel under "panes" (label, cwd, running time, log path) while it runs.
- A single word is run by `sh -c`; several words are exec'd as given. Without a usable pane the command still runs, with the reason on stderr.

`pai build run` and `pai build lock` do this by themselves when called from an interactive session, so a build's queue wait and output are visible; inside a worker or an enclosing `pai pane run` they run directly.

### The guard

The PreToolUse Bash hook (interactive sessions only; workers already have a pane) denies a Bash call with `run_in_background: true` unless the command starts with `pai pane run`, `pai worker run`, `pai plan run`, `pai build run` or `pai build lock` (leading `cd` and env assignments are skipped). The denial reads: "Background commands run in a visible pane: `pai pane run --label <what> -- <command>`." Foreground calls are unaffected. The rule lives in `src/hooks/ts/lib/background-gate.ts`.

## Pane audit

By construction a process PAI starts in a session has a pane and a pane has a process, so the daemon audit (every 30 s) is a bug detector, and writes to the ledger only (never a session, never PAILot): a pane-exec whose child is gone while its pane lives has its wrapper killed and the pane closed (`PANE-ORPHAN side=wrapper`); one whose pane is gone while the child runs has the child killed (`side=child`); a running worker that never went through the launcher is noted (`PANE-UNLAUNCHED`). The pane marks (`WRONG TAB`, `STILL OPEN`, `SMALL`, `NOT SELECTED`, `MINIMISED`) stay in `pai worker ps` and the cockpit, with `PANE-VIOLATION` ledger lines. Nothing is reopened. `pai worker ps --panes` lists process -> pane -> tab live.

## A pane never blocks a start

Only "the pane exists and runs the worker" matters, and a missing terminal never refuses a start.

- **Visibility is a mark.** A pane that runs the worker but is not seen right now is accepted and marked on the returned description (`NOT SELECTED` tab, `MINIMISED` window, `HIDDEN` iTerm2, `OFF SCREEN` window, `SMALL` pane). Each mark is logged (`PANE-MARK`, `PANE-SMALL`) and the pane auditor shows `NOT SELECTED`, `MINIMISED` and `SMALL` without alarming.
- **No terminal at all** (no tmux or `ITERM_SESSION_ID`, a Claude background session with no attached terminal) runs the command directly: the ledger gets `PANE-NOTERMINAL` and `status.pane` records it (not a violation). A failed split or a wrapper that never connects fails the start (`WORKER-NO-PANE`). PAI never opens a `claude attach` tab or any new tab or window to make a pane possible.
- `--no-pane`, `PAI_WORKER_AUTOPANE=0` and the keepalive beat need no override any more.
