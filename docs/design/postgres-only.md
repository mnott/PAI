# Postgres-only storage — design

Goal: when `storageBackend: postgres`, no code path opens or writes SQLite. Everything that
today lives only in `federation.db` (`kg_entities`) or `registry.db` (projects, sessions,
aliases, tags, session_tags, links, compaction_log) moves to Postgres, verified, with the
SQLite files kept as renamed backups — never deleted. Measured state (2026-09-22) and the
prior `StorageBackend` abstraction (`src/storage/{interface,sqlite,postgres}.ts`) are taken
as given; this document extends that layer rather than replacing it.

Hard constraint (added 2026-09-22, from the container definition): Postgres runs in
`pai-pgvector` (`docker/docker-compose.yml`, `pgvector/pgvector:pg17`, `127.0.0.1:5432`)
with a **bind mount**, not a named volume — confirmed via `docker inspect`:
`~/.pai/pgdata -> /var/lib/postgresql/data`, rw, type `bind`. Every step in
this design (schema init, migration, verification) goes through the normal `pg` connection
on 5432; nothing writes into the container filesystem or a Docker-managed volume, and no
step uses `docker cp`. The migration command's pre-flight check and rollback step (§4) both
depend on this bind mount being present on the host, not on anything inside the container.

Open question, not resolved by this change: `~/.pai/pgdata` sits outside `PAI_HOME`
(`~/.claude/pai`), i.e. Postgres data isn't backed up/relocated the way the rest of PAI's
state is. Out of scope here — flagging it, not moving it.

## 1. Inventory — every non-test file that opens or touches SQLite

### 1a. Storage-layer definition files (own the schema/opener today)

| File | Role |
|---|---|
| `src/memory/db.ts` | defines `openFederation()` — `new BetterSqlite3(federation.db)`, sync |
| `src/memory/schema.ts` | `federation.db` DDL: `memory_files`, `memory_chunks`, `memory_fts`, **`kg_entities`** |
| `src/registry/db.ts` | defines `openRegistry()` — `new BetterSqlite3(registry.db)`, sync |
| `src/registry/schema.ts` | `registry.db` DDL: `projects`, `sessions`, `tags`, `project_tags`, `session_tags`, `aliases`, `compaction_log`, `links`, `schema_version` |

`grep -rn "new Database(" src` outside these two openers only matches two test files
(`project/here.test.ts`, `project/mcp-tools.test.ts`, both `:memory:` — fine, tests are
out of scope).

### 1b. Direct call sites that acquire a `Database` handle (sync, better-sqlite3)

| File:line | Opens | Tables reached |
|---|---|---|
| `src/cli/program.ts:83` | `openRegistry()` → cached in module-level `getDb()`, passed to **~60** CLI command modules (§1e) | all registry tables |
| `src/daemon/daemon/server.ts:138` | `openRegistry()` → `setRegistryDb()`, shared with daemon handlers | all registry tables |
| `src/daemon/daemon/state.ts` | imports `openRegistry` (daemon state init) | all registry tables |
| `src/workers/project-config.ts:44` | `openRegistry(dbPath)` | `projects`, `sessions`, `session_config` column |
| `src/cli/commands/task.ts:125,302` | `openRegistry()` | `aliases`, `projects` |
| `src/cli/commands/session/commands.ts:594` | `openRegistry()` | `sessions`, `projects` |
| `src/memory/kg-backfill.ts:184,187` | `openFederation()` **and** `openRegistry()` in the same pass | `kg_entities`, `projects` |
| `src/daemon/daemon/dispatcher.ts:174,184` | `openFederation()` | `memory_files`, `memory_chunks`, `kg_entities` (indirectly) |
| `src/daemon/daemon/scheduler.ts:295` | `openFederation()` | passed into `indexAll()` |
| `src/daemon/session-summary-worker.ts:950` | `openFederation()` | passed into `kg-extraction.ts` |
| `src/cli/commands/db.ts:32` | `openFederation()` | `pai db` stats/inspect command |
| `src/cli/commands/zettel/utils.ts:20` | `openFederation()` | zettelkasten commands (legacy path; most zettelkasten modules already take `StorageBackend`, see §1e) |
| `src/cli/commands/memory/{stats,embed,index-cmd,search}.ts` | `openFederation()` (fallback path — the primary path in these files already goes through `createStorageBackend()`) | `memory_files`, `memory_chunks` |
| `src/storage/factory.ts:214` | `openFederation()` — **this is the SQLite branch of the existing abstraction**, expected to remain for `storageBackend: sqlite` | wraps in `SQLiteBackend` |

