# Command Reference

Every `pai` command area has its own man page, **generated from the live CLI** so it never drifts from the actual commands. Read them three ways:

```bash
pai help            # list all command areas (the index)
pai help memory     # the full man page for one area, in your terminal
pai memory --help   # terse Commander help for any command
```

Browse the same pages on GitHub under [`docs/commands/`](commands/README.md). Each page lists every subcommand, its arguments and options, and worked examples. The reference below in this README is the *guided tour*; `docs/commands/` is the *complete reference*.

| Area | What it covers |
|------|----------------|
| [`pai memory`](commands/memory.md) | Federated search, indexing, embeddings |
| [`pai projects`](commands/projects.md) | Project registry: add, cd, info, health, rebind |
| [`pai kg`](commands/kg.md) | Temporal knowledge graph |
| [`pai zettel`](commands/zettel.md) | Zettelkasten intelligence over your vault |
| [`pai observation`](commands/observation.md) | Automatic tool-call observation capture |
| [`pai skill`](commands/skill.md) | Skill telemetry (self-educating skill system) |
| [`pai obsidian`](commands/obsidian.md) | Obsidian vault sync |
| [`pai daemon`](commands/daemon.md) | Daemon lifecycle |
| [`pai notify`](commands/notify.md) | Notification configuration |
| [`pai backup`](commands/backup.md) · [`pai restore`](commands/restore.md) | Data safety |
| … | See [the full index](commands/README.md) for all areas |
