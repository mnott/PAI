# Panes

Everything PAI starts for a session runs in a visible pane next to it: every
`pai worker run`, every plan runner, and every background shell command. You
see what runs without asking, and nothing runs hidden.

**Panes need tmux or iTerm2 (macOS).** In Terminal.app, a plain SSH shell or any
other terminal no pane opens: the command runs directly, and you watch a worker
with `pai worker follow ID` (PAI prints the command).

## Why

A hidden process cannot be supervised by the person who started it, so the pane
and the process are one thing: when the process ends the pane closes, and the
other way round.

## How a pane works

1. The launcher opens the pane first (a tmux split when `$TMUX` is set, else an
   iTerm2 split on macOS). Several workers of one session stack in one column.
   The pane is a split of the starting session's tab, never a new window or tab.

With no terminal at all (no tmux, no iTerm2) the command runs directly and the
ledger records `PANE-NOTERMINAL`. A pane that opened but cannot be verified
(iTerm answered too early, or not at all) is closed again and the run goes
headless with a one-line note (`PANE-UNVERIFIED`: "pane unavailable, running
headless") — a transient verification failure never stops a start. A pane that
cannot be opened for another reason fails the start (`WORKER-NO-PANE`).
`--no-pane` runs one worker directly.

The pane is found by the tty of the launching process, so it opens next to the
terminal that really hosts you. `ITERM_SESSION_ID` is only a fallback.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `host session: none (iTerm2 not running or unreachable)` | Start iTerm2 and enable its Python API (iTerm2 > Settings > General > Magic > Enable Python API), then `pai worker pane <id>`. |
| Not in tmux or iTerm2 | No pane opens by design. Run the printed `pai worker follow <id>` yourself. |
| Panes of ended runs stay open | `pai worker pane --close-ended`. |
| No pane at all | `pai project health` in the project: the `iTerm host session` line says why. |

Font size comes from `workers.pane.fontSize` (default 13); `workers.pane.enabled`
defaults to true.


## Status line and input line

The bottom of a worker pane is pinned:

```
<label or goal>
<model> · <context used> / <window> · started HH:MM · <elapsed> · denied N spec?
```

- Model and context: the worker's model and the context tokens used against its
  window. Parts that are not known yet are dropped.
- While the worker blocks in `pai worker wait-on`, the goal is replaced by
  `waiting on: <job> · running 4m12s · log: <last log line>`.
- `denied N` counts hook denials; `spec?` means one looks like a spec conflict
  (see [loop guard and limits](loop-guard-and-limits.md)).
- A worker pane also has an input line, so you can type to the worker. A
  `pai pane run` pane shows `<label> · started · elapsed` and no input line.

The status line refreshes every `panes.statusTickMs` (default 1000).

## Background commands: `pai pane run`

A shell command Claude Code backgrounds (tests, a build) goes through one
command:

```
pai pane run --label tests -- npx vitest run
```

- The pane shows the live output, then the exit code, and closes
  `panes.lingerSecs` (default 5) after the command ends, whatever the exit code.
- The full output stays in `<PAI home>/logs/panes/<id>.log`.
- The caller blocks until the command ends, prints the last
  `panes.tailLines` (default 40) lines and exits with the command's exit code,
  so the harness's background-task notification still arrives.
- SIGTERM, SIGINT or SIGHUP to the caller kill the command's whole process group.
- It is listed in `pai worker ps` and the cockpit while it runs.
- A single word is run by `sh -c`; several words are exec'd as given.

A guard in interactive sessions denies a Bash call with `run_in_background: true`
unless the command starts with `pai pane run`, `pai worker run`, `pai plan run`,
`pai build run` or `pai build lock`. Foreground calls are unaffected.

## Managing panes

```
pai worker pane <id>                      # open (or reopen) the pane of one worker
pai worker pane <id> --check              # is it open? profile file, font, window bounds
pai worker pane --close-ended --dry-run   # list panes whose worker or pane run has ended
pai worker pane --close-ended             # close them
```

## Placement rules and marks

A pane never blocks a start for being badly placed. It is marked instead, and
each mark says what to do: `NOT SELECTED` (its tab is in the background: click
the tab), `MINIMISED` (restore the window), `HIDDEN` (show iTerm2),
`OFF SCREEN` (move the window onto a screen). Pane size is never a mark: a small
pane is fine, `panes.minCols` x `panes.minRows` only guide which pane is split.
Marks show in
`pai worker ps` and the cockpit. A leftover pane of an ended run shows as
`STILL OPEN`: `pai worker pane --close-ended` closes it.

A worker's own child worker opens its own pane like any other start. Pool spares
get no pane while idle; a claimed spare's run opens its pane as usual and the
pane follows the run's transcript (see [pool](pool.md)).

## The pane auditor

The daemon checks every 30 seconds that each PAI process has a pane and each
pane has a process. It writes to the ledger only; it never messages a session
and never PAILot, and it never reopens anything.

- Wrapper alive, child gone: the wrapper is killed and the pane closed
  (`PANE-ORPHAN side=wrapper`).
- Pane gone, child alive: the child is killed (`side=child`).
- A running worker that never went through the launcher: `PANE-UNLAUNCHED`.
- Placement marks: `PANE-VIOLATION` lines.
- A live worker whose pane entry is missing (a sibling dropped it): the audit
  registers its pane again (`PANE-REREGISTERED`) instead of killing the
  worker. Dropping an entry is itself a ledger row (`PANE-ENTRY-DROP`: run,
  session, caller, reason).

Processes younger than `panes.audit.startGraceSecs` (30) or ended within
`panes.audit.endGraceSecs` (60) are not judged; a wrapper that outlives its child
by `panes.audit.launchGraceSecs` (15) is an orphan. `pai worker ps --panes` lists
process, pane and tab live.

## Internals

Not needed to use panes.

2. The pane runs `pai pane exec <id>`. That wrapper connects back to the starting
   `pai` process, receives the real command and runs it as its child.
3. The wrapper draws the child's output (a worker is rendered like
   `pai worker follow`), writes `<PAI home>/state/pane-exec/<id>.exit` (exit code,
   end time) and exits when the child exits. The pane closes with it.
4. The caller (`pai worker run`, `pai pane run`) waits for the child and returns
   its exit code. If the caller is killed the child is killed; if the pane is
   closed the child is killed.

`pai pane exec` is not for direct use.

`pai pane exec` is not for direct use.

Setting this up for the first time: [first workers](../install/first-workers.md).