### 1c. Shell hooks (sync, `sqlite3` CLI subprocess — not better-sqlite3, but still opens SQLite)

| File | Tables |
|---|---|
| `src/hooks/session-stop.sh:118,122,132` | reads/writes `projects`, `sessions` |
| `src/hooks/pre-compact.sh:47,51,60,71,75` | reads/writes `projects`, `sessions`, `compaction_log` |

These run as plain bash subprocesses with no Node runtime — they cannot use a `pg` pool
directly (see §6, risk: hooks under Postgres).

### 1d. `kg_entities` consumers (sync, take a `Database` handle as a parameter)

| File | Functions | Sync |
|---|---|---|
| `src/memory/kg-entity.ts` | `upsertKgEntity`, `findKgEntity`, `listKgEntities`, `updateEntityFeedbackWeight` — all `db.prepare(...)` | sync |
| `src/memory/kg-extraction.ts` | calls `upsertKgEntity` | sync |
| `src/memory/kg-search.ts` | calls `listKgEntities` | sync |
| `src/mcp/tools/feedback.ts` | calls `listKgEntities`, `updateEntityFeedbackWeight` | sync |

Note: `kg_triples` (the edges) is **already Postgres-only** (`src/storage/postgres/backend.ts`
`runMigrations()` creates it directly in Postgres, no SQLite equivalent exists). Only
`kg_entities` is still SQLite-only — it is the smaller of the two gaps in the architecture.

### 1e. `registry.db` table consumers (sync, reached via `getDb()` from `src/cli/program.ts` or an
equivalent daemon/worker singleton)

64 non-test files contain direct `db.prepare(...)` SQL against `projects` / `sessions` /
`aliases` / `tags` / `session_tags` / `links` / `compaction_log`. Grouped by module (every
file in the grep match is listed; none omitted):

- **CLI project commands** (registry: `projects`, `aliases`, `tags`, `project_tags`):
  `src/cli/commands/project/{index,commands,here,helpers,health,merge,unregister,projects-index,session-config}.ts`,
  `src/cli/commands/main-resolver.ts`, `src/cli/commands/pick.ts`, `src/cli/commands/detect.ts`
- **CLI session commands** (registry: `sessions`, `session_tags`, `compaction_log`):
  `src/cli/commands/session/{index,commands,autosave,pause,handover,goto,end,helpers,sessions-index}.ts`,
  `src/cli/commands/session-cleanup/{index,scanner,executor}.ts`, `src/cli/lib/{session-scan,dedup-sessions}.ts`
- **CLI registry commands** (registry: all tables, dedup/scan/migrate tooling):
  `src/cli/commands/registry/{index,scan,reconnect,dedupe,migrate,utils}.ts`, `src/registry/merge.ts`,
  `src/registry/migrate.ts` (`migrateFromJson` writes `projects`/`sessions`)
- **CLI memory/obsidian/backup/config**: `src/cli/commands/{memory/stats,memory/search,memory/index-cmd,
  memory/embed,backup,restore,config,obsidian}.ts`, `src/obsidian/sync/{generate,master,symlinks}.ts`,
  `src/obsidian/status.ts`, `src/obsidian/vault-fixer.ts`
- **MCP tools** (registry reads for tool responses): `src/mcp/tools/{registry,projects,sessions,wakeup,types}.ts`
- **Daemon**: `src/daemon/daemon/{dispatcher,handler,scheduler,server,state,types}.ts`,
  `src/daemon/session-summary-worker.ts` — `handler.ts` is the clearest existing example of the
  target failure mode: it already mixes `registryDb.prepare(...)` (sync SQLite) and
  `pool.query(...)` (async Postgres, via `PostgresBackendWithPool`) in the same file.
- **Session/task/topic routing**: `src/session/{auto-route,promote}.ts`, `src/tasks/resolver.ts`,
  `src/topics/detector.ts` (note: `detector.ts` primarily takes `StorageBackend`; its one direct
  registry touch is a `sessions`-adjacent lookup, confirm during implementation unit 3)
