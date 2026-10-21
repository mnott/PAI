# Use Cases

Typical situations and the PAI pieces that help. The same material, with the phrases to ask, is in the [User Manual](../MANUAL.md#use-cases).

| Situation | What helps |
|---|---|
| Re-explaining a project every morning, or after context compaction | "Go" reads the `## Continue` block of `TODO.md` ([session management](session-management.md)); the PreCompact/PostCompact relay ([context preservation](context-preservation.md)) |
| "Why did we choose X?" months later | `pai memory search` and decision observations ([search](search.md), [observations](observations.md)) |
| Many projects or clients in rotation | Project registry; `pai ls`, `pai <name>`; per-project search with `--project` |
| Several papers or topics with their own context | One PAI project per topic; `which project am I in?` detects it from the folder |
| Writing up what you shipped | `/review`, `/share` ([skills](skills.md)) |
| A large Obsidian vault with hidden links | `pai zettel surprise`, `themes`, `health`, `suggest` ([zettelkasten](zettelkasten.md)) |
| Reusing earlier findings or runbooks | Memory search across all projects (`all_projects`); facts with dates in `pai kg query` ([memory](memory.md)) |
| Keeping a team's reasoning findable | Each person's session notes and observations stay searchable on their own machine |
| Filing work from a phone | The [task bus](task-bus.md) |
