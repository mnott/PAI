# PAI documentation

**Start here: [everything PAI does](features.md)**: every capability by family, with the command or phrase to use.

## Words used in these docs

- **PAI home**: the directory where PAI keeps its files (`config.yaml`, `workers.yaml`, keys, logs, state). It is `~/.pai`; installs from before the move use `~/.claude/pai` until `pai home migrate` is run. `pai home path` prints the one in use, `pai worker config path` prints the path of `workers.yaml`. Details: [PAI home](pai-home.md). Where a page writes `<PAI home>`, read this directory.
- **worker**: a background Claude Code run that PAI starts for a task, usually in its own git checkout, while your session keeps going.
- **provider**: an API endpoint plus a key that workers run on. The built-in `anthropic` provider is your own Claude Code login.
- **class**: a kind of job (`implement`, `research`, `simple`, ...) that maps to a tier and a provider.
- **tier**: a role (t0 session, t1 orchestrator, t2 worker) that holds an ordered list of models; the first available model serves, the rest is the fallback order.
- **runtime**: a local engine that serves a model on your machine, such as ollama or vllm-mlx.
- **pane**: the tmux or iTerm2 split a worker shows its output in.
- **salvage**: when a run is stopped, its uncommitted edits are committed on the worker's branch so nothing is lost.
- **router**: an optional local service (127.0.0.1:8790) that records usage per provider, schedules local runtimes and serves the cockpit.

## Install

- [Install](install/index.md): the package, the install skill, `pai setup`, storage, the daemon, updates
- [First workers](install/first-workers.md): your first worker, providers, the delegation table, router and cockpit
- [Linux notes](install-linux.md) · [VM bootstrap](vm-bootstrap.md)

## Concepts

Orchestration, in reading order:

- [Workers](concepts/workers.md): what a worker is, how to start one, merge its result
- [Delegation tiers](concepts/delegation-tiers.md): which model serves which role
- [Panes](concepts/panes.md): where a worker's output shows (needs tmux or iTerm2)
- [Providers](concepts/providers.md): the endpoints workers run on
- [Routing policy](concepts/routing-policy.md): local or cloud, per run
- [Escalation](concepts/escalation.md): what happens when a run fails or stops
- [Local models](concepts/local-models.md): running a model on your own machine
- [Router](concepts/router.md): usage accounting and the cockpit service
- [Pool](concepts/pool.md): warm spare workers
- [Loop guard and limits](concepts/loop-guard-and-limits.md): stopping runaway runs
- [Security rules](concepts/security-rules.md): rule files, severities, the audit scan
- [Lessons](concepts/lessons.md): review-gated notes, promoted to skills
- [Handoff](concepts/handoff.md): carry a session to another session, and git notes
- [Notifications](concepts/notifications.md): what reaches your phone
- [Session profiles](concepts/session-profiles.md): per-session settings

Deeper worker material: [worker reference (long)](worker.md) · [workers.yaml](workers-config.md) · [large coding jobs](three-tier-coding.md) · [project setup](worker-project-setup.md) · [issue claims](issue-claims.md) · [hook denials](worker-denials.md)

## Cockpit

- [The cockpit page](cockpit.md): sections, aliases, layout

## Memory

PAI keeps session memory in a local database (SQLite, or PostgreSQL with pgvector for semantic search). A background daemon indexes your Claude Code projects and session notes about every five minutes, and Claude searches the index by keyword, meaning, or both.

- [Memory](memory.md) · [Search](search.md)
- [Observations](observations.md) · [Session notes](session-notes.md)
- [Context preservation](context-preservation.md) · [Auto-compact](auto-compact.md)
- [Session management](session-management.md) · [Zettelkasten](zettelkasten.md) · [Rules and privacy](rules-and-privacy.md)
- [PAI home](pai-home.md) · [Task bus](task-bus.md)
- [What you can ask](what-you-can-ask.md) · [Use cases](use-cases.md) · [Skills](skills.md)

## Reference

- [Configuration](config.md) · [Shipped defaults](config-defaults.md) · [workers.yaml keys](workers-config.md) · [Listing models](model-catalogue.md)
- [Commands](commands/README.md): one generated page per `pai` command. Read them in the terminal with `pai help` (daily commands), `pai more` (all, grouped), `pai help <command>`.
- [Release history](release-history.md) · [CHANGELOG](../CHANGELOG.md)

## Developers

- [Design notes](design/postgres-only.md) · [registry method map](design/registry-method-map.md)
- [MCP skill guide](dev/mcp-skill-guide.md)
- [Config migration log](dev/config-migration-log.md): constants moved from code into the shipped defaults
- [Cockpit page source layout](dev/cockpit-page.md): which file holds which part of the cockpit page
- [ARCHITECTURE](../ARCHITECTURE.md) · [Plugin architecture](../PLUGIN-ARCHITECTURE.md)
- Building from a checkout needs Bun (`bun install && bun run build`); the installed `pai` runs on Node 20 or newer.

## Companion projects

By the same author: [AIBroker](https://github.com/mnott/AIBroker) (WhatsApp, Telegram and PAILot message bridge), [Whazaa](https://github.com/mnott/Whazaa) (WhatsApp), [Telex](https://github.com/mnott/Telex) (Telegram), [Coogle](https://github.com/mnott/Coogle) (Google Workspace MCP daemon), [DEVONthink MCP](https://github.com/mnott/devonthink-mcp).

## Acknowledgments

PAI is inspired by [Daniel Miessler](https://github.com/danielmiessler)'s Personal AI Infrastructure and his [Fabric](https://github.com/danielmiessler/fabric); see [FEATURE.md](../FEATURE.md) for a comparison. Automatic observation capture follows [claude-mem](https://github.com/thedotmack/claude-mem) by thedotmack. The hybrid memory (chunks, knowledge graph, vector embeddings, graph-completion search, feedback relevance loop) follows [Cognee](https://github.com/topoteretes/cognee) by topoteretes. Section-aware retrieval (heading paths, `memory_outline`) borrows from [PageIndex](https://github.com/VectifyAI/PageIndex) by VectifyAI.