- **Workers**: `src/workers/project-config.ts`

`grep -n "getDb(" src/cli` (17 files) shows every one of the above CLI files receives the
handle from `program.ts`'s singleton rather than opening its own — they are "opens SQLite"
in the sense the boundary test (§3) must catch (they import `Database` from `better-sqlite3`
and call `.prepare()`), even though the physical `openRegistry()` call happens once, upstream.

### Summary

| Data | Only copy today | Direct openers | Downstream consumers |
|---|---|---|---|
| `kg_entities` | `federation.db` (23,343 rows, live writes) | 1 (`kg-backfill.ts`) + factory/dispatcher opens for other reasons | 4 files (§1d) |
| `projects, sessions, aliases, tags, session_tags, links, compaction_log` | `registry.db` (278/6,892/26/5/5/3/664) | ~10 call sites (§1b) + 2 shell hooks (§1c) | 64 files (§1e) |

## 2. Target Postgres schema

Follows the existing pattern exactly: base DDL lives in `docker/init.sql` (applied by
`PostgresBackend.ensureDatabase()` on a fresh database), incremental additions go through
`PostgresBackend.runMigrations()` in `src/storage/postgres/backend.ts` — the same place
`kg_triples` was added. `kg_entities` and the registry tables are added the same way,
**appended to `runMigrations()`** rather than `init.sql`, so existing Postgres databases
(which already have `pai_files`/`pai_chunks`/`kg_triples`/vault tables) pick them up without
a fresh `CREATE DATABASE`.

```sql
-- appended to PostgresBackend.runMigrations(), guarded by information_schema checks
-- exactly like the existing kg_triples migration

CREATE TABLE IF NOT EXISTS kg_entities (
  entity_id       TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  name            TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'unknown',
  description     TEXT,
  first_seen      BIGINT,
  last_seen       BIGINT,
  mention_count   INTEGER NOT NULL DEFAULT 1,
  feedback_weight REAL NOT NULL DEFAULT 0.5,
  UNIQUE (tenant_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_kge_tenant ON kg_entities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kge_name   ON kg_entities(tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_kge_type   ON kg_entities(tenant_id, type);

CREATE TABLE IF NOT EXISTS projects (
  id               SERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  root_path        TEXT NOT NULL UNIQUE,
  encoded_dir      TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL DEFAULT 'local'
                     CHECK (type IN ('local','central','obsidian-linked','external')),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','archived','migrating')),
  parent_id        INTEGER REFERENCES projects(id),
  obsidian_link    TEXT,
  claude_notes_dir TEXT,
  session_config   TEXT,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  archived_at      BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  number            INTEGER NOT NULL,
  date              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  filename          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','completed','compacted')),
  claude_session_id TEXT,
  token_count       INTEGER,
  created_at        BIGINT NOT NULL,
  closed_at         BIGINT,
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS tags (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  tag_id     INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  tag_id     INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (session_id, tag_id)
);

CREATE TABLE IF NOT EXISTS aliases (
  alias      TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS compaction_log (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  session_id    INTEGER REFERENCES sessions(id),
  trigger       TEXT NOT NULL CHECK (trigger IN ('precompact','manual','end-session')),
  files_written TEXT NOT NULL,
  token_count   INTEGER,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id                 SERIAL PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id),
  target_project_id  INTEGER NOT NULL REFERENCES projects(id),
  link_type          TEXT NOT NULL DEFAULT 'related'
                       CHECK (link_type IN ('related','follow-up','reference')),
  created_at         BIGINT NOT NULL,
  UNIQUE (session_id, target_project_id)
);

CREATE INDEX IF NOT EXISTS idx_projects_slug    ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status  ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_type    ON projects(type);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date    ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_claude  ON sessions(claude_session_id);
CREATE INDEX IF NOT EXISTS idx_pc_project       ON project_tags(project_id);
```

