# Setting up a project for workers: `pai project init`

One command puts a project on the right path; one command lists what is still
missing.

## `pai project init`

Run it inside the project (MCP: `project_setup`). It asks for nothing it can
detect: the git toplevel, the origin kind (forge or github.com) and the existing
`.pai/` files.

| Writes | Content |
|--------|---------|
| `.pai/project.yaml` | `sink: forge` for a non-GitHub origin, `sink: todo` for github.com or no origin. `anchor`/`marker` only when passed or already present. |
| `.pai/worker.md` | A short generic starter, only when missing. |

Flags: `--anchor <n>`, `--marker <text>` (forge sink, see
[project-status-sink.md](project-status-sink.md)); `--dry-run` (print what would
be written, write nothing); `--force` (overwrite, old copy kept as `.bak`; an
existing anchor and marker survive). Without `--force` nothing is overwritten.
Init never searches issues for an anchor.

After writing, init runs the checks below.

## `pai project health`: the project checks

Inside a git checkout, `pai project health` (MCP: `project_health`) ends with
one line per check, `ok - <what>` or `missing - <what> - fix: <one command>`:

| Check | Fix |
|-------|-----|
| `.pai/project.yaml` present / valid | `pai project init` / `pai project init --force` |
| forge sink: token, anchor reachable, marker matches | `pai config set forge.token <token>`, `pai project init --force --anchor <issue> --marker <text>` |
| `.pai/worker.md` present, within 16 KB | `pai project init` / `$EDITOR .pai/worker.md` |
| iTerm host session for worker panes (tmux needs none) | `pai worker pane --check` |
| daemon running, started after the installed build | `pai daemon restart` |

A release does not restart the daemon; a daemon older than the build still runs
old code, hence the last check.

## Topics

[worker-panes.md](worker-panes.md) · [worker-pane-footer.md](worker-pane-footer.md) ·
[worker-snapshots.md](worker-snapshots.md) · [worker-rules.md](worker-rules.md) ·
[project-status-sink.md](project-status-sink.md) · [issue-claims.md](issue-claims.md) ·
[worker-denials.md](worker-denials.md)
