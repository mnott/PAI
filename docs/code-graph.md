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

- `code_summary` — `target` (a key `code:<slug>:<path>`, a directory or a file path; `.` is the repo), optional `root`. Returns the stored module or repo summary.

Headless workers (local and cloud) get these three tools with the `pai` MCP server, and their guidance tells them to call `code_explore` before grepping an unfamiliar repo.

## Module and repo summaries

`pai code summarize [--project <slug>|--all] [--changed]` writes a short summary for every module (a directory with source files) and for the repo: purpose in one or two sentences, entry points, what it depends on and what depends on it. The purpose comes from the local model only (it fails when none is running, never a cloud model), fed a bounded digest of signatures, one-line doc comments and top references; entry points and dependencies come straight from the graph. It runs at background priority, one module at a time.

Rows live in `code_summaries` next to the graph (key `code:<slug>:<path>`, the model, a source hash, the time). A module is regenerated only when its source hash changed; `--force` redoes all. Each summary is also stored as a memory chunk, so the normal embed pass embeds it and `memory_search` finds it. The daemon runs `pai code summarize --all --changed` once a day in the maintenance cycle, for projects whose graph is already indexed. `pai code summary <key|path>` and `code_summary` read a summary back, and `code_explore` adds the summaries of the modules its symbols live in.

## Languages and limits

- Parsed: TypeScript/TSX, JavaScript, Swift, Python. Other files get a file row only.
- Files over 1 MB are skipped, as are `node_modules`, `dist`, `build` and `vendor`.
- Files come from `git ls-files`, so untracked and ignored files are not indexed.
- The index is reconciled with the repo when you query it; there is no file watcher.
