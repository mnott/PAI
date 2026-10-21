# Session Management

PAI lists every Claude Code session on your machine (running, resumable, or only a transcript) and opens, names and pauses them from one set of commands. `pai help` shows the daily ones, `pai more` the rest.

## Daily commands

```bash
pai                   # pick a session: type to filter, Enter opens it
pai <name>            # open a session by name; shows how it will start
pai ls                # sessions, newest first
pai new [DIR]         # start a session in a new or existing folder
pai pause             # save your place before leaving
pai end               # finish the current session
```

`pai <name>` resolves a session name, a project name or a session id (a prefix is enough). `pai ./dir` or `pai ~/dir` does the same as `pai new`. Without a match, `pai find "words"` searches everything you typed to Claude Code and lists the sessions where the words appeared.

## Listing: `pai ls`

One row per named session, with the provider and model it last ran on, its age, and a status:

| Status | Meaning |
|--------|---------|
| `live` | running now |
| `resumable` | can be reopened with its history |
| `transcript` / `stub` | partial history |
| `orphan` | unnamed; shown with `--all` |

Flags: `--project NAME`, `--all` (unnamed sessions, and more than the newest 25), `--workers` (sessions started by background workers, hidden by default), `--json`. `pai ls` is a shortcut for `pai session list`; `pai sessions` is the old plural form of the same namespace.

## Opening: `pai open` / `pai resume`

`pai open [NAME_OR_ID]` (alias `pai resume`) continues a session with its full history. The provider is chosen in this order: `--provider`, the provider the session last ran on, the active provider (`pai providers`). `--model ID` picks a model on that provider; `--dry-run` prints the command instead of running it. Without an argument you pick from a numbered list.

## Starting: `pai new`

`pai new [DIR]` creates DIR when missing (default: the current folder), registers it as a project and starts Claude Code there. Flags: `--with SETUP` (an orchestrator + worker combination from `pai setups`, nothing is asked), `--provider NAME`, `--model ID`, `--name NAME` (default: the folder name), `--dry-run`.

## Changing directory: `pai cd`

`pai cd PROJECT` prints a project's directory; the shell wrapper changes into it. It needs the shell integration: add `eval "$(pai shell-init)"` to your shell profile.

## Names and details

```bash
pai rename ID NAME            # change the name pai ls shows (history untouched)
pai session info <note>        # everything known about one session note
pai session tag <note>         # show or set tags
pai session route <note>       # link a note to another project
pai session active             # sessions active in the last hour
pai clear-names                # wipe stored tab names (recovery)
```

`pai session --help` lists all of them.

## Pausing and ending

`pai pause` writes a `## Continue` block to the project's `TODO.md` so the next session knows where you stopped, then tells you to leave with `/exit`. `pai end` does the same and marks the session note Completed. Inside Claude Code the same two actions are the `/pause` and `/end` skills (see [Skills](skills.md)); they write the checkpoint text and call `pai pause --body-file` / `pai end --body-file`.

| Flag | Meaning |
|------|---------|
| `--body-file FILE` | checkpoint text (`-` reads stdin); required unless `--no-body` |
| `--no-body` | metadata only |
| `--session-id UUID` | recorded as the handle for `claude --resume` |
| `--dry-run` | show what would be written |

### Pausing every live session

```bash
pai pause all                  # through AIBroker, every live Claude session
pai pause all --dry-run        # preview
pai pause all --only api       # only sessions whose name or id contains "api"
pai pause all --exit           # also send /exit once each has saved
pai pause all --wait 180000    # longest wait (ms) for a checkpoint; busy sessions are left open, never killed
```

AIBroker must be running. Shell tabs are skipped; only Claude Code panes receive the pause.

## Why /exit and not Ctrl+C

Ctrl+C or closing the terminal kills Claude Code abruptly: the Stop and SessionEnd hooks never fire, so no session note is written and no checkpoint saved. `/exit` runs the hooks, which write the session note and save a resumable snapshot. If a terminal was closed anyway, `pai ls --all` shows the orphaned transcript and the `/reconstruct` skill can build a session note from it.
