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
pai worker pane --close-ended        # close every pane whose worker has ended
pai worker pane --close-ended --dry-run   # list what would close
```

`pai worker pane` prints `host session: <uid> via tty|env` on stderr, or
`host session: none (<reason>)`.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `host session: none (iTerm2 not running or unreachable)` | iTerm2 is not running, or its Python API is off. Start it, enable Scripting, retry `pai worker pane <id>`. |
| `no live iTerm2 session matched` | The terminal is not iTerm2 or tmux. Use `pai worker follow <id>`. |
| Panes of ended workers stay open | `pai worker pane --close-ended`. |
| No pane at all | Check `pai project health` in the project: the `iTerm host session` line says why. |

See also: [worker-pane-footer.md](worker-pane-footer.md).
