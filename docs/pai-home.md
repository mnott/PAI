# PAI home

PAI keeps everything it owns in one directory, **`~/.pai`**. It does not live
inside Claude Code's directory: PAI has to work independent of any one harness,
and nothing PAI writes should be able to collide with files Claude Code itself
adds under `~/.claude`. (Operator decision 2026-09-20, reconfirmed 2026-10-19.)

## Resolution

One helper, `paiHomeDir()` in `src/config/pai-home.ts`:

1. `$PAI_HOME`, if set.
2. `~/.pai`.
3. Exception, until the move has happened: if `~/.pai/config.yaml` does not exist
   but `~/.claude/pai/config.yaml` does, `~/.claude/pai` keeps being used, so
   nothing breaks before `pai home migrate` is run.

Shell scripts (statusline, `session-stop.sh`, `pre-compact.sh`) and
`scripts/lib/sync-guard.mjs` cannot import the helper; they apply the same three
rules inline. `pai home path` prints the result.

## What lives where

| Path | What |
|---|---|
| `~/.pai/config.yaml`, `workers.yaml`, `session-profiles.yaml`, `voices.yaml` | settings |
| `~/.pai/keys/` | API keys parked by `pai worker providers add` (mode 0600) |
| `~/.pai/pgdata/` | Postgres data directory (bind-mounted into the `pai-pgvector` container); never touched by any migration |
| `~/.pai/History/`, `agent-sessions.json`, `session-routing.json` | session history and routing |
| `~/.pai/backups/` | `pai backup` output |
| `~/.pai/logs/` | daemon/router logs, worker logs and worker worktrees (`logs/workers/`), build queue |
| `~/.pai/obsidian-vault/`, `queries/`, `state/`, caches | derived data |
| `~/.pai/attic/<date>/` | leftovers of earlier moves, parked by `pai home migrate` |

`~/.claude` keeps only what Claude Code needs at fixed paths: `settings.json`,
`hooks/`, `skills/`, `agents/`, the statusline, `CLAUDE.md`, `projects/`. PAI's
parts there are symlinks or commands pointing into PAI. `~/.claude/pai` stays
as a symlink to `~/.pai` so old paths keep resolving.

## Moving: `pai home migrate [--dry-run]`

Stops nothing itself. It refuses to run while the PAI daemon, the router or any
worker is running, and says what to stop (`pai daemon uninstall`,
`pai router stop`, `pai worker kill <id>`; reinstall the daemon afterwards).

What it does:

1. Plans first. Any entry present in both `~/.claude/pai` and `~/.pai` is a name
   clash: the run stops with the list and changes nothing. `pgdata` and `attic`
   are never moved, so a `pgdata` in the old home is a clash.
2. Renames every entry of `~/.claude/pai` into `~/.pai` (same volume, no copy;
   refuses across volumes).
3. Leftovers (`*.migrated-*`, `*.bak`, `*.bak-*`, `*.tar`, `*.tar.gz`, `*.tgz`,
   and a stray `.DS_Store`), from either home, go to `~/.pai/attic/<date>/`.
4. Replaces `~/.claude/pai` with a symlink to `~/.pai`.
5. Rewrites absolute `~/.claude/pai` / `$HOME/.claude/pai` / `<home>/.claude/pai`
   paths in `config.yaml`, `config.json`, `workers.yaml`, `voices.yaml` (including
   `key_file` paths) and in launchd plists named `com.pai.*.plist`. Reload
   plists afterwards (`pai daemon install`).
6. Prints a before/after table with sizes.

`--dry-run` prints the same plan and table and changes nothing, and still lists
what is running.
