# PAI Knowledge OS

PAI is an operating layer for Claude Code. From the first day it gives every session a memory: notes written in the background, searchable across sessions, projects and vaults, all stored locally. `pai` starts or resumes a Claude Code session in the current project, and `pai pause` and `pai end` save your place.

It can also hand work to cheaper background Claude Code runs (workers) on other providers or a local model, with a router and a cockpit page that show what the models and your token budget are doing. You do not need this to start. Terms are explained in the [glossary](docs/README.md#words-used-in-these-docs).

![Cockpit: system memory, load, temperature and power, local model server speed, and tokens per bucket and per day per model](docs/images/cockpit-01-system-tokens.jpg)

![Cockpit: totals in the window, cache hit ratio per model, local prefix cache and providers](docs/images/cockpit-02-totals-cache.jpg)

![Cockpit: local servers with their instances, the models with start and stop, and the worker pool](docs/images/cockpit-03-local-servers-models-pool.jpg)

![Cockpit: workers running and waiting, and the memory section with backend, passes, embedding and index progress](docs/images/cockpit-04-workers-memory.jpg)

![Cockpit: performance details with the cache verdict by pause and sessions by tokens](docs/images/cockpit-05-performance.jpg)

![Cockpit: worker runs, speed per model, and routing with one line per delegation tier](docs/images/cockpit-06-runs-speed-routing.jpg)

![Cockpit: settings with the model registry editor and its backups](docs/images/cockpit-07-settings-registry.jpg)

*The router cockpit (`http://127.0.0.1:8790/cockpit`). See [the cockpit page](docs/cockpit.md).*

## Install

Prerequisites: [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer. Docker is only needed for the optional PostgreSQL storage (semantic search); the default sqlite needs nothing.

Inside Claude Code, add this repository as a plugin marketplace and install the `pai` plugin:

```
/plugin marketplace add mnott/PAI
/plugin install pai@pai
```

Then say **"set up PAI"**. `/plugin` lists `pai` once it is installed. The skill checks each phase first and does only what is missing, and ends with a pass/fail list of its checks.

Without the plugin, from a clone, or for a one-session plugin load: [docs/install/index.md](docs/install/index.md). Memory works as soon as setup is done; workers are optional ([First workers](docs/install/first-workers.md)).

## Where to go next

### Install

[Install](docs/install/index.md) · [First workers](docs/install/first-workers.md)

### Concepts

[Workers](docs/concepts/workers.md) · [delegation tiers](docs/concepts/delegation-tiers.md) · [panes](docs/concepts/panes.md) · [providers](docs/concepts/providers.md), and the rest in [docs/README.md](docs/README.md).

### Cockpit

[The cockpit page](docs/cockpit.md): sections, aliases, layout.

### Reference

[Configuration](docs/config.md) · [Config defaults](docs/config-defaults.md) · [Commands](docs/commands/README.md) (generated from the CLI: `pai help`, `pai more`, `pai help <command>`)

The full index, including memory, search and developer docs, is [docs/README.md](docs/README.md).

## Daily use

```bash
pai                 # picker: newest sessions first, type to filter, Enter opens
pai NAME            # open a session by name
pai ls              # the same list as a plain table
pai more            # every other command, grouped
pai help <command>  # full help for one command
```

`pai pause` saves your place before you leave a session and `pai end` finishes it.

## Acknowledgments

Inspired by Daniel Miessler's Personal AI Infrastructure, claude-mem, Cognee and PageIndex. Full credit and links: [docs/README.md](docs/README.md#acknowledgments).

## License

MIT
