# Code graph

The code graph indexes a repository's definitions and references so an agent (or you) can map unfamiliar code in one call instead of grepping, globbing and reading file after file.

## Storage

The index lives in PAI's own database: Postgres when it is configured, SQLite otherwise. Nothing is sent anywhere; there is no telemetry.

## Commands

```
pai code index [<root>] [--force]   index a repo (only changed files are re-read)
pai code explore <query...>         definitions, source, callers and blast radius for a question or symbol names
pai code search <query...>          find symbols by name
pai code callers <name>             where a symbol is called or used
pai code callees <name>             what a symbol calls or uses
pai code impact <name> [--depth N]  files and symbols a change could reach
pai code status                     what is indexed
```

All take `--root <dir>` (default: the repo around the current directory), `--json` and `--limit`; `explore` also takes `--budget <tokens>` and `--depth`. See [`pai code`](commands/code.md).

## MCP tools

- `code_explore` — `query` (a question or symbol names), optional `root`, `budget_tokens` (default 4000), `depth`. Use it instead of grep/glob/read to map an unfamiliar repo; it indexes the repo on first use.
- `code_search` — `query`, optional `root`, `limit`.
- `code_callers` — `name`, optional `root`, `limit`.

Headless workers (local and cloud) get these three tools with the `pai` MCP server, and their guidance tells them to call `code_explore` before grepping an unfamiliar repo.

## Languages and limits

- Parsed: TypeScript/TSX, JavaScript, Swift, Python. Other files get a file row only.
- Files over 1 MB are skipped, as are `node_modules`, `dist`, `build` and `vendor`.
- Files come from `git ls-files`, so untracked and ignored files are not indexed.
- The index is reconciled with the repo when you query it; there is no file watcher.
