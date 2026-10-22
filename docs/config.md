# config.yaml

The router and cockpit answers (`router.enabled`, `router.port`, `router.bind`) are asked by `pai setup`; the questions and their flags are listed in [Setup questions and flags](install/index.md#setup-questions-and-flags).

The main PAI config: search defaults, storage backend, notifications, task bus, identity, the non-provider `workers` settings, the router and cockpit, plus whatever else a writer has stashed in the file. `pai config list|get|set|unset` and the matching `config_*` MCP tools read and change it whether the file is YAML or JSON; `pai config yaml` converts an old `config.json` to commented YAML; `pai config migrate` moves old per-user files into the PAI home.

## Shipped defaults and precedence

PAI ships its policy values as default files (`src/config/defaults/config.yaml` and `workers.yaml`). Lowest to highest:

1. the shipped defaults;
2. your `config.yaml` (and `workers.yaml` for the worker keys), deep-merged on top: objects merge, arrays replace, your values win.

So `config.yaml` only needs the keys you changed. `pai config get PATH --source` prints the value and says whether it came from your file or the shipped defaults; `pai config unset PATH` drops your value so the shipped one applies again. What the shipped defaults are, where they live and the key map by area: [config-defaults.md](config-defaults.md).

## File map

| File | Format | Read/written by |
|---|---|---|
| `config.yaml` | YAML, comment-preserving | preferred whenever it exists — `readMainConfigRaw`/`writeMainConfigRaw` (`src/daemon/config.ts`) |
| `config.json` | JSON | fallback when no `config.yaml` exists; unchanged pre-2026-09-20 behaviour |
| `workers.yaml` | YAML, comment-preserving | providers, tiers, classes, capabilities, mcp_sets, local tiers — see [workers-config.md](workers-config.md) |
| `voices.yaml` | YAML, comment-preserving | preferred whenever it exists — `loadVoicesConfig`/`migrateVoicesToYaml` (`src/config/voices-config.ts`) |
| `voices.json` | JSON | fallback when no `voices.yaml` exists |

All five live under the PAI_HOME namespace dir (`~/.pai` by default,
`PAI_HOME=<dir>` to move it; `pai config path` prints the resolved paths).

**State files stay JSON** — they are written many times a second by the
daemon or hooks, never hand-edited, and gain nothing from comments:
`advisor-mode.json`, `scheduler-state.json`, `work-queue.json`,
`session-routing.json`, `summary-cooldowns.json`, `kg-backfill-state.json`,
`registry-scan.json`, `session-scan-cache.json`. Only the two human-facing
config files above became YAML.

## Migrating

```
pai config yaml --dry-run   # print the plan, write nothing
pai config yaml             # convert config.json → config.yaml (and
                             # voices.json → voices.yaml), each JSON file
                             # renamed to <name>.json.migrated-<YYYY-MM-DD>
```

What changes on disk:
- A `#` comment is added above every top-level section, drawn from
  `PaiDaemonConfig`'s doc comments (`MAIN_CONFIG_SECTION_COMMENTS` in
  `src/config/main-config.ts`).
- Any `_comment` / `_...Note` JSON-comment-workaround key is folded into a
  real `#` comment above the key it was documenting, then dropped from the
  data.
- The generated YAML is re-parsed and checked byte-for-byte equal (as JSON)
  to the original before anything is written — a mismatch aborts with
  nothing touched.
- The JSON file is renamed to `config.json.migrated-<YYYY-MM-DD>` (never
  deleted) only after that check passes.
- Idempotent: re-running `pai config yaml` once `config.yaml` exists is a
  no-op unless you pass `--force` (which regenerates it from the current
  JSON, if any).

Every existing writer (identity, notifications, obsidian vault path,
setup wizard, memory search settings, the workers section) keeps working
unmodified — they all go through `readMainConfigRaw`/`writeMainConfigRaw`,
which pick YAML over JSON automatically.

## Example `config.yaml`

