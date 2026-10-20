# PAI documentation

## Install

- [Install](install/index.md): the package, the install skill, `pai setup`, storage, the daemon, updates
- [First workers](install/first-workers.md): providers, routing sanity check, router and cockpit
- [Linux notes](install-linux.md) · [VM bootstrap](vm-bootstrap.md)

## Concepts

Orchestration:

- [Delegation tiers](concepts/delegation-tiers.md)
- [Routing policy](concepts/routing-policy.md)
- [Escalation](concepts/escalation.md)
- [Workers](concepts/workers.md)
- [Panes](concepts/panes.md)
- [Pool](concepts/pool.md)
- [Local models](concepts/local-models.md)
- [Router](concepts/router.md)
- [Loop guard and limits](concepts/loop-guard-and-limits.md)
- [Notifications](concepts/notifications.md)
- [Session profiles](concepts/session-profiles.md)
- [Providers](concepts/providers.md)

Deeper worker material: [worker](worker.md) · [workers.yaml](workers-config.md) · [large coding jobs](three-tier-coding.md) · [project setup](worker-project-setup.md) · [issue claims](issue-claims.md) · [hook denials](worker-denials.md)

## Cockpit

- [The cockpit page](cockpit.md): sections, aliases, layout

## Memory

PAI keeps session memory in a local database (SQLite, or PostgreSQL with pgvector for semantic search). A background daemon indexes your Claude Code projects and session notes about every five minutes, and Claude searches the index by keyword, meaning, or both.

- [Memory](memory.md) · [Search](search.md)
- [Observations](observations.md) · [Session notes](session-notes.md)
- [Context preservation](context-preservation.md) · [Auto-compact](auto-compact.md)
- [Session management](session-management.md) · [Zettelkasten](zettelkasten.md) · [Rules and privacy](rules-and-privacy.md)
- [What you can ask](what-you-can-ask.md) · [Use cases](use-cases.md) · [Skills](skills.md)

## Reference

- [Configuration](config.md) · [Config defaults](config-defaults.md)
- [Commands](commands/README.md): one generated page per `pai` command. Read them in the terminal with `pai help` (daily commands), `pai more` (all, grouped), `pai help <command>`.
- [Release history](release-history.md) · [CHANGELOG](../CHANGELOG.md)

## Developers

- [Design notes](design/postgres-only.md) · [registry method map](design/registry-method-map.md)
- [MCP skill guide](mcp-skill-guide.md)
- [ARCHITECTURE](../ARCHITECTURE.md) · [Plugin architecture](../PLUGIN-ARCHITECTURE.md)
- Building from a checkout needs Bun (`bun install && bun run build`); the installed `pai` runs on Node 20 or newer.

## Companion projects

By the same author: [AIBroker](https://github.com/mnott/AIBroker) (WhatsApp, Telegram and PAILot message bridge), [Whazaa](https://github.com/mnott/Whazaa) (WhatsApp), [Telex](https://github.com/mnott/Telex) (Telegram), [Coogle](https://github.com/mnott/Coogle) (Google Workspace MCP daemon), [DEVONthink MCP](https://github.com/mnott/devonthink-mcp).
