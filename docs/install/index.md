# Install

PAI needs Node 20 or newer and Claude Code (Bun is for building from a checkout only). Terms such as provider, tier or pane are explained in the [glossary](../README.md#words-used-in-these-docs).

## The short way: the install skill

The repository is its own Claude Code plugin marketplace (`.claude-plugin/marketplace.json`). Inside Claude Code:

```
/plugin marketplace add mnott/PAI
/plugin install pai@pai
```

The plugin includes an install skill; you start it by saying "set up PAI". `/plugin` lists `pai` once it is installed. Without the marketplace, load the plugin for one session instead (repeat this each time you start Claude Code; for a permanent install use the marketplace):

```bash
claude --plugin-dir PAI                                  # a clone: git clone <repository URL> PAI
claude --plugin-dir "$(npm root -g)/@tekmidian/pai"      # after installing the package
```

Then tell Claude Code: "set up PAI". The skill walks through the phases below, checks each one first and does only what is missing, and ends with a pass/fail list. Everything it does is also a plain command, so you can follow this page by hand.

## Phases

| Phase | Command | Verify |
|---|---|---|
| Prerequisites | `node --version`, `claude --version`, `git --version` | all print a version, Node is 20 or newer |
| Package | `npm i -g https://github.com/<owner>/<repo>/releases/latest/download/pai.tgz` | `pai --version` |
| Setup | `pai setup` or `pai setup --yes --storage sqlite` | ends without error; `pai memory search "test"` prints hits or no results, but no error |
| Daemon | `pai daemon status` | prints `Daemon running` with a PID; if not, `pai daemon install`, then `pai daemon restart`, then `pai daemon logs` |
| First workers | optional, see [first-workers.md](first-workers.md) | `pai worker providers test anthropic` prints a reply and the time |
| After updates | `pai reload` | prints one line per restarted process |

`pai setup` covers storage, search embeddings, Claude Code hooks and settings, the daemon and the first index. The first index can take a few minutes on a large session history; search finds results once it is done. It is safe to run again. `--yes` takes every default; without `--storage` it picks sqlite unless a local Postgres answers.

### Storage

- **sqlite**: keyword search, nothing else to install. Right for most machines, and for small ones.
- **postgres**: keyword and semantic search. Needs Docker; setup starts the `pai-pgvector` container itself (`pgvector/pgvector:pg17`, bound to 127.0.0.1:5432). Small machines: see the note below.

Small machines: set `PAI_PG_SHARED_BUFFERS=256MB` before `pai setup`; `PAI_PG_SHM_SIZE` sets the container's shared memory.

### The daemon

Setup creates the PAI home (`~/.pai`; installs from before the move use `~/.claude/pai`; see [PAI home](../pai-home.md)) and installs the daemon as a login service: launchd on macOS, a systemd user unit on Linux. It indexes your sessions and serves the MCP tools. `pai daemon status` prints `Daemon running` and the PID when it is up.

```bash
pai daemon status
pai daemon install     # re-create the service
pai daemon restart
pai daemon logs
pai daemon serve       # foreground, where there is no service manager
```

### AIBroker (messaging)

[AIBroker](https://github.com/mnott/AIBroker) is a separate project and PAI's messaging layer: messages between sessions, worker reports to the session that started them, terminal tab names, and WhatsApp, Telegram and PAILot. PAI runs without it, but none of these work until it is installed:

```bash
npm i -g https://github.com/<owner>/<aibroker-repo>/releases/latest/download/aibroker.tgz
aibroker setup      # service, MCP registration, Claude Code hooks
aibroker doctor     # every check green, or it says exactly what to fix
```

### Setup questions and flags

`pai setup` asks the questions below in this order. Every one has a flag, so `pai setup --yes <flags>` answers any of them without a terminal; a question takes its default when the flag is absent, except one that has no default (for example the Todoist token with `--task-bus`), which needs the value as a flag or in the config. `pai setup --questions` (add `--json` for machines) prints this list for the current machine, with the value already in place where there is one. The setup skill uses it: it runs `pai setup --questions --json`, asks you in chat, then runs `pai setup --yes` with the matching flags.

| Question | Flag | Default | Allowed |
|---|---|---|---|
| Where to store data | `--storage` | `sqlite` (`postgres` if a local one answers) | `sqlite`, `postgres` |
| PostgreSQL connection string | `--pg-url` | the PAI Docker container | a `postgresql://` URL (implies `--storage postgres`) |
| Embedding model | `--embedding` | `snowflake` (Ollama is used when it is faster) | `snowflake`, `bge`, `nomic`, `ollama`, `none` |
| CLAUDE.md, PAI skill, steering rules, skill stubs, hooks, TypeScript hooks, settings.json, daemon, MCP, workers | `--no-claude-md`, `--no-skill`, `--no-steering-rules`, `--no-skill-stubs`, `--no-hooks`, `--no-ts-hooks`, `--no-settings`, `--no-daemon`, `--no-mcp`, `--no-workers` | yes | |
| Registry scan after setup, task bus (Todoist) | `--registry-scan`, `--task-bus` | no | |
| Assistant name | `--da-name` | `PAI` | any text |
| Router and cockpit | `--router` / `--no-router` | enabled | |
| Cockpit port | `--router-port` | `router.port` (8790); a port that is in use is refused and its holder shown | 1024 to 65535 |
| Who can reach the cockpit | `--router-bind` | `loopback` | `loopback`, `tailscale`, an IPv4 address (never 0.0.0.0) |
| AIBroker | `--no-aibroker` | installed | |

The router answers land in `config.yaml` as `router.enabled`, `router.port` and `router.bind` (see [config](../config.md)). Beyond `loopback` the cockpit is reachable from other devices, behind the token in `~/.pai/router-cockpit.token`.

### Updating

```bash
pai update          # latest GitHub Release; pai update --check only reports
pai update --package aibroker
pai reload
```

`pai reload` restarts PAI's background processes (the daemon and, when they run, the router and the worker pool host) onto the new code; run it after every update. `pai update` reads the installed version, asks GitHub for the latest release of the package's repository and runs `npm i -g` on its asset when it is newer. (`pai update --source` is for a source checkout: it pulls, rebuilds and restarts the daemon.)

## macOS from a clean machine

Git and Python in `/usr/bin` can be stubs that fail until the Xcode command line tools exist, so trust `git --version`, not `command -v git`. Install the command line tools (`xcode-select --install` with a GUI session; headless, use `softwareupdate -l` and `softwareupdate -i` for the "Command Line Tools" label), then [Homebrew](https://brew.sh), Node (`brew install node`, or [nodejs.org](https://nodejs.org)), [Claude Code](https://claude.com/claude-code), and optionally Docker. On an 8 GB machine use sqlite first and add Postgres later.

## Linux (Ubuntu)

Run end to end on a fresh Ubuntu: setup, daemon, statusline and a real `pai worker run`. Install [Claude Code](https://claude.com/claude-code) first.

```bash
sudo apt install -y nodejs npm tmux
node --version                  # must be v20 or newer
npm config set prefix ~/.npm-global && export PATH="$HOME/.npm-global/bin:$PATH"
npm i -g https://github.com/<owner>/<repo>/releases/latest/download/pai.tgz
pai setup --yes --storage sqlite
```

`apt install nodejs` gives an old Node (below 20) on many Ubuntu releases. If `node --version` prints less than v20, install a current Node first with [NodeSource](https://github.com/nodesource/distributions) or [nvm](https://github.com/nvm-sh/nvm) and drop `nodejs npm` from the `apt` line. `~/.npm-global/bin` must stay on PATH in your shell profile.

For Postgres add `sudo apt install -y docker.io docker-compose-v2`, put your user in the `docker` group (log out and in), then `pai setup --yes --storage postgres`; data lives in `~/.pai/pgdata`.

Setup skips macOS-only steps, installs the systemd user unit and enables linger so the daemon survives logout (if the system refuses, it prints the `sudo loginctl enable-linger` command). Inside tmux, `pai worker run` opens its follow pane as a split; elsewhere use `pai worker follow <id>`. Without systemd (containers) run `pai daemon serve`.

## Verify everything

```bash
pai --version
pai daemon status
pai memory search "test"
pai worker providers test anthropic
pai worker config check
pai            # the session picker opens, Esc quits
```

## Concepts

[Workers](../concepts/workers.md) · [Panes](../concepts/panes.md) · the rest in the [docs index](../README.md)