```yaml
# Unix Domain Socket path for daemon IPC.
socketPath: /tmp/pai.sock

# How often the daemon re-indexes changed files, in seconds.
indexIntervalSecs: 300

# How often the daemon runs the embedding pass, in seconds.
embedIntervalSecs: 600

# Storage backend: "sqlite" (default) or "postgres".
storageBackend: sqlite

# PostgreSQL connection settings, used when storageBackend is "postgres".
postgres:
  connectionString: postgresql://pai:pai@localhost:5432/pai_<username>
  maxConnections: 5
  connectionTimeoutMs: 5000

# Embedding model name, used for semantic/hybrid search.
embeddingModel: Snowflake/snowflake-arctic-embed-m-v1.5

# Daemon log level: debug, info, warn, or error.
logLevel: info

# Search defaults, applied when an MCP tool or CLI call doesn't specify one.
search:
  mode: keyword
  rerank: true
  recencyBoostDays: 90
  defaultLimit: 10
  snippetLength: 200

# Who "me" is — addresses that count as the user's own. Empty by default
# and never guessed: nothing is self-addressed until this is set.
identity:
  selfEmails:
    - you@example.com
  deliverTo: you@example.com
  sendingAccount: you@example.com

# Non-provider worker settings (pane, routing, tree, cache keepalive,
# fallback). Providers/classes/mcp_sets live in workers.yaml, not here.
workers:
  enabled: true
  cacheKeepaliveSecs: 15
  # Run native-Anthropic workers through `caveman claude`. Off (default) pins
  # them to api.anthropic.com even when settings.json routes claude through a
  # proxy; see docs/worker.md, "What a worker is".
  caveman: false
  # Daemon reaper (default true): every 30 s, kill processes with ppid 1, older
  # than 2 min and over 50% CPU in two samples 30 s apart that live under the
  # workers slots/ or worktrees/ dirs (orphans of a timed-out foreground
  # command, e.g. a vitest fork). SIGTERM, SIGKILL after 5 s; each kill is
  # logged and noted on the owning worker's status. false turns it off.
  reaper: true
```

`postgres.connectionString` and anything under a `key`/`token`/`secret`/
`password` field is a secret: `pai config list`/`get` and `config_list`/
`config_get` always print it masked (`****<last4>`), and the file itself is
written mode `0600`.

## CLI

```
pai config path                                # resolved paths for every PAI_HOME file
pai config yaml [--dry-run] [--force]           # convert config.json/voices.json → YAML
pai config list [--all] [--json]                # file-set values as YAML (--all: every default too)
pai config get search.recencyBoostDays          # one value, defaults-merged, masked if secret
pai config get search.recencyBoostDays --source # ... and whether it came from your file or the shipped defaults
pai config get workers.pool --json              # an object or array prints as YAML, --json for JSON
pai config set search.recencyBoostDays 45       # writes config.yaml, comment-preserving
pai config set some.newThing 1 --force          # allow an unknown top-level key / type mismatch
pai config unset search.recencyBoostDays        # revert to the default
pai config migrate [--dry-run] [--logs] [--history]   # move old per-user files into the PAI home
```

`migrate` copies each old file, verifies it byte for byte and renames the old one `<name>.migrated-<date>` (never deletes); it is idempotent. `--logs` and `--history` also move the worker logs and the hook-written history, and refuse while workers run (they cannot see other interactive sessions, so check first). Layout of the PAI home: [pai-home.md](pai-home.md).

`pai config set` value parsing: `true`/`false`, `null`, bare numbers,
`[...]`/`{...}` parsed as JSON, everything else a plain string. `set`
refuses an unknown top-level key, or a value whose type disagrees with the
built-in default in `DEFAULTS`, unless `--force`.

Example session:

```
$ pai config set search.recencyBoostDays 45
Set search.recencyBoostDays = 45

$ pai config get search.recencyBoostDays
45

$ pai config list
search:
  mode: keyword
  rerank: true
  recencyBoostDays: 45
  defaultLimit: 10
  snippetLength: 200
```

## MCP tools

On the `pai` MCP server (`src/daemon-mcp/index.ts`), backed by the same
`src/config/main-config-ops.ts` functions the CLI calls — masking and
validation cannot drift between the two surfaces.

- **`config_list`** — `{ "all": false, "json": false }` → the file-set config
  as YAML (or JSON), secrets masked.
- **`config_get`** — `{ "path": "search.recencyBoostDays" }` → the
  defaults-merged value, masked if the path looks like a secret.
- **`config_set`** — `{ "path": "search.recencyBoostDays", "value": "45" }`
  → **writes config.yaml** (creating it from config.json first if neither
  exists yet), comment-preserving. Add `"force": true` to bypass the
  unknown-key/type checks.
- **`config_unset`** — `{ "path": "search.recencyBoostDays" }` → **writes
  the file**, removing the key so it reverts to the built-in default.
