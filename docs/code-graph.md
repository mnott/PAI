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

## Relations across projects and domains

`pai code relate [--project <slug>]` reads the code graphs of the indexed registered projects (and the vault notes, when `vaultPath` is set) and writes relations to the knowledge graph (`kg_triples`; SQLite keeps the same table when Postgres is not configured). A relation that disappears on the next run gets `valid_to`; rows are never deleted.

Keys: `code:<project>[:<path>[#<symbol>]]`, `note:<vault>:<relative path>`, and external keys PAI only holds (`caseleaf:doc|mark|card|turn:<id>`, `caseleaf:passage:<doc>:<sha256>`, `cite:<citekey>`).

| Predicate | Meaning | Confidence |
| --- | --- | --- |
| `depends-on` | package.json / Package.swift / pyproject dependency on a sibling project | EXTRACTED |
| `calls-api` | a file uses an HTTP route or MCP tool another project defines | EXTRACTED (tool), INFERRED (route) |
| `shares-protocol` | the same message/schema type name in protocol-like files of two projects | INFERRED |
| `duplicates` | near-identical function bodies (normalized-token hash, at least 8 lines and 60 tokens) | INFERRED |
| `mentions` | a note links (`[[...]]`), backticks a path or names a symbol | EXTRACTED (path, project), INFERRED (symbol) |
| `cites` | a note holds a `caseleaf://` URL or `[@citekey]` | EXTRACTED |

Query: `pai graph related <key|path|symbol|project> [--depth 1-3] [--domain code,note,external]`, or the MCP tool `graph_related`. `code_explore` adds a "Related elsewhere" section for the matched symbols.

### External graph source

Optional and off by default. In the main config:

```yaml
externalGraph:
  enabled: true
  connectionEnv: PAI_EXTERNAL_GRAPH_URL   # name of an environment variable holding the Postgres connection string
  schema: paperfull_dms
  view: graph_edges
```

The view needs `src_key, dst_key, kind, page_hint, updated_at`. It is read at query time and never copied. When it is unreachable the answer ends with a one-line note and shows the rest.
