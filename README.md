# PAI Knowledge OS

PAI is an operating layer for Claude Code. It gives every session a memory: notes written in the background, searchable across sessions, projects and vaults, all stored locally. It also lets one Claude Code session delegate work to workers on any provider, a local model first, over three delegation tiers with routing policy, escalation and limits. A router and a cockpit page show what the models, the worker pool and your token budget are doing.

![The PAI router cockpit: cloud limits, local model status, system load and power, worker pool, tokens and cache hit ratio per provider, speed per model](docs/images/cockpit.png)

*The router cockpit (`http://127.0.0.1:8790/cockpit`). See [the cockpit page](docs/cockpit.md).*

## Install

Prerequisites: [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer. Docker is only needed if you choose PostgreSQL.

**With the install skill (recommended).** Two commands inside Claude Code add this repository as a plugin marketplace and install the `pai` plugin, whose `setup` skill does the install:

```
/plugin marketplace add mnott/PAI
/plugin install pai@pai
```

Then say **"set up PAI"**. The skill checks each phase first (package, `pai setup`, daemon, first workers) and does only what is missing.

**From a clone or the npm package.** Load the plugin for one session instead of installing it:

```bash
npm i -g @tekmidian/pai
claude --plugin-dir "$(npm root -g)/@tekmidian/pai"
```

**Without the plugin.** Install the package and run the wizard yourself:

```bash
npm i -g @tekmidian/pai
pai setup                     # interactive; or: pai setup --yes --storage sqlite
pai daemon status             # should show "running"
```

Details, storage choices, the daemon and updates: [docs/install/index.md](docs/install/index.md).

## Where to go next

### Install

[Install](docs/install/index.md) · [First workers](docs/install/first-workers.md)

### Concepts

Orchestration first: [delegation tiers](docs/concepts/delegation-tiers.md) · [routing policy](docs/concepts/routing-policy.md) · [escalation](docs/concepts/escalation.md) · [workers](docs/concepts/workers.md) · [panes](docs/concepts/panes.md) · [pool](docs/concepts/pool.md) · [local models](docs/concepts/local-models.md) · [router](docs/concepts/router.md) · [loop guard and limits](docs/concepts/loop-guard-and-limits.md) · [notifications](docs/concepts/notifications.md) · [session profiles](docs/concepts/session-profiles.md) · [providers](docs/concepts/providers.md)

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

PAI Knowledge OS is inspired by [Daniel Miessler](https://github.com/danielmiessler)'s concept of Personal AI Infrastructure and his [Fabric](https://github.com/danielmiessler/fabric) project — a Python CLI for augmenting human capabilities with reusable AI prompt patterns. Fabric is excellent and solves a different problem; PAI takes the same philosophy in a different direction: persistent memory, session continuity, and deep Claude Code integration. See [FEATURE.md](FEATURE.md) for a detailed comparison.

The automatic observation capture system — classifying tool calls into structured observations with progressive context injection — is inspired by [claude-mem](https://github.com/thedotmack/claude-mem) by [thedotmack](https://github.com/thedotmack). claude-mem demonstrated that automatic memory capture during Claude Code sessions dramatically improves continuity. PAI adapts this concept with a rule-based classifier, PostgreSQL storage, and three-layer progressive disclosure.

The three-store hybrid memory architecture — combining SQLite/PostgreSQL chunks with a knowledge graph and vector embeddings, graph-completion search (vector seeds → graph traversal → re-rank), and the feedback EMA relevance loop — is inspired by [Cognee](https://github.com/topoteretes/cognee) by [topoteretes](https://github.com/topoteretes). Cognee showed that unifying structured knowledge graphs with unstructured vector retrieval produces dramatically better recall. PAI adapts this pattern to the personal knowledge OS context with project-scoped multi-tenancy and content-address entity deduplication.

Section-aware retrieval (heading paths on chunks, `memory_outline`) borrows from [PageIndex](https://github.com/VectifyAI/PageIndex) by [VectifyAI](https://github.com/VectifyAI), which retrieves from long documents by navigating a heading tree rather than by similarity alone. PAI keeps its keyword, vector and graph search and adds the tree as structure the model can navigate, without an LLM call per query.

## License

MIT
