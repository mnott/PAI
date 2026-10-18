# Session Management

PAI gives you a complete picture of every Claude Code session running on your machine — live tabs in iTerm2, paused snapshots on disk, and everything in between.

## The Core Idea: One Entry Point

Two ways in, both forgiving:

- **`pai`** (no args) — opens the **interactive picker**: type to search across projects *and* sessions, then act on the highlighted row with a single key.
- **`pai <name>`** — the universal session command when you already know the name. It does the right thing based on session state:
  - **Live session** — switches the iTerm2 tab to front (no new Claude launched)
  - **Otherwise** — starts a fresh Claude in the project directory, on the configured route. If a resumable transcript exists it asks `Resume it? [y/N]` first (Enter keeps fresh); `--resume` or `pai resume <name>` resume without asking; `-y` skips the question.
  - **No match** — searches `~/.claude/history.jsonl`, shows a candidate picker

```bash
pai                 # Interactive picker — search, then go / new / cd / finder / remove
pai aibroker        # Switch to the live AIBroker tab (iTerm comes to front)
pai youdrill        # Fresh youdrill session; offers to resume the last transcript
pai mdf             # Free-text search across your prompt history
pai 0856d40b        # Resume by UUID prefix
pai --list          # Static deduped table (the old no-args behaviour)
```

## Daily Commands

```bash
pai                   # Interactive picker (projects + sessions; search then act)
pai --list            # Static deduped listing (one row per name)
pai <name>            # Switch / resume / fresh — universal
pai pause             # Save state checkpoint (write ## Continue to TODO.md)
pai pause all         # Pause every live Claude session at once
pai end               # Finalize: save state + mark session note Completed
```

And inside Claude Code, the two slash commands that matter:

```
/pause    →  write checkpoint to TODO.md, print handoff block, then type /exit
/end      →  same as /pause, plus marks the session note Completed
```

## The Interactive Picker

Run `pai` with no arguments to open a self-contained terminal selector (no `fzf` or other dependency) over a **unified, deduped list of both projects and sessions** — tagged so the two stay distinct. It's the one place to answer "where did I work on X, and take me there."

```
  pai  —  find a project or session
  search > samba

  live      Chenarlier   now   …/Raspi/Chenarlier   samba setup monster reverse proxy
  project   Glidr        2d    …/apps/glidr          claude pai research

  ────────────────────────────────────────
  Chenarlier   ~/…/Raspi/Chenarlier
  recent notes:
    10 - Samba Setup/01 - Samba Server Setup.md   1mo
    00 - Monster/00 - Monster.md                  3mo
  ────────────────────────────────────────
  g go to tab · n new · c cd · f finder · d remove · s search · ↑↓ move · q quit
```

**Two modes.** You start in *command mode* (single keys are actions). Press `s` (or `/`) to enter *search mode* (type a topic — it filters by name, path, **and folded-in note file/folder names**, so `samba` finds a project literally named "Chenarlier"); `Enter` or `esc` returns to command mode.

**Command keys** act immediately on the highlighted row:

| Key | Action |
|-----|--------|
| `g` | **Go to** the running iTerm2 tab (for live rows) |
| `n` | **New** Claude session in that directory (current terminal) |
| `c` | **cd** into the folder only — no Claude (your shell stays there) |
| `f` | Open the folder in **Finder** / Explorer / `xdg-open` (keeps the picker open) |
| `d` | **Remove** from PAI's list — archives the project (reversible, files untouched); asks `y/N` first |
| `s` `/` | Enter **search** mode |
| `↑↓` `j` `k` | Move the highlight |
| `q` `esc` | Quit |

`Enter` on a row takes the smart default: a live row → go to its tab, otherwise → new session.

The `c` (cd) action needs PAI's shell integration to change your shell's directory — see [Finding the Claude Binary](#finding-the-claude-binary) / `pai shell-init`. On a non-interactive terminal (piped output), `pai` falls back to the static listing automatically.

## Static Listing

`pai --list` shows a single deduped table — one row per session name, regardless of how many snapshots exist on disk:

```
Sessions:

  #   name        status      age       project                       last prompt
  --  ----------  ----------  --------  ----------------------------  --------------------------
  1   AIBroker    live        now       —                             —
  2   PAI         resumable   2m ago    /…dev/ai/PAI                  "refactor session listing…"
  3   MDF         transcript  3d ago    /…MDF/Infrastruktur/Webseiten "ok so we recently had…"
```

Status values: `live` (active iTerm tab), `resumable` (clean snapshot on disk), `transcript` (history available, not resumable), `stub` (empty or minimal).

## Finding Sessions by Topic

`pai <topic>` first checks session names, then falls back to searching your prompt history:

```
Sessions matching "mdf":

  #  id        when              project                              last matching prompt
  -  --------  ----------------  -----------------------------------  -------------------------
  1  6269cf64  2026-05-21 08:20  /…MDF/Infrastruktur/20 - Webseiten  "ok so we recently had an order…"
  2  abe2d977  2026-02-23 08:40  /…MDF/Infrastruktur/20 - Webseiten  "yes the session notes for Whazaa…"

  Enter # to launch (1-2), or press Enter to cancel:
```

Use `pai <topic> --auto` (or `-y`) to auto-pick #1. Use `pai <topic> 2` to pick directly.

## Power User Access

The full session management namespace is still available:

```bash
pai sessions              # Live + disk listing (with more columns)
pai sessions --all        # Include unnamed orphan sessions
pai sessions --all-tabs   # Include shell tabs in the live section
pai sessions goto <name>  # Named-session resolver (same as pai <name>)
pai sessions list         # Explicit listing (same as pai sessions)
```

## Pausing All Sessions at Once

When you're done for the day and have multiple Claude windows open:

```bash
pai pause all             # send "pause session" to every live Claude pane
pai pause all --dry-run   # preview what would be sent
pai pause all --exit      # also send /exit after each session saves state
```

AIBroker must be running for this to work. Shell tabs (bare zsh, SSH panes) are automatically skipped — only Claude Code panes receive the pause command. The count of skipped tabs is printed to stderr.

## /pause and /end Inside Claude Code

Type `/pause` or `/end` from inside an active Claude Code session (not from a shell — these are Claude Code slash commands, not CLI commands):

- `/pause` — Claude writes a `## Continue` block to the project's `TODO.md`, prints a handoff summary with the session ID, then tells you to type `/exit`. The next session starts by reading that TODO.md block and picking up exactly where you left off.
- `/end` — Same as `/pause`, plus Claude marks the session note as Completed and writes a final summary. Use this when you're genuinely done with a topic, not just pausing mid-task.

After either command, type `/exit` to exit Claude Code cleanly.

## Why /exit and Not Ctrl+C

Ctrl+C or closing the terminal kills the Claude Code process abruptly. The session note generation hook never fires, the checkpoint is not written, and the session cannot be resumed with `claude --resume`.

`/exit` sends a clean shutdown signal. Claude Code runs its Stop and Session End hooks, which trigger PAI to write the session note, push the final summary to the daemon, and save a resumable snapshot. The difference in recovery quality between a clean `/exit` and a Ctrl+C is significant for long sessions.

If you do accidentally close a terminal, use `pai sessions --all` to find the orphaned transcript. The `/reconstruct` skill can retroactively generate a session note from it.
