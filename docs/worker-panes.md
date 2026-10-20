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
- **Close on end.** Panes run `pai worker follow <id> --auto-exit <secs>` under
  the `pai-worker` iTerm2 profile (Close Sessions On End), so they disappear
  shortly after the worker ends (`workers.pane.autoExitSecs`).

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

Every running worker, plan runner and `pai pane run` command must own a live pane in the tab of the session that started it, and an ended `pai pane run` must have closed its pane. The daemon checks this every 30 s (iTerm session -> window:tab against the pane registry). A violation (`NO PANE`: none recorded or the pane is gone; `WRONG TAB`: the pane sits in another tab or window; `STILL OPEN`: an ended pane run's pane is still open past the linger) is written once to the ledger as `PANE-VIOLATION`, shown in red in `pai worker ps` and the cockpit, and sent once to the starting session and PAILot. `pai worker ps --panes` lists process -> pane -> tab live.

## A pane never blocks a start

Only "the pane exists and runs the worker" matters, and a start is never refused for a pane reason.

- **Visibility is a mark.** A pane that runs the worker but is not seen right now is accepted and marked on the returned description (`NOT SELECTED` tab, `MINIMISED` window, `HIDDEN` iTerm2, `OFF SCREEN` window, `SMALL` pane). Each mark is logged (`PANE-MARK`, `PANE-SMALL`) and the pane auditor shows `NOT SELECTED`, `MINIMISED` and `SMALL` without alarming.
- **No pane at all** (no tmux or `ITERM_SESSION_ID`, a Claude background session with no attached terminal, a failed split, a follow command that never starts) starts the worker without one. The ledger gets `WORKER-NO-PANE` with the reason, `status.pane` records it, the auditor shows `NO PANE` with that reason, and `pai worker pane <id>` opens one later. PAI never opens a `claude attach` tab or any new tab or window to make a pane possible.
- `--no-pane`, `PAI_WORKER_AUTOPANE=0` and the keepalive beat need no override any more.