Notes on the translation:
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY` (Postgres idiom already used
  by `kg_triples`, `pai_files` etc.).
- SQLite's `INTEGER` epoch-ms timestamp columns → `BIGINT` (Postgres `INTEGER` is 32-bit
  and `created_at`/`updated_at` are `Date.now()` ms since epoch, which overflows it).
  `pai_chunks.updated_at` already uses this convention — consistent with existing tables.
  Do **not** use `TIMESTAMP` here: callers construct these values with `Date.now()`, not
  `NOW()`, and converting the value shape is out of scope for a storage-backend swap.
  `kg_triples.created_at` is the one existing exception (`TIMESTAMP DEFAULT
  CURRENT_TIMESTAMP`) — inconsistent with the rest of the schema but pre-existing; not
  changed here.
- FK constraints are declared inline (Postgres allows forward + circular-safe ordering
  here since `projects.parent_id` self-references after the table exists); SQLite's
  `PRAGMA foreign_keys = ON` behavior is enforced unconditionally in Postgres, no pragma
  needed.
- `schema_version` (SQLite-only bookkeeping table) has no Postgres equivalent — Postgres
  migrations are tracked the same way `kg_triples` is: an `information_schema` existence
  check in `runMigrations()`, not a version counter. Do not port `schema_version`.

## 3. Data-access design

**Extend the existing pattern**, don't invent a new one. `src/storage/interface.ts` /
`sqlite.ts` / `postgres/backend.ts` already do exactly this for the federation/vault data.
Do the same for the registry and for `kg_entities`:

- Add `RegistryBackend` (new file `src/storage/registry-interface.ts`, mirroring
  `interface.ts`) with async methods for every distinct query used across the 64 files in
  §1e: `getProject`, `listProjects`, `createProject`, `updateProject`, `findProjectBySlug`,
  `resolveAlias`, `addAlias`, `removeAlias`, `createSession`, `getSession`, `listSessions`,
  `updateSessionStatus`, `addTag`/`listTags`, `addSessionTag`, `addLink`, `listLinks`,
  `appendCompactionLog`. Enumerating the full method list against every one of the 64 call
  sites is implementation work (unit 3, §5), not a design decision — the shape is the same
  "one interface, one method per operation, both backends implement it" pattern already
  proven by `StorageBackend`.
- Add `kg_entities` methods (`upsertKgEntity`, `findKgEntity`, `listKgEntities`,
  `updateEntityFeedbackWeight`) to the **existing** `StorageBackend` interface — it already
  owns `kg_triples`-adjacent search and the federation DB; `kg_entities` belongs there, not
  in a third interface. `SQLiteBackend` wraps today's `kg-entity.ts` functions; add a
  `kg_entities` section to `src/storage/postgres/backend.ts` (same file that already has
  `kg_triples` migrations).
- `src/storage/factory.ts` already returns the right backend for `storageBackend`; add a
  matching `createRegistryBackend()` next to `createStorageBackend()` — same retry/outage
  logic (§ existing `connectPostgres`), same "never silently fall back to SQLite" rule.

**Async conversion.** The registry API is 100% synchronous today (`better-sqlite3`). The
choice is between (a) making `RegistryBackend` async everywhere, converting all ~64 sync
callers to `await`, or (b) keeping registry sync-only by wrapping a Postgres client behind a
synchronous facade (not possible with `pg`'s async driver without a blocking bridge, which
`better-sqlite3`-style sync Postgres clients do not offer in Node without native blocking
I/O hacks that are worse than the migration itself). Pick (a): **make `RegistryBackend`
async**, matching `StorageBackend`, for one reason — `StorageBackend` already made this
choice for exactly the same problem (SQLite is sync, Postgres is not) and every caller of
`StorageBackend` in this codebase is already `async`/`await`-shaped (MCP tool handlers are
Promise-returning by SDK contract; daemon dispatcher and scheduler are already async; CLI
commander actions in this codebase are already declared `async (opts) => {...}` even where
they currently call sync registry functions inside — converting the inner call to `await`
is a one-line change per call site, not a structural rewrite). The only category that isn't
already async is the two shell hooks (§1c, addressed in §6) — everything else is already
sitting in an async function body waiting for the `await` to be added.
- Sqlite backend behavior is unchanged: `RegistryBackend`'s SQLite implementation wraps the
  existing sync `db.prepare()` calls in `Promise.resolve(...)` (or plain `async` functions
  that call the sync code) — no behavior change for `storageBackend: sqlite`, satisfying
  "existing behaviour stays."
- No dual-write, no sync-from-sqlite at runtime — the factory picks one backend per process
  start, exactly like `createStorageBackend()` does today.

## 4. One-shot migration command: `pai db migrate-to-postgres`

New file `src/cli/commands/db-migrate.ts`, registered under the existing `pai db` command
group (`src/cli/commands/db.ts`). Idempotent (every write is `ON CONFLICT DO UPDATE`,
re-running after a partial failure resumes safely — same pattern as `docker/migrate-sqlite.ts`,
which this command supersedes and should absorb rather than duplicate).

Steps, in order, each one gated on the previous succeeding:

1. **Pre-flight: bind-mount check.** Before touching any data: confirm
   `docker inspect pai-pgvector --format '{{json .Mounts}}'` reports a `"Type":"bind"` mount
   at `/var/lib/postgresql/data` with `Source` under the host `~/.pai/pgdata` path (not a
   named volume, not absent). Refuse to proceed — exit non-zero, write nothing — if the
   container isn't running, the mount type isn't `bind`, or the source path doesn't match
   config. This is a hard gate: a named-volume or missing-mount Postgres means the "kept
   as a backup" guarantee for the *destination* doesn't hold either.
2. **Pre-flight: host-path backup (rollback point).** Run `pg_dump` against the target
   database to a host path (e.g. `~/.pai/backups/pai_<user>-pre-migrate-<date>.dump`,
   custom format `-Fc`) *before* any migration write. This is the rollback path: if
   migration verification fails, `pg_restore --clean` from this dump undoes it. Refuse to
   proceed if `pg_dump` fails or produces a zero-byte file.
3. **Row-count baseline.** `SELECT COUNT(*)` on SQLite `kg_entities` and each registry
   table; record alongside the equivalent Postgres counts (0 or pre-existing, since this
   command is also idempotent against a partially-migrated database).
4. **Migrate `kg_entities`** (federation.db → Postgres): batch `UPSERT` by `entity_id`,
   same batching/transaction pattern as `docker/migrate-sqlite.ts`'s chunk migration.
5. **Migrate registry tables**, in FK order: `projects` → `tags` → `sessions` →
   `project_tags` → `session_tags` → `aliases` → `links` → `compaction_log`. `SERIAL` ids on
   the Postgres side must preserve the SQLite integer ids (`INSERT ... (id, ...) VALUES
   (...)` with explicit id, then `SELECT setval(...)` on each sequence afterward) — foreign
   keys throughout the registry and in session/task-resolution code are stored as bare
   integers, not slugs, so silently reassigning ids would break every existing reference.
6. **Verify.** Re-run the `COUNT(*)` on both sides per table; if source count ≠ destination
   count for anything, **stop, do not rename anything, exit non-zero** with the mismatching
   table names. Add a spot check: for `kg_entities` and `projects`, pull 20 random ids from
   SQLite and confirm every field matches the Postgres row byte-for-byte.
7. **Stale-data reconciliation** (`memory_files`/`vault_files` — see superset check below):
   report counts; do not silently drop rows that look like real content. Only rows that
   match the indexer's *current* ignore patterns (dotfile/cache directories under a
   registered project root) are treated as cruft and excluded from the "must preserve"
   count — everything else migrates.
8. **Rename, only after step 6 passes**: `federation.db` → `federation.db.migrated-<date>`,
   `registry.db` → `registry.db.migrated-<date>`. Never `rm`. This is the point after which
   `storageBackend: postgres` is safe to set in config — but this command does **not**
   flip that config value itself; that stays a manual, explicit step for the operator.

### Superset check (run 2026-09-22, read-only — SQLite via `better-sqlite3 readonly: true`,
Postgres via plain `SELECT`)

This is **not** a clean superset — flagging the actual numbers rather than the assumption in
the measured-state note:

| Comparison | SQLite | Postgres | SQLite paths absent from Postgres |
|---|---|---|---|
| `memory_files` vs `pai_files` (path-only, ignoring `project_id`) | 22,266 distinct paths | 32,722 distinct paths | **19,744** |
| `vault_files` vs Postgres `vault_files` | 8,254 | 84,645 | **3,371** |

Postgres has far more rows overall in both cases (different/additional projects indexed
since), but SQLite still contains real gaps. Diagnosis for `memory_files`: 2,835 of the
19,744 missing paths sit under indexer-scope cruft (`.Trash/`, `.bun/install/cache/`,
`.npm/`, `.cargo/`, `.pyenv/`, other dotfile directories at a project root) — almost
certainly from before the indexer's ignore patterns were tightened; these are candidates for
exclusion, not migration. The remaining ~16,900 were not individually triaged in this
pass — the migration command (step 7) must classify each by running it through the
*current* indexer ignore-pattern check, not assume. Diagnosis for `vault_files`: the 3,371
missing paths were spot-checked and are not obviously cruft (real note paths under project
directories that exist in both systems) — likely genuinely stale (older vault-indexer run,
not yet re-indexed into Postgres), so these should be included in the migration rather than
dropped, pending a fresher `pai obsidian sync` pass which may supersede them naturally.

## 5. Work breakdown (independent units, parallelizable — no overlapping files)

| Unit | Files | Proof |
|---|---|---|
| **1. Postgres DDL** | `src/storage/postgres/backend.ts` (`runMigrations()` additions for `kg_entities` + 7 registry tables) | `src/storage/postgres/init-sql.test.ts`-style test: fresh Postgres database, run migrations twice (idempotency), assert all 8 tables + indexes exist via `information_schema`. Before/after: `\dt` table count. |
| **2. `kg_entities` on `StorageBackend`** | `src/storage/interface.ts` (+4 methods), `src/storage/sqlite.ts` (wrap `kg-entity.ts`), `src/storage/postgres/backend.ts` (+4 methods), `src/memory/kg-entity.ts` callers (`kg-extraction.ts`, `kg-search.ts`, `mcp/tools/feedback.ts`) switched from raw `Database` param to `StorageBackend` param | Vitest: upsert same entity twice, assert `mention_count` increments, on both backends against a temp SQLite file and a temp Postgres database/schema (not the live one). |
| **3. `RegistryBackend` interface + SQLite impl** | new `src/storage/registry-interface.ts`, `src/storage/registry-sqlite.ts` (wraps existing `registry/db.ts` + `registry/merge.ts` logic); convert `src/cli/program.ts`'s `getDb()` to return a `RegistryBackend` | Vitest against a temp SQLite file: create project, add session, resolve alias — assert round-trip. This is the largest unit (defines the full method surface against all 64 call sites) — do this before unit 4. |
| **4. `RegistryBackend` Postgres impl** | `src/storage/registry-postgres.ts`, `src/storage/factory.ts` (`createRegistryBackend()`) | Same test suite as unit 3, run against temp Postgres schema — assert identical results to the SQLite impl (shared test file, backend passed as parameter). |
| **5. Caller conversion (registry)** | the 64 files in §1e — mechanical `db.prepare(...)` → `await registryBackend.method(...)`, one PR-sized slice per subdirectory (`cli/commands/project/*`, `cli/commands/session/*`, `cli/commands/registry/*`, `daemon/*`, `mcp/tools/*`) | Existing command-level tests (`project/here.test.ts`, `project/mcp-tools.test.ts`, `registry/merge.test.ts`, `workers/project-config.test.ts`) pass unmodified against both backends. |
| **6. Migration command** | `src/cli/commands/db-migrate.ts`, absorbs/retires `docker/migrate-sqlite.ts` | Dry run against a copy of the real `federation.db`/`registry.db` into a scratch Postgres database; assert row counts match and re-run is a no-op (idempotency). |
| **7. Boundary enforcement test** | new `src/storage/boundary.test.ts` | Scans `src/**/*.ts` excluding `*.test.ts` and everything under `src/storage/`; fails if any file imports `better-sqlite3` or `pg`, imports `openFederation`/`openRegistry`, or contains the literal strings `federation.db`/`registry.db`. Concretely: `readdirSync` walk + regex on file text, `expect(violations).toEqual([])`. This test only passes once units 1–6 are complete — it is the final gate, not something to add early and skip. |
| **8. Hooks (`session-stop.sh`, `pre-compact.sh`)** | see §6 — needs a decision, not purely mechanical | `pai db registry-touch --session-stop <args>` (or equivalent) exercised manually against both backends; hook script diffed for behavior parity. |

Units 1–2 and 3 can start in parallel (disjoint files). Unit 4 depends on 3. Unit 5 depends
on 3+4. Unit 6 depends on 1–4. Unit 7 depends on everything. Unit 8 can start any time after
unit 4 (needs the Postgres registry methods to exist) but is independent of unit 5's caller
sweep.

## 6. Risks

- **Daemon restart ordering.** The daemon currently opens both `federation.db` and
  `registry.db` at startup (`server.ts`, `dispatcher.ts`). Under Postgres, the daemon's
  `waitForPostgres: true` retry loop already exists for the federation backend
  (`src/storage/factory.ts`) — extend the same loop to gate registry backend creation too,
  so the daemon doesn't start serving with a `RegistryBackend` pointed at a not-yet-ready
  Postgres. Boot ordering (Docker Desktop before launchd-started daemon) is the same
  pre-existing race the current retry logic already handles; no new mechanism needed, just
  applying the existing one to a second backend.
- **Concurrent writers during migration.** `federation.db` is called out as "ONLY copy,
  still being written live" for `kg_entities` — the daemon and any running session are
  actively upserting entities. The migration command must require the daemon stopped (`pai
  daemon stop`) before running, and check for it (refuse to proceed if `pai daemon status`
  reports running), otherwise rows written during the row-count baseline (step 3) are
  invisible to the migration but land in SQLite after — a source of silent data loss the
  verification step (step 6) would not catch, since it re-reads SQLite counts fresh but a
  row written after step 4's read and before step 8's rename would never be copied.
- **Tests that assume SQLite.** `project/here.test.ts` and `project/mcp-tools.test.ts`
  construct `new Database(":memory:")` directly — these become tests of the SQLite
  `RegistryBackend` implementation (unit 3), not of raw `better-sqlite3` usage in the
  caller. `workers/project-config.test.ts` similarly. All three need their setup swapped to
  go through the new interface rather than instantiating `better-sqlite3` inline — small,
  mechanical, but must happen in lockstep with unit 3/5, not after, or they start failing
  the boundary test (unit 7) as soon as it's added.
- **Shell hooks (§1c) have no Postgres client.** `sqlite3` is a CLI binary; there is no
  equivalent zero-dependency `psql`-in-bash story without assuming `psql` is installed
  (it isn't a stated PAI dependency today). Two options, not resolved here: (a) require
  `psql` as a new host dependency for `storageBackend: postgres` deployments, or (b) add a
  tiny `pai` subcommand the hooks shell out to (`pai hooks session-stop-write ...`), paying
  a Node startup cost on every session-stop/pre-compact event. (b) is more consistent with
  "no file outside `src/storage/` touches the database directly" and avoids a new external
  dependency — recommended, but flagged as a decision for whoever picks up unit 8, not
  decided unilaterally here.


## 8. Decisions and finish sequence (owner-approved, 2026-09-22)

- Unit 8 decision: option (b). The two shell hooks shell out to a `pai` subcommand; no file outside `src/storage/` touches a database.
- Finish sequence, in order, nothing skipped:
  1. Stop `com.pai.pai-daemon` and `com.pai.task-scheduler` (launchd) so nothing writes SQLite or Postgres during the copy. Check `com.pai.claudaemon` and the per-session `dist/daemon-mcp` shims for SQLite access first.
  2. Preflight: `pai-pgvector` bind mount `~/.pai/pgdata -> /var/lib/postgresql/data` present; `pg_dump` of the configured database to a host path.
  3. `pai db migrate-to-postgres`: kg_entities, all registry tables, and the SQLite-only memory_files/memory_chunks (19,744 paths) and vault rows (3,371 paths) absent from Postgres. Refuse on any count mismatch.
  4. Verify: per-table counts (SQLite rows == Postgres rows for migrated sets, Postgres superset for memory/vault paths), spot checks, sequences setval'd.
  5. Cleanup: delete `~/.claude/pai/federation.db` (+ -wal/-shm) and `~/.claude/pai/registry.db` only after step 4 passes. Rollback = the step-2 pg_dump plus the CCC backup volume copy.
  6. Restart `com.pai.pai-daemon`, `com.pai.task-scheduler` (and `claudaemon` if it used SQLite); confirm the daemon log shows the Postgres backend and no SQLite file is recreated (`ls ~/.claude/pai/*.db` stays empty after a full scheduler cycle). Open sessions pick up the new MCP shim on their next restart.
