# Install

PAI needs Node 20 or newer and Claude Code. Bun is a development tool only; you do not need it to install or run PAI.

## The short way: the install skill

The repository is its own Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Inside Claude Code:

```
/plugin marketplace add mnott/PAI
/plugin install pai@pai
```

The plugin ships an install skill (`plugins/core/skills/setup/SKILL.md`). From a clone or an npm install, load it for one session instead:

```bash
claude --plugin-dir /path/to/PAI                         # a clone
claude --plugin-dir "$(npm root -g)/@tekmidian/pai"      # after npm i -g @tekmidian/pai
```

Then tell Claude Code: "set up PAI". The skill walks through the phases below, checks each one first and does only what is missing. Everything it does is also a plain command, so you can follow this page by hand.

## Phases

| Phase | Command | Verify |
|---|---|---|
| Prerequisites | `node --version`, `claude --version`, `git --version` | all print a version, Node is 20 or newer |
| Package | `npm i -g @tekmidian/pai` | `pai --version` |
| Setup | `pai setup` or `pai setup --yes --storage sqlite` | ends without error; `pai memory search "test"` runs |
| Daemon | `pai daemon status` | says running; if not, `pai daemon install`, then `pai daemon restart`, then `pai daemon logs` |
| First workers | see [first-workers.md](first-workers.md) | `pai worker route` |
| After updates | `pai reload` | one line per restarted process |

`pai setup` covers storage, search embeddings, Claude Code hooks and settings, the daemon and the first index. It is safe to run again. `--yes` takes every default; without `--storage` it picks sqlite unless a local Postgres answers.

### Storage

- **sqlite**: keyword search, nothing else to install. Right for most machines, and for small ones.
- **postgres**: keyword and semantic search. Needs Docker; setup starts the `pai-pgvector` container itself (`pgvector/pgvector:pg17`, bound to 127.0.0.1:5432). On a small machine set `PAI_PG_SHARED_BUFFERS=256MB` first; `PAI_PG_SHM_SIZE` sets the container's shared memory.

### The daemon

Setup installs it as a login service: launchd on macOS, a systemd user unit on Linux. It indexes your sessions and serves the MCP tools.

```bash
pai daemon status
pai daemon install     # re-create the service
pai daemon restart
pai daemon logs
pai daemon serve       # foreground, where there is no service manager
```

### Updating

```bash
npm i -g @tekmidian/pai@latest
pai reload
```

`pai reload` restarts the daemon, the router and the worker pool host onto the code on disk. (`pai update` is for a source checkout: it pulls, rebuilds and restarts the daemon.)

## macOS from a clean machine

Git and Python in `/usr/bin` can be stubs that fail until the Xcode command line tools exist, so trust `git --version`, not `command -v git`. Install the command line tools (`xcode-select --install` with a GUI session; headless, use `softwareupdate -l` and `softwareupdate -i` for the "Command Line Tools" label), then Homebrew, Node, Claude Code, and optionally Docker. On an 8 GB machine use sqlite first and add Postgres later.

## Linux (Ubuntu)

Run end to end on a fresh Ubuntu: setup, daemon, statusline and a real `pai worker run`.

```bash
sudo apt install -y nodejs npm tmux
npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"
npm i -g @tekmidian/pai
pai setup --yes --storage sqlite
```

For Postgres add `sudo apt install -y docker.io docker-compose-v2`, put your user in the `docker` group (log out and in), then `pai setup --yes --storage postgres`; data lives in `~/.pai/pgdata`.

Setup skips macOS-only steps, installs the systemd user unit and enables linger so the daemon survives logout (if the system refuses, it prints the `sudo loginctl enable-linger` command). Inside tmux, `pai worker run` opens its follow pane as a split; elsewhere use `pai worker follow <id>`. Without systemd (containers) run `pai daemon serve`.

## Verify everything

```bash
pai --version
pai daemon status
pai memory search "test"
pai worker providers
pai worker route
pai            # the session picker opens, Esc quits
```

## Concepts

[Panes](../concepts/panes.md) · [Worker pool](../concepts/pool.md) · [Router](../concepts/router.md) · [Local models](../concepts/local-models.md) · [Loop guard and limits](../concepts/loop-guard-and-limits.md) · [Notifications](../concepts/notifications.md)
