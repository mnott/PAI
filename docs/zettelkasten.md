# Zettelkasten Intelligence

PAI implements Niklas Luhmann's Zettelkasten principles as six computational operations on your Obsidian vault.

## How it works

PAI indexes your entire vault — following symlinks, deduplicating by inode, parsing every link — and builds a graph database alongside semantic embeddings. Six tools then operate on this dual representation:

| Tool | What it does |
|------|-------------|
| `pai zettel explore` | Follow trains of thought through link chains (Folgezettel traversal) |
| `pai zettel surprise` | Find notes that are semantically close but far apart in the link graph |
| `pai zettel converse` | Ask questions and let the vault "talk back" with unexpected connections |
| `pai zettel themes` | Detect emerging clusters of related notes across folders |
| `pai zettel health` | Structural audit — dead links, orphans, disconnected clusters, health score |
| `pai zettel suggest` | Proactive connection suggestions combining semantic similarity, tags, and graph proximity |

All tools work as CLI commands (`pai zettel <command>`) and MCP tools (`zettel_*`) accessible through the daemon.

## Vault Indexing

The vault indexer follows symlinks (critical for vaults built on symlinks), deduplicates files by inode to handle multiple paths to the same file, and builds a complete link graph with Obsidian-compatible shortest-match resolution.

All link types are parsed and resolved:

| Syntax | Type | Example |
|--------|------|---------|
| `[[Note]]` | Wikilink | `[[Daily Note]]`, `[[Note\|alias]]`, `[[Note#heading]]` |
| `![[file]]` | Embed | `![[diagram.png]]`, `![[template]]` |
| `[text](path.md)` | Markdown link | `[see here](notes/idea.md)`, `[ref](note.md#section)` |
| `![alt](file)` | Markdown embed | `![photo](assets/img.jpg)` |

External URLs (`https://`, `mailto:`, etc.) are excluded — only relative paths are treated as vault connections. URL-encoded paths (e.g. `my%20note.md`) are decoded automatically.

- Full index: ~10 seconds for ~1,000 files
- Incremental: ~2 seconds (hash-based change detection)
- Runs automatically via the daemon scheduler
