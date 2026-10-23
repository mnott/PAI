# Changelog

All notable changes to PAI Knowledge OS are documented here.

---

## [1.0.22] - 2026-10-23

### Fixed

- **Cockpit lessons card:** the per-state counts wrap as whole chips instead of splitting a count onto its own line in a narrow card.

## [1.0.21] - 2026-10-23

### Added

- **npm publish credential check:** `npm publish` (prepublishOnly) and `pai build doctor` test the npm token first (`pai build npm-auth`); a rejected token stops with the renewal steps and the token page link instead of an E404 during the upload.

### Fixed

- **Lessons draft:** a test covers the `--local-only` refusal when no local model is running (no cloud call).

## [1.0.20] - 2026-10-23

### Fixed

- **Cockpit:** the scan-findings cell in the worker runs table is no longer cut off at the table's right edge; the full text is in its tooltip.

## [1.0.19] - 2026-10-23

### Fixed

- **A hook whose script file does not exist is reported** as `missing-script` in `pai audit tokens hooks` and as a warning in `pai build doctor` (found by the acceptance run of the eleven new features).

## [1.0.18] - 2026-10-23

### Fixed

- **`pai config validate` no longer warns about the `workers.tiers` mirror** in `config.yaml` while it is identical to the effective `tiers` in `workers.yaml`; it warns, naming both values, only when they differ.

## [1.0.17] - 2026-10-23

### Fixed

- **`pai worker merge` runs the always-run guard tests also on a docs-only or test-only merge** (`vitest related` is skipped when no source changed, the guard tests are not).
- **`pai build doctor` and the audit reports show local time and age** ("observed 05:55 (3 min ago)") instead of raw UTC; JSON output keeps ISO.

### Added

- **Docs:** the merge test step and its `workers.merge.*` keys, escalation on loop stop and time limit, the lessons draft pipeline and `pai audit tokens mcp` usage are in the feature map and the concept pages.

## [1.0.16] - 2026-10-23

### Fixed

- **`pai worker merge` related tests:** a test command that leaves a background process holding its output is no longer reported as timed out; the result line counts the files and tests of every chunk, not only the first.
- **`pai worker merge` always-tests:** a docs-only or test-only merge now runs `workers.merge.alwaysTests` instead of skipping the whole check; `vitest related` runs only when source files changed, and nothing runs only when the merge changed nothing. The result line names what ran (`related tests: skipped (no source change); always-tests: 3 files, 12 passed`).

## [1.0.15] - 2026-10-23

### Fixed

- **An escalation whose time budget was spent ran without any limit;** it is now skipped (`WORKER-ESCALATE-SKIPPED`, "budget spent").
- **`pai worker gc --pool` could remove a live pool spare** when the pool state file was read mid-write or lagged a new spare; the state is written atomically, an unreadable state keeps the busy-process protection, and a spare of a live pool host is never removed.
- **The project config fallback could read another repository's `.pai/` files** with a separate git dir or a bare repository; it now takes the main checkout from `git worktree list` and only when it is a normal checkout.

## [1.0.14] - 2026-10-23

### Fixed

- **Project config files from a worktree:** `.pai/worker.md` (worker preamble) and `.pai/checks.yaml` (local worker checks) are gitignored and so absent in a worktree; they are now found in the main checkout when the worktree has none.

## [1.0.13] - 2026-10-23

### Fixed

- **`pai worker gc` no longer treats live pool spares as orphans** (it would have killed ready spares); spares of a dead pool host still count as orphans.
- **Lessons draft recall:** correction-like user messages are selected first and drafted in small batches (`lessons.draft.batchMessages`), so short, strong corrections are no longer drowned among long instructions.

## [1.0.12] - 2026-10-23

### Fixed

- **`pai worker merge` related tests:** file names with `$&`/`$'` or a leading `-` reach vitest verbatim; a timeout kills the whole test process tree; long file lists are run in chunks; signal exits are reported as such; names come from `git diff -z`.
- **Plans:** a child whose related tests fail after its merge counts as merged with a warning, not as a conflict.
- **Escalated runs:** the old branch cannot be merged (and so deleted) while its escalated run still works from it; a run stopped by an absolute `--deadline` is not escalated past it, and a `--max-minutes` re-run gets only the remaining budget.
- **Raw-capture rotation is race-free** (one atomic rename to a stamped backup, the newest five kept).
- **Lessons draft:** transcript text is redacted before it reaches any model; a cloud fallback is announced (`--local-only` refuses it); transcripts are streamed with a chunk and time budget (`lessons.draft.maxChunks`, `lessons.draft.timeoutSec`); quotes must be at least 20 characters; rule wording (always, never, must, …) raises a draft's rank.
- **Project rule files** are only taken from a repository (a `.git` ancestor at or below the home folder) and never from a directory owned by another user.

## [1.0.11] - 2026-10-23

### Added

- **Cockpit:** the worker runs table shows each run's scan findings ("1 block · 2 warn", coloured by the highest severity); the memory section has a lessons card (counts per state and the newest candidates waiting for review).
- **`pai lessons propose --draft`:** the running local model (fallback: the routed default) drafts lesson candidates from a transcript; items are validated against the quoted user text, redacted, de-duplicated, ranked by strength and recurrence and capped at `lessons.draft.max`. `--dry-run` prints without writing.

### Fixed

- **Project rule files are found from a repo subdirectory** (walk up to the nearest `.git`, never above the home folder).
- **Session drill-down** shows slash commands as `/name args` instead of raw markup.
- **Cockpit concurrency:** "+" no longer lowers a stored value above the maximum; the endpoint requires `application/json`.
- **Harness adapters:** a session with an unreadable timestamp no longer breaks the sort.
- **`pai worker merge`** also runs repo-wide guard tests on every merge (`workers.merge.alwaysTests`: the token-literal guard and the docs checks), which `vitest related` never selects.

## [1.0.10] - 2026-10-23

### Added

- **`pai worker merge` runs the related tests** (every test that imports a changed file, `workers.merge.verify`, default `npx vitest related --run {files}`) and prints the result; on a failure the merge is kept, the command exits 3 and names the failing files and the revert command. `--no-verify-tests` skips it once.
- **Escalation on a time limit:** a local run stopped by `--max-minutes`/`--deadline` that left committed or salvaged work escalates to the next tier at once, like a loop stop (`deadline` in `workers.escalate.triggers`).
- **`pai audit tokens mcp`** shows calls and last use per MCP server in the window (`--since HOURS`).

### Fixed

- **Raw captures lost events on busy days:** a second rotation overwrote the earlier backup; up to five rotated backups are kept and every reader includes them.
- **Tool-output captures were named by the UTC date** while the other captures used the local date; both use the local date.
- **The pool host** reloads the provider catalogue with its settings, so a provider added later is warmed without a restart.

## [1.0.9] - 2026-10-23

### Fixed

- **"One after the other" held again:** with a session's `max_parallel` set, a waiting run was admitted on the provider's cap after the first poll since live concurrency (1.0.5); the session limit is kept.
- **The router could be crashed by one local request** with a malformed percent-escape in the cockpit concurrency URL; it answers 400, a throwing handler answers 500 instead of ending the process, and an uncaught exception is logged.
- **Lessons:** an `id:` in a lesson file's frontmatter can no longer write outside the lessons folder; the `memory_lessons` tool returns only approved lessons unless a state is asked for.

## [1.0.8] - 2026-10-23

### Fixed

- **Security guard hardened after a second review:** `sh -c "rm -rf /"` and `bash -c 'rm -rf /'` are blocked (the closing quote ended the match); prefix wrappers and absolute paths (`\rm`, `/bin/rm`, `env`, `command`, `exec`, `nohup`, `sudo env`, `VAR=1 cmd`) and other shell sinks (`| /bin/sh`, `| dash`, `| env sh`) no longer bypass the rules; more `find … -delete`, `rm ./`, `rm ..`, base64 (`-D`, `--decode`, process substitution) and sudoers shapes are caught; `git push -vf` asks for confirmation.
- **The guard has a time bound:** each rule sees at most 64 KB (segments 4 KB), so a 1 MB command is checked in under 60 ms instead of timing the hook out; rule files from a project directory are refused when they contain nested quantifiers or over-long patterns and run under a 50 ms limit that counts a timeout as a hit.
- **Fewer false positives:** commit messages, `grep`/`rg` patterns, `echo` and heredocs that mention a prompt-injection phrase or `/dev/tcp` are no longer blocked (instruction override asks instead of blocking); `chmod 000 file` on a single file is allowed.
- **Redaction:** camelCase keys (`clientSecret`, `accessToken`), `pwd=`/`pass=`/`key=`, signed-URL parameters, Azure `AccountKey=`, `--*-token`/`--*-secret` flags, `Bearer …` on its own and more token prefixes are redacted; file paths, type annotations and code like `const token = getToken()` are left alone.
- **The end-of-worker scan runs in a worker thread** and is stopped at its budget; oversized transcript lines are scanned in parts instead of skipped.
- **A `local:` preference in `workers.yaml` that is not running no longer fails** `--local` (it is the fallback after the tier order, as before); a user's `orchestratorModel` is read; `pai config validate` no longer calls these keys unused.
- **Pool statistics** measure setup net of the queue wait (a pool hit was shown as slower than a fresh start); spares are never seeded for a provider/model pair the provider does not offer.
- **`workers.merge.union`** default lives in the shipped config.

### Added

- **Docs:** a "Safety and audit" section in the feature map and concept pages for security rules, lessons and session handoff.

## [1.0.7] - 2026-10-23

### Fixed

- **Security guard: block rules missed commands inside quotes** (regression in 1.0.6): `bash -c "bash -i >& /dev/tcp/…"`, `sh -c '…'`, `bash -c "chmod -R 000 /"` and `bash -c "curl … | sh"` are blocked again, while a message or `printf` that only mentions such a command stays allowed.
- **Security guard false positives:** `rm -rf node_modules; ls /`, `rm -rf dist && du -sh /`, `curl … > out; cat f | sh` and `find ~ -name '*.tmp' -delete` are no longer blocked (patterns no longer cross `;`, `&&`, `|`).
- **Project rule files can no longer switch off a built-in rule** (`.pai/rules` may add rules or raise a severity; overriding stays possible from `<PAI home>/rules`); rule regex flags `g`/`y` are stripped.
- **Redaction:** JSON secrets (`{"password": "…"}`) are redacted; `curl -u user:pass`, `mysql -p…`, Stripe-, npm- and Hugging Face-style tokens, `_authToken=` and cookie values too; `token_count: 5`-style keys and prose are left alone; a long base64 line no longer takes seconds (180 KB: 28 s → 1 ms).
- **Audit scan:** a crafted file name can no longer abort the scan; rules are compiled once, huge lines are skipped, the end-of-worker scan has a 5 s budget.
- **`pai worker merge`:** an auto-resolved merge that fails later is aborted cleanly; union merges only for the files in `workers.merge.union`; binary conflicts are never treated as additions.
- **Git notes:** the post-commit hook runs in the background with a 500 ms budget; an existing chained hook is never overwritten.
- **Queue:** tickets are written atomically and an unreadable ticket never drops a run from the queue.
- **Lessons:** secrets are redacted before a lesson is stored; corrections are only proposed from messages that start with one.
- **Harness adapter:** reads only the head and tail of a transcript to list sessions.

## [1.0.6] - 2026-10-23

### Added

- **Value-level secret redaction** (`src/utils/redact.ts`), shared by every writer: a secret keeps its label and loses only its value (`token=[REDACTED]`, `Authorization: Bearer [REDACTED]`, `https://user:[REDACTED]@host`), with provider token prefixes, JWTs, PEM blocks (also truncated) and `--password X` flags. Raw captures, the loop guard, session notes and the session-summary prompt use it.
- **Security rules as files:** the PreToolUse validator's patterns are `*.rule.yaml` files with embedded match / no-match fixtures (built-ins plus `<PAI home>/rules` and `.pai/rules`; same id overrides, `severity: off` disables). New built-ins: pipe-to-shell downloads, base64-to-shell, sudoers NOPASSWD, crontab/launchd persistence, world-writable chmod, credential-file reads. `pai rules list`, `pai rules lint`.
- **`pai audit scan [--session ID | --worker ID | PATH]`:** runs the same rule files over a finished transcript, including two-step rules within a time window (credential read then network call, download then execute, injected instructions then a tool call); every finished worker is scanned and `pai worker ps` shows non-zero findings.
- **Lessons:** a short, review-gated memory layer (candidate → approved / rejected / superseded) stored as Markdown under `<PAI home>/lessons` and indexed by memory search; `pai lessons` (add, propose from a transcript, approve, reject, supersede, promote to a project skill) and the MCP tool `memory_lessons`.
- **`pai handoff export`:** a bounded (48 KiB), redacted brief of a session for another session, provider or worker, written 0600; a `[pai-handoff from=<id>]` marker links the sessions.
- **`pai git setup`:** a post-commit hook writes a git note (`refs/notes/pai`) naming the session and worker that edited the commit's files; `pai git notes`.
- **Hook health:** `pai audit tokens hooks` and `pai build doctor` show whether each hook event was actually observed in the raw captures, not only configured.
- **Harness adapters:** `pai harness list|sessions` reads sessions from Claude Code and Codex CLI through one adapter interface (`harness.adapters` in config).
- **Cockpit:** the title links to the project homepage.
- **Worker panes** that wait for a provider slot show their queue position instead of staying empty.
- **`pai worker merge`** resolves conflicts that are only in generated files (regenerates them) or only additions on both sides (union), configured by `workers.merge`.

### Fixed

- **Escalation of a local run kept the local provider** with the next tier's model; it now takes the target tier's own route, and the escalated run is no longer reported lost.
- **A waiting worker crashed** when another run's queue ticket vanished.
- **Small panes are no longer reported as a violation.**
- **`scripts/build-docs.mjs` refuses a stale `dist/`** instead of regenerating the command pages from an old build.

## [1.0.5] - 2026-10-22

### Fixed

- **Settings saved in `workers.yaml` that the runtime never reads.** Every `workers.*` setting (pool, pane, routing, tree, …) is read from `config.yaml`; a copy in `workers.yaml` was silently ignored, and the cockpit's config editor saved there. `pai config validate` (new) and the editor's validate now name each shadowed or unused key and where its effective value lives; the editor refuses to save such a key and gives the `pai config set` command; the daemon logs one warning per shadowed key at start.
- **DNS rebinding on the loopback listener:** the `Host`/`Origin` check now also guards the local cockpit, not only a tailnet bind.

### Added

- **Concurrency takes effect live and can be changed in the cockpit.** A waiting run re-reads its provider's cap on every poll, so a raised cap admits it at once; a lowered cap never stops running workers. The pool host picks up `workers.pool` changes within 5 s. Model cards show `parallel N` (and the local server's slots) with − / + buttons, bounded by `router.cockpit.layout.concurrencyMin/Max`.

## [1.0.4] - 2026-10-22

### Fixed

- **Workers that waited in a provider queue for more than two minutes were killed at start (rc 137).** The pane audit measured the pane wrapper's start against the run's start time, which moves to the end of the queue wait, so the live wrapper looked like a reused process and its child was killed. The wrapper is now checked against the time its pane opened, and every kill PAI makes names its cause in the worker's report.
- **Router and cockpit refuse a foreign `Host` or a mismatched `Origin` (DNS rebinding)** on cockpit paths and on state-changing requests when bound to the tailnet; extra accepted host names go in `router.allowedHosts`.

### Added

- **Cockpit: per-session drill-down.** Clicking a session row opens its timeline, changed files, skills, MCP calls (with failures) and hook denials, from `/api/session/<id>/detail`.
- **Provenance on captured events:** raw captures carry `source`, `fidelity` and a deterministic `eventId`; observations get `source` and `fidelity` columns (migrated in place).

## [1.0.3] - 2026-10-22

### Fixed

- **`pai daemon install` registered the PAI MCP server twice** when the same repository is reached through two paths (a symlink): entries are now compared by their real file, a matching entry is updated in place, and a `-legacy` entry is kept only for a genuinely different server.

### Added

- **Docs:** the architecture diagram also as PNG (`docs/images/architecture.png`).

## [1.0.2] - 2026-10-22

### Added

- **`pai setup` installs AIBroker**, PAI's messaging layer (session messages, worker reports, tab names, WhatsApp, Telegram, PAILot), without asking; `--no-aibroker` skips it.
- **Setup step for the router and cockpit:** enable it, choose the port (checked for conflicts) and how far it is reachable (loopback, Tailscale or an address).
- **Every setup question has a flag**, and `pai setup --questions [--json]` lists them with defaults, so the setup skill asks in chat and runs `pai setup --yes` with the answers.
- **`pai backup --dry-run`** and **`pai restore --dry-run`** print what they would do; `pai restore --into <db>` and `--no-safety-dump`.
- **Docs:** a new README opening (local AI, routing, tiers, cockpit, memory), `docs/features.md` with everything PAI does, an architecture diagram (`docs/images/architecture.drawio` / `.svg`), and "Setup questions and flags" in the install guide; the setup skill uses one install route (npm package, marketplace plugin, `pai setup`).

### Fixed

- **Backup dumped the wrong database:** `pai backup` dumped the empty `pai` database instead of the one PAI uses; backup and restore now resolve the database the same way the running storage does.
- **Backup of a large database failed** (`Cannot create a string longer than …`): the dump is checked as a stream with bounded memory, and a backup with a failed part reports `Backup INCOMPLETE` and exits 1 instead of "Backup complete".
- **Restore of a large dump** streams the file into `psql`; the safety dump of the current database is written to a file and verified, and the restore refuses when it fails.

- **Setup router step:** a busy router port no longer aborts setup after the other steps ran; it is listed in the summary with the retry command and every other answer is still written. The router's own port is recognised by the running router (pid file), not by `router.enabled` in the config. `--yes` keeps a saved router bind (tailscale or an explicit address); only `--router-bind` changes it. A non-loopback bind is probed on its own address. Bad `--router-port` / `--router-bind` values are rejected before anything runs, also with `--dry-run`.
- **Setup AIBroker step:** commands time out after five minutes, `aibroker setup` gets the terminal when interactive, `npm install -g` runs only when `aibroker` is missing (a failing `doctor` just re-runs `setup`), and the package is pinned to `aibroker@^0.62.4`.
- **Setup embedding step:** `--embedding` on a machine that already has a model, and `--embedding ollama` without Ollama, now say so instead of doing nothing silently.
- **`pai setup --questions`:** follows the wizard order and carries `note` fields where the effective default differs (storage under `--yes`, router default).
- **Backup:** the Postgres dump is verified against row counts read in the same snapshot (`pg_dump --snapshot`), so a running daemon can no longer fail a correct backup; empty tables (a fresh install) verify; a failed backup removes its dump instead of leaving it for `pai restore`.
- **Backup and restore** use the server named by `postgres.connectionString`; the `pai-pgvector` container is only used when that is the local server. An external server is dumped and restored with the host's `pg_dump`/`psql`.
- **Restore:** database names are quoted and validated (no SQL injection or case folding through `--into` or config); `pai restore` warns when the backup's `config.json` names another database than the one restored into; the refusal for backups without a recorded database names `--into pai`.

### Notes

- Setup enables the router when `router.enabled` is absent (the daemon's own default for the key is off); `--no-router` turns it off.

---

## [1.0.1] - 2026-10-22

A review release: every area of the code was reviewed after 1.0.0, and the findings are fixed here — notably a command injection through macOS notifications, guards that could be bypassed, and several paths that could lose data.

### Changed

- **Package:** the repository's build scripts are no longer shipped in the npm package; they only work in a checkout. The README and the cockpit page show current cockpit screenshots.

### Security

- **macOS notifications:** notification text is passed to `osascript` as arguments instead of being written into the AppleScript, so a message containing quotes can no longer run commands. Present since 0.60.0.
- **Ideas into notes:** `idea_materialize` stays inside the vault and refuses to overwrite an existing note.
- **Security validator:** git and delete patterns are matched against the command itself, not text in quotes, so a commit message mentioning a forced push passes while a quoted root or home deletion is blocked; a push with a `+` refspec counts as forced; unreadable hook input is refused instead of allowed; the security log masks secrets and is owner-only. `ztk-auto` no longer approves every command when ztk is missing; the stop hook checks the session id; the session hooks work without GNU `timeout`.
- **Native launches** (`pai`, `pai launch`, resume) no longer pass `ANTHROPIC_API_KEY` to Claude Code, so a key in the shell does not switch a session to API billing.
- **Worker cleanup:** `pai worker gc` only archives real worker worktrees; a leftover folder inside another repository is reported and that repository is never touched.
- **Own-address check:** a recipient entry holding several addresses is checked address by address, so an outside address after one's own is no longer let through.
- **Observability captures:** raw tool output and hook events are written with secrets masked, into owner-only files capped at 10 MB; session start no longer sends the project name to ntfy.
- **Audit ladder** no longer passes `ANTHROPIC_API_KEY` to the `claude` processes it starts; the forge sink escapes values in its curl configuration.

### Fixed

- **Notification settings:** `pai notifications set` refuses to write when the main config cannot be read, instead of replacing it with only the notifications section; ntfy titles with emoji or non-Latin text are delivered.
- **TODO.md:** syncing the todo list keeps every other section byte for byte — a `## Continue` checkpoint at the top of the file is no longer deleted — and writes atomically.
- **Session notes:** text containing `$&` or similar no longer corrupts a note; renaming never overwrites another note; session summaries list only their own session and show the time as HH:MM:SS; session start no longer waits forever on a hung `pai` call, and a new TODO.md uses the same English structure everywhere.
- **Restore:** `pai restore` first keeps a safety copy of the current config and database, checks the Postgres dump and takes a dump of the live database before restoring into a new database that replaces the live one only after a successful load; `pai session rename` keeps notes inside the Notes folder and never overwrites one; setup keeps every backup under a timestamped name.
- **Hang probe:** a probe that fires before a stuck test has started spinning probes again while the run stays silent, instead of reporting it idle and never stopping it.
- **Hook sync:** a build that links PAI's hooks into `~/.claude` moves a user's own file of the same name to a timestamped backup instead of deleting it.
- **Delegation queue:** a damaged queue file is reported and left untouched instead of being replaced by an empty queue, and queue changes from several processes are serialized so none is lost. Plan and queue runs take their run lock exclusively; worker marker and status files are written atomically; a log-folder migration across disks never leaves a half-copied folder that looks complete.
- **Vault index:** notes deleted or renamed in the vault are removed from the index, unless a scan would remove more than a fifth of the indexed files (or over 500), which points at a partial scan and is skipped with a warning; vault links are grouped in one pass; memory files from Claude's project folder no longer collide with a project's own `memory/` files.
- **Chunking:** a long paragraph, list, log or CJK text without sentence ends is split to the chunk size instead of becoming one huge chunk; line numbers stay correct after `<private>` blocks, and an unclosed `<private>` keeps the rest of the file private. Existing notes are re-chunked as they change.
- **Memory search on Postgres:** user text can no longer form query operators (a query such as `vector<int>` works); keyword hits carry their ids and dates, and a dead connection is not returned to the pool. `memory_get` treats `from` below 1 as 1; the daemon socket is owner-only and caps a request line; knowledge-graph backfill retries a failing note at most once a day and saves its state atomically.
- **Knowledge-graph extraction:** a `claude` child that exits early no longer crashes the daemon with a write error; one that ignores the timeout is killed, and its output is capped.
- **Task poller:** one failing task no longer aborts the whole check or loses the state of tasks already handled; only an explicit "Authorised" status counts as an active Todoist webhook, so "Not authorized" no longer suppresses completion detection.
- **Registry migration:** the old JSON registry is read with one parser, so list-format files are imported and no bogus `projects` or `version` project is created; a folder name without ASCII letters still gets a slug.
- **Skills audit** follows symlinked commands and plugins; **zettel conversations** cap their link depth and breadth; **communities** are deterministic and numbered by size.
- **Vault notes:** the vault fixer and the project marker (`Notes/PAI.md`) write notes atomically; query notes write their frontmatter as valid YAML whatever the query contains; valid relative symlinks are no longer removed as broken.

- **Cockpit sessions:** a session with a very large request history no longer breaks the cockpit's data page; an unreadable session or project folder is skipped, and the job-name cache drops expired entries.
- **Large logs and tables:** minimum and maximum over long lists no longer overflow the call stack (memory search, graph trace, tunnels, worker usage, scheduler, build queue).
- **Local servers:** two starts of one model at the same time can no longer both pass the instance limit or take the same port; a server that is not ready in time is stopped instead of left running; `--cost-tier` must be a whole number; `pai worker bench --max-parallel` and `--max-load` must be positive numbers.
- **Cockpit data:** a model or provider named `__proto__` in the usage log can no longer alter the router's objects; the cached usage log is extended in place, so a cockpit poll no longer recomputes the whole log, and a log replaced in place is noticed. (The 1.0.0 note that usage history keeps only the longest range window described an unused code path, now removed; the cockpit keeps the whole log.)
- **Router memory:** the router holds only the usage rows its views read (about the last 9 days) and keeps whole-log figures as running totals, so its memory no longer grows with the usage log.
- **Backups:** `pai backup` snapshots the databases through SQLite, so changes not yet merged from the write-ahead log are included; `pai restore` removes stale `-wal`/`-shm` files and refuses while the daemon holds the database open.
- **Legacy database migration** merges the write-ahead log with the built-in driver before copying, so committed rows are no longer lost when the `sqlite3` command is not installed.
- **Memory tools:** `memory_get` and `memory_outline` resolve symlinks before checking that a file is inside the project, and accept file names that merely contain `..`.
- **Task bus:** a failing `aibroker` child no longer crashes the poller with an uncaught write error; a tracker project name starting with `-` is refused; the scheduler plist escapes its values and uses the running node.
- **Request bodies:** multi-byte characters split across network packets are no longer corrupted when saving a layout or the registry; a layout threshold of 0 is honoured.
- **Stopping a local server:** `pai worker local stop` reads the router's requests in flight and refuses to stop a busy server unless `--yes` is given; when the router's state cannot be read it refuses too, saying so.
- **Provider keys:** `pai worker providers add --key` warns that the key shows up in the process list and shell history, and points to `--key-file`.
- **Session list:** the row limit is passed to SQLite as a parameter instead of being written into the query.

## [1.0.0] - 2026-10-22

The first full release: the cockpit as a responsive card grid, delegation tiers with automatic escalation, a worker pool, local model servers with several instances, and a release-wide review of security, data safety and process lifecycle.

### Added

- **Cockpit as a responsive card grid:** the cockpit is rewritten as a grid of cards in sections. Sections and cards drag to reorder; a corner handle sets a card's width from a quarter to the full row and its height; a card minimizes to a per-section dock, and lock mode hides the minimized ones. Layouts are kept per device, can be saved as the default for all devices, and exported for installers. Nothing positional is stored, so a layout survives a different window size.
- **Cockpit usage content:** tokens, cache hits, prompt and output speed per model, sessions, worker runs and local servers per instance, each with its own stop and a stop-all when several run; low-request models show as small dimmed rings; newer-build and newer-default notices sit in a bar below the header.
- **Cockpit model lifecycle:** the Models section shows each model's lifecycle (loading, running, stopped) and why a tile is empty or a server is down; a busy local server is no longer reported as down.
- **Registry editor in the cockpit:** the model registry opens in an editor with syntax highlighting and folding, and every backup can be diffed against the current file, named or deleted.
- **Models:** `pai models add` registers a model, whose lifecycle (start, stop, runtime) is owned by its registry entry.
- **Local servers:** several instances of one local model can run side by side; `pai worker local start|stop|status|off` manage them, the router spreads requests over the running instances, a start checks free memory first, and registered (remote) endpoints are health-probed and selectable in routing. One rule picks the local model: the first running one in the routing tier order.
- **Router:** the router swaps to a new build without a gap by handing its listening socket to the successor; it logs event-loop stalls with the request in flight, reads prompt reuse from a vllm-mlx server log, and shows speed per model as bars.
- **Launch preflight:** an interactive native launch checks the router route first, and a dead hop is named in the error; `--dry-run` prints the verdict.
- **Daemon commands:** `pai daemon start` and `stop`, with daemon and router service controls in `pai --help`.
- **Worker cleanup:** `pai worker gc` reclaims worktrees whose work already landed on main, archives merged foreign worktrees (`--foreign`), removes leftover pool trees (`--pool`) and ends orphan processes (`--kill-orphans`); discard and gc archive a branch before deleting it.
- **Private worker scratch:** each worker gets its own scratch directory under the system temp dir, outside any repository, and fixed `/tmp` scratch paths are refused.
- **Home-relative paths:** `workers.yaml` is written with `~/` paths, and `pai worker config normalize-paths` converts an existing file.
- **Cockpit Memory section:** the memory status page moved from the separate `127.0.0.1:8770` server (config key `dashboard`, now removed) into the cockpit's Memory section, with `embed backlog` / `stop` / `index now` actions that show progress, rate and ETA and refuse a second run.
- **Cockpit layout:** the cockpit is arranged in sections by purpose, and sections and tiles can be rearranged by drag and drop; tiles drop where the pointer is. `router.cockpit.sections` limits the page to the listed sections. Cards fold, and folds and open lists survive a refresh and a redraw. A refresh no longer moves the page, and the page fits its viewport at any zoom and font size.
- **Cockpit models:** the Models section shows one card per consumer, titled by purpose (including the PAI embedding card and on-demand models), with live tiles, a metric tile with sparkline, a single local-model switch, and a start/stop action configured per runtime. Models carry editable aliases (pencil next to the headline, working on touch with save, cancel and reset). Numbers use binary GB and match the engine's own monitor; disabled providers and unloaded tiers no longer appear as down.
- **Cockpit on a phone:** session names, the sessions and pause tables, and stacked tables fit the screen; headers are compact and card names stay readable. Tables drop columns that are empty in every row, and chart text keeps its size at any chart width.
- **Cockpit readability:** every model keeps one distinct colour across all charts, axes and legends are readable, rings are drawn by model, and tables, totals, workers, pool and system read cleanly. Job chips, card purpose lines, a scheduler line and server memory in GB were added; a flagged report is no longer shown as a failed run.
- **Delegation tiers and routing:** routing follows three delegation tiers — t0 session, t1 orchestrator, t2 worker — instead of nine class rows; every class routes by its tier list, and the chain set in the cockpit is the order routing uses. The default delegation table ships with PAI. `pai worker route` shows and sets the routing, the cockpit has a routing section with per-class model chips and model ranks per role, and a session can override the routing for itself. Local tiers exist for Strata and scripts, and the local switch stops every local engine.
- **Escalation one tier up:** a worker that cannot finish is retried one tier higher, automatically, from the salvaged branch — on a full context, a missing tool or a repeated failure. A loop stop with saved work escalates at once; a local run that committed is reviewed rather than redone on the cloud, and a loop after committing counts as finished work.
- **Worker pool and reload:** pool spares are pre-started, task-less workers that take one task each; the pool seeds the local provider and refreshes stale spares, and pane titles show the worker's purpose. `pai reload` restarts the daemon, and the pool host reloads itself after a build.
- **Worker panes are owned by the process:** `worker run`, `pane run` and `plan run` start their command inside the pane that owns it, so closing the pane ends the process. A process started inside a pane, or a worker's child worker, gets its own pane. The auditor is now a bug detector only: it writes to a ledger and kills orphan sides, and never reopens a pane.
- **Providers test:** `pai worker providers test` checks what workers would really use, including the native Claude provider, which is probed by spawning like a worker and reading the reply.
- **Install:** the repo is its own plugin marketplace, so installing takes two commands, and the setup skill was rewritten to install PAI on its own with sequential steps and correct counts.
- **Documentation:** concept pages for tiers, routing policy, escalation, session profiles, workers, providers, panes, pool, router, local models, loop guard and notifications; install and first-workers pages; a cockpit page walking through each section with screenshots. The README and docs index lead with the install skill and orchestration, with one glossary and the PAI home defined once. Stale worker and config docs were rewritten, and a test now requires documented keys and commands to exist.
- **Loop guard hands back output:** when the guard denies a repeated read, the denial carries that read's last output; a denied repeated test or build run carries the end of its last output (where failures are). Both are trimmed (`workers.loopGuard.echoLines`, `echoRunnerLines`, `echoChars`) and lines that look like secrets are masked.
- **Session names in the cockpit:** sessions show their AIBroker name, and Claude Code background jobs their job name, ahead of the project slug; an escalated run shows "escalated → <run>" with its commits instead of "failed".
- **Shared runtime stop:** stopping a runtime that other consumers use names them and needs a second click (`router.cockpit.layout.confirmMs`).

### Security

- **Loopback HTTP servers** refuse cross-origin and DNS-rebinding requests.
- **Worker guard:** a worktree worker's git write aimed at a directory outside its worktree is blocked; worker Chrome never touches the keychain and leftover browsers are reaped; the orphan sweep acts only on a verified process identity.
- **Claude login token** is sent only to Anthropic's own hosts; with a custom `router.claudeUpstream` the cockpit says usage is unavailable instead of sending the token there.
- **Provider keys:** a worker's provider token is never put on a command line, where any local user could read it with `ps`; it travels only in owner-only (0600) settings files, which are removed when the run or pool slot ends, and `pai worker gc` sweeps old ones.
- **Cockpit requests:** a config path through `__proto__`, `constructor` or `prototype` is refused (also in `pai config set`); a malformed POST body is answered with 400 instead of being left unanswered; a queue id must be a plain worker id.
- **Git guard:** every segment of a chained command is checked, and a git write retargeted with `-C`, `--git-dir`, `--work-tree` or `GIT_DIR` is caught.

### Changed

- **Paths:** logs, caches, sockets, builds, hooks and config files resolve through one PAI-home and runtime-path resolver instead of fixed locations; endpoints, ports and URLs for the router, pool, Ollama and Postgres come from config.
- **Workers:** a pooled task ends the processes it started, finished and failed panes close on their own, a worker's status line shows only its own session's workers, and a worker with no pane does not start.
- **Memory:** the nightly embed cycle repeats passes until the backlog clears and records each pass.
- **Package size:** the build prunes stale dist chunks and keeps only those reachable from the current entries.
- **Config values out of code:** defaults for delegation, router, cockpit layout and colour thresholds, panes, notices and runtimes live in shipped defaults files under the user config instead of in code. Runtime start/stop commands are no longer written into the user config on first use. `pai config get --source` shows where a value comes from.
- **Cockpit page source** is split into modules by area; the page it serves is byte-identical.
- **PAILot only for replies:** automatic notices never go to PAILot; a run end produces at most one notice, and the messenger is rate-limited.
- **Workers:** a worker never runs in place while editing — an existing branch is reused or renamed. Run reports reach a background session's tab, and panes for a background session are found through the Claude daemon's control socket.

### Removed

- **Caveman mode** is gone; the router sends `claude-*` models straight to the Anthropic API with an upstream and port taken from config.
- **Separate memory dashboard server** (config key `dashboard`); see the cockpit Memory section.

### Fixed

- **Data safety:** writes of the global config, `CLAUDE.md` and the scan config are atomic and keep a timestamped backup, refuse to overwrite a file that does not parse, and a `CLAUDE.md` refresh never overwrites user edits. `pai audit hooks` lists hooks and runs them only with `--run`.
- **Prefill and output speed:** prompt speed counts cached tokens, output speed comes from real decode time and ignores rows without generation time, and servers that report no speed get an end-to-end figure.
- **Power readings:** implausible power readings are dropped when probed and when history is read.
- **Router and pool:** a pool host reload never leaves the pool without a host and a rebuilt host survives losing a port race; the router follows a new build and no longer throws on the normal request path; a restart counts readiness from before the spawn; vllm log totals restart when the log is replaced; a local model a tier launched is routed.
- **Local servers:** stop really stops a script tier, one name per server, and a provider counts as up only when its endpoint serves its model.
- **Merge gate:** workers merge only after the gate scans, a gate-reverted merge can be merged again, and `cd`/`export` command chains are gated whole.
- **Cockpit charts and layout:** the token chart scales to its bars, a wrapped card takes the full row when its share no longer fits, range buttons are centred, and the header version yields only when space is short.
- **Reload and daemon:** shipped defaults resolve from the daemon bundle, not the working directory; `pai reload` starts a stopped daemon or reports the failure. A pool host self-update always comes back and reload waits for it.
- **Loop guard:** the guard fingerprints content, so touching a file no longer gets a repeated command past it.
- **Killing workers:** spawn and kill resolve the owning session with one function, so a session may kill its own worker also when it runs as a Claude Code background job.
- **Tests** no longer inherit the Claude Code session identity of the shell they run from.
- **Context meter:** context fill is the largest turn, not the run's token total.
- **Workers:** a missing or unseen pane never blocks a worker start; pooled runs end and fall through like fresh ones; a pooled worker is alive only while its slot process is; read files are not reported as changes; AG2 shape slips are repaired before validating; the follow view prints plain text and titles only to a terminal.
- **Panes:** launcher panes show the live status and input lines; one rule decides pane or not, and resume no longer takes `--no-pane`; ended pane runs are not violations.
- **State files:** the memory run marker, embed passes, last-good usage and the router poll gate are written atomically; two simultaneous memory runs cannot both start, and stopping a run never signals a process that reused its pid.
- **Build queue:** a stale queue lock is broken by one waiter only, so two builds cannot start together.
- **Merge:** a worker's diff is applied as bytes, so non-ASCII content is no longer corrupted.
- **Embedding model download** goes to a partial file and is renamed only after its checksum matches; a corrupt download is deleted and fetched again.
- **Usage history** notices a log rewritten in place and keeps only the longest range window in memory.
- **Session profile and plans:** an invalid routing row leaves the stored profile unchanged, and a plan with an invalid unit id is refused before anything is written.
- **Pool panel:** the "spare claims disabled" notice shows when spares are off.
- **Worker teardown:** a worker that is killed, or whose model process fails to start, ends the processes it started, closes its files and timers, records the failure and salvages its worktree; a start refused for an oversized preamble or an unknown `--mcp` name no longer leaves a worktree behind.
- **Models and runtimes:** `pai models add --try` stops the server it launched even when it is still loading; stopping all local servers continues past one that already exited; a runtime's ready probe and stop command time out instead of hanging a cockpit job.
- **Cockpit actions:** a double click starts a runtime or memory run once; model labels are stored as text, so a label like `7` or `[wip]` shows as typed; saving the registry keeps the file's permissions and refuses a new port another process listens on.

## [0.72.1] - 2026-10-20

### Added

- **Router:** idle local conversations are parked to disk during long builds, freeing memory for the build and restoring them afterwards.

### Fixed

- **Tests:** the budget cache test is deterministic.

## [0.72.0] - 2026-10-20

### Added

- **Fair local scheduling:** the router schedules requests fairly across sessions for local engines, and worker deadlines count active time rather than time spent queued.
- **Cloud routing:** infra, install and external tasks are routed to the cloud, and local workers get their own contract.

### Fixed

- **Workers:** router queue wait counts as waiting, with one admission path; the cloud-routing keywords are narrower, so fewer tasks are sent to the cloud by accident.

## [0.71.5] - 2026-10-20

### Fixed

- **Nudges:** GPU-idle nudges reach the owning session.

## [0.71.4] - 2026-10-20

### Added

- **Builds:** stalled build jobs are flagged and their owner is told.

## [0.71.3] - 2026-10-20

### Added

- **Workers:** a stopped worker carries who stopped it and why.

### Fixed

- **Loop guard:** repeated instant door failures and piecewise read loops are caught.

## [0.71.2] - 2026-10-20

### Added

- **Builds:** build keys serialise one target, and `PAI_BUILD_JOBS` caps compiler parallelism. Sessions are nudged when the local model idles while their workers build.

### Fixed

- **Builds:** Xcode compilers a stopped build left behind are reaped; derived build keys use the repository, not the worktree; build doors match by repo-relative path, absolute paths included.
- **Daemon:** registry scans are incremental and coalesced, and scheduler tasks read only what changed.
- **Workers:** the process table is read without ENOBUFS; the local-idle line shows only served local models.

## [0.71.1] - 2026-10-20

### Fixed

- **Workers:** every worker starts with an identical prompt prefix, so local engines reuse their cache across workers.

## [0.71.0] - 2026-10-20

### Added

- **Panes:** background commands run in a visible pane, enforced by the guard. Every process gets its own pane in the starting session's tab, never a window, and the host tab is recorded for each pane. A pane auditor flags processes without a pane.
- **Supervision:** a banner at session start and after compaction states the supervision rules.
- **Plans:** the orchestrator can mark independent parts as overlapping, and model-idle time is accounted.
- **Workers:** a hang probe tells the model where a test run is stuck; a provider's parallel cap can be read and set from conversation.

### Fixed

- **Panes:** the largest pane is split along its long side; Claude session ids map to iTerm panes from the statusline; the auditor waits 30 s after start and needs two failed checks.
- **Models:** status comes from what is loaded, consumers are matched by model id, and the footprint replaces RSS; the cockpit models tile lists only loaded models.
- **Workers:** test runs keep their command intact; the per-run note token goes into the task for loopback providers, keeping the system prompt a shared prefix.

## [0.70.0] - 2026-10-19

### Added

- **Home:** PAI lives in `~/.pai`, independent of Claude Code, with a `migrate` command and correct stop hints.
- **Models:** one inventory of every local model runtime, its models and users, with process-tree memory for local servers and size on disk per model; disabled providers are not counted as users.
- **Builds:** one machine-wide build queue enforced by the guard, separate test slots, and simulators shut down after a test job.
- **Workers:** the daemon knows the local model, so sessions never scan ports or start model servers; concurrency comes from the provider cap or the session's `max_parallel`; workers are grouped by session, then model, with the local queue on its own.
- **Plans and cockpit:** plan runner phases are visible in `ps`, the cockpit and a plan pane, and gate timings are recorded. Cockpit tiles collapse and remember it, and a models tile shows what is in use.

### Changed

- **Obsidian:** sync runs in the daemon on change and writes only changed notes, never from workers; the switch only stops writing, vault indexing stays on.
- **Memory:** embed passes have a time budget, run niced and yield to local work.

### Fixed

- **Workers:** a session may only kill its own workers; worktrees no longer pile up (hourly gc, immediate cleanup of empty results, size cap); queued workers get a pane at once; a down or disabled local provider is refused at once with a pointer to `--local`; no "no local model" report without a fresh probe.
- **Plans:** one pane per plan run, never a new window; the plan pane exemption covers only the plan's own worker.
- **Guards:** polling calls and build-door polls count as waits for the loop guard.
- **CLI:** the session name is re-applied on every new launch.

## [0.69.0] - 2026-10-19

### Added

- **Delegation and MCP tools:** tier 0 sessions delegate through MCP tools — `plan_save` / `plan_run` / `plan_status` / `plan_amend` for planned jobs and `queue_*` tools for small incremental changes (`pai queue`). A `worker_queue` state, queue view and pull-forward appear in `ps`, the cockpit and MCP. `session_profile_get` / `session_profile_set` read and write a session's model profile over MCP.
- **Model routing:** `"local"` resolves to the running local model server (each configured local provider is probed on its port; exactly one up wins, several up fall back to a named choice). Every delegation entry point takes `where` / `model` / `now`. `worker_model` sets the model per provider; plan and queue runs pass model and priority through. Per-session model profiles carry a `fallback` list and `parallel_min`; a batch skips fallback targets whose concurrency cap is below `parallel_min`. Setups write the session's worker provider and the model they show, never the global config; `"cloud"` follows the session's provider like normal routing.
- **Workers and guards:** the loop guard's no-progress rule counts worktree changes as progress, so a worker doing real work is never stopped for repeating reads or runs. Guard hits on a worker are notified to the session that started it. Goal notes carry a per-run token named in the worker contract. The plan runner stops its workers on SIGTERM and supports a graceful plan stop. Plan and queue runs refuse a double start (run lock) and their status shows running. A headless worker exits about 20 s after its final result instead of idling on leftover background tasks. Detached plan and queue runs report events to the starting session and PAILot and survive the session.
- **Cockpit and CLI:** the worker panel shows running and waiting workers near the top, with pull-forward. The cockpit gets a favicon and a dark-mode toggle. The `pai` session picker runs under 1 s warm; launch screens fit their width, take arrow keys, keep the session's own name and group named sessions one row each; "/" opens search without inserting it.

### Fixed

- **Tests:** test runs can never write the live config or send real notifications, and clear `PAI_SESSION_*`; config-writer tests pass inside workers.
- **Worktree knowledge tests** are stable under load.
- **Cockpit syntax check test** compiles the inline scripts, catching the queue-panel and theme-toggle syntax errors that shipped broken.
- **Workers:** kill ends pooled descendants too; `wait-on` never kills a worker process (use `pai worker wait` for workers); queued workers are not stall-killed by `wait-on` and heartbeat in json mode; worker panes open without stealing focus; iTerm enumeration survives a closing window; the plan runner checks the plan checkout rather than the final worker status, isolates every part in its own worktree, merges only real commits, uses visible panes, does not retry spawn refusals, and exits when blocked instead of idling.

## [0.68.0] - 2026-10-19

### Added

- **Three-tier coding guide:** [docs/three-tier-coding.md](docs/three-tier-coding.md) covers cloud orchestration with local implementers, the guards and time limits around it, and the router cockpit.
- **Loop guard** for workers: identical tool calls since the last edit are counted for every tool (test runs keyed by runner and target files, `Read` by file and range); the 5th is denied, three denials of the same call stop the session with a loop event.
- **`pai worker help`:** a budgeted call to a stronger model for one bounded sub-task (default 2 per unit, `PAI_HELP_BUDGET`), recorded in a ledger.
- **`pai worker wait-on`:** `--max-minutes` (default 30, from the process start) and `--stall-minutes` (default 5 with `--log`) kill the process tree and exit 4.
- **Orphan reaper** in the daemon (`workers.reaper`, default on): kills busy processes that workers left behind (ppid 1, over 2 minutes old, over 50 % CPU in two samples).
- **Goal notes** reach running workers: `pai worker goal` notes are delivered after the worker's next tool call.
- **Daemon quiet mode** defers maintenance jobs during measured runs.

### Fixed

- **Pool slots:** one settings file per provider and model instead of a shared one; a slot resolves the job it serves (`PAI_POOL_SLOT`), so goal notes, guards and the help budget work in pooled runs.
- **Local providers:** worker settings keep the provider's output cap, drop first-party-only flags and turn thinking off unless the provider enables it; provider `router` and `contract` keys are read and written.
- **Workers:** never write the live worker config (private copy per worker); kill ends the whole tree; dead-pid and failed-start workers are marked lost or failed; queued-then-started workers stay killable; `wait` reports unconfirmed claimed changes and timeouts correctly.
- **Guards:** the orchestrator Bash guard treats sed/perl scripts, heredoc bodies and non-code targets correctly; the worker guard hook sees every tool; delete denials tell the worker to report `delete:` entries.
- **Router:** gzip, deflate and br request bodies are decoded.
- **Merge gate:** rejects merges that remove test cases; snapshot merges go through the same gate.

## [0.67.1] - 2026-10-18

### Fixed

- **CLI exit with piped stdout:** `pai` could exit with code 13 ("unsettled top-level await") when its stdout was a pipe and output was still buffered below the high-water mark. Callers such as AIBroker's project launcher saw intermittent failures. The final flush now waits on a write callback and never hangs on a closed pipe.

## [0.67.0] - 2026-10-18

### Fixed

- **Worker pool:** a pooled task is cancelled when its client disconnects; pooled runs pass the capacity and stagger gates; `maxConcurrent` from workers.yaml is honoured (the YAML reader dropped it).
- **Merges:** a conflicted `pai worker merge` aborts instead of leaving the checkout mid-merge; worker proof checks reject masked exit codes and failure output.
- **Tests:** HOME-stubbed tests no longer read or write the real `~/.claude.json` or router files (paths resolved at call time); gc age check race fixed.
- **Panes:** a crowded window falls back to a new tab or window instead of refusing the worker.
- **Guards:** main-session guards block git mutation in slot worktrees and ad-hoc worktree or branch removal; workers may not mask proof commands.

### Changed

- **CLI rewrite** — the command line runs on a native `CommandDef` help system
  that replaces Commander; the Commander dependency is removed. `pai-daemon`
  no longer uses Commander either. `docs/commands/` is generated from the
  same definitions.
- **Long waits** — `wait`, `wait-on`, `wait-file` and `wait-url` accept
  `--max` up to 590 s; the PAI hook raises the Bash timeout automatically.
  `worker wait` returns when any worker finishes.
- **Worker pool** — pooled runs get panes, and the capacity and stagger gates
  are honoured.
- **Guard marker** — PAI denials carry a marker so they are told apart from
  other hook failures.

### Added

- **`pai worker usage`** — token tallies per provider and model for workers.
- **`pai audit tokens usage`** — exact token totals for a session transcript.
- **`pai router restart`** — restarts the router without refusing connections.
- **`pai worker merge --verify` / `--no-verify`**, the `merge.verify` config
  key and a built-in stub scan that reverts a merge adding stubs.
- **`pai worker gc`** — knowledge check and salvage of gitignored notes before
  worktree removal, `--dry-run` report, `--all-finished`, and a daily gc.
- **`pai worker wait-file` / `wait-url`**.
- **Docs** — `docs/router.md`, worker usage, pool, gc and wait sections in
  `docs/worker.md`.
- **Operator notes (local model servers)** — the qwen3_coder tool-call parser
  needs a patch for the `<<` token; do not enable a reasoning parser for
  coder models.

- **One storage layer, Postgres-only when configured** — `src/storage/` owns
  all persistence: registry, memory, vault, knowledge graph (entities and
  triples), observations and stats, each behind one interface with a SQLite
  and a Postgres implementation, chosen once from `storageBackend`. With
  `postgres`, no code path opens SQLite. `src/storage/boundary.test.ts`
  fails on any database import, raw handle, backend check or SQL outside
  `src/storage/`. One Postgres pool per process, created exit-friendly.
- **`pai db migrate-to-postgres`** — one-shot, idempotent copy of the
  registry, `kg_entities` and every memory/vault row that exists only in
  SQLite. Preflight checks the container's data bind mount and takes a
  `pg_dump` rollback; verification refuses on any missing row. Chunks whose
  embeddings came from a model of another dimension are copied without one
  and re-embedded. `--dry-run` shows what would be copied.
- **`pai hooks-db`** — the session-stop and pre-compact shell hooks update the
  registry through the storage layer instead of calling `sqlite3`.
- **Worktrees see uncommitted work** — a worktree run on a dirty checkout
  starts from a snapshot of the working tree (temporary index, checkout
  untouched); `pai worker merge` applies only the worker's own changes back
  as uncommitted edits and refuses when the operator changed the same files.
- **Guards** — in-place workers may not run tree-rewriting git commands
  (stash except list/show, reset, clean, checkout/restore of files, switch,
  rebase, merge) and are told so up front; `plutil` edit verbs without `-o`
  are blocked; `bun test` refuses to run (it cannot sandbox HOME); main
  sessions are told at start that code edits go through workers.
- **Pane close reasons** — every worker pane logs `PANE-CLOSED` with its
  reason; the pane footer shows exact elapsed time.
- **Sub-workers** — any worker may start its own with `pai worker run`: the
  runner exports `PAI_WORKER_ID`, a run launched from inside a worker records
  `parent`, and `ps`/status line render the forest (children indented, each
  with its own pane). Handoffs travel up only — `pai worker handoff
  '{"kind":"proposal","text":"…"}'` or the `worker_handoff` MCP tool (kinds
  proposal/question/blocker; results are sent automatically when a child
  finishes) — appending to `<logDir>/<parent>.inbox.jsonl` and, when the
  parent runs, arriving as an operator message; panes show `◆` lines, `ps` and
  the status line show `◆N`. Two caps under `workers.tree` bound the tree:
  `maxDepth` (default 2) and `maxChildren` running at once (default 4,
  finished children do not count).
- **Worktrees** — writing runs (`implement`/`complex`/`plan`, git repo,
  non-read-only prompt) get their own git worktree on branch `worker/<id>` by
  default (`--no-worktree` opts out, `--worktree` forces one on); the worker
  commits its branch, `pai worker merge <id>` merges `--no-ff` back and
  removes the worktree, `pai worker discard <id>` drops both. `ps` marks
  unmerged branches `⎇<commits>`; chains give a worktree to the implement
  stage only.
- **Planner class** — `--class plan` writes a plan file
  (`<logDir>/plans/<id>.json`, 5–50 sub-tasks with title/brief/class/files/
  acceptance, fewer when the goal names a smaller count), runs the sub-tasks
  as children of the planner in waves of `maxChildren`, and finishes with a
  summary plus the branches to merge.
- **Clickr controls** — default `mcpSets` gained `desktop = ["clickr"]`;
  `pai worker run --mcp desktop` gives a worker screen control following the
  session handover, and `pai worker controls <id> you|me` flips it.
- **Machine-wide fallback** — `pai worker fallback on [provider]` switches
  every NEW Claude Code process on the machine (interactive sessions,
  task-bus sessions, the daemon's headless summarizer) to a worker provider
  when the Anthropic plan runs out, until `pai worker fallback off`. `on`
  writes the provider's base URL, token (read from its key file at switch
  time — it then sits in settings.json until `off`), the three
  `ANTHROPIC_DEFAULT_*_MODEL` pins, its extra env, `ENABLE_TOOL_SEARCH` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` into the `env` block of
  `~/.claude/settings.json` and pins the top-level `model`; the replaced
  values are saved under `workers.fallback.saved` in the pai config and
  `off` restores settings.json exactly. `fallback status` reports the state,
  lists running Claude Code sessions (AIBroker registry when populated, else
  `ps` — running sessions keep their provider until restarted) and the
  `FALLBACK-ACTIVE.md` note `on` leaves in the workers log dir. The settings
  path is overridable via `CLAUDE_SETTINGS_PATH` for dry runs; the Agent
  hook keeps routing subagents to workers while on. MCP `worker_fallback`
  (on/off/status) and the Worker skill phrases ("switch everything to glm",
  "fallback on", "back to anthropic", "fallback off", "is fallback on").
- **`workers.yaml`** — providers, per-role model ids and class routing move
  out of `config.json`'s undocumented `workers` JSON section into one
  hand-editable, commented file under `PAI_HOME` (`~/.claude/pai/`), kept
  mode 0600 and never committed. `pai worker config path|init|check|migrate
  [--dry-run|--force]|inline-keys` manage it; `key_file:` keeps a secret out
  of the file, `inline-keys` moves it back in. Adding a provider — including
  an OpenAI-protocol remote (`protocol: openai` + `upstream_url`, routed
  through the built-in proxy) or a Codex-CLI one (`engine: codex`) — is a
  YAML edit, never code. The built-in `anthropic` provider now states its
  model hierarchy as policy in the starter file: Sonnet for every class,
  Haiku for `spotcheck`/`simple`, no worker inherits the orchestrating
  session's model, and Opus has no default slot — only `--model` per run.
  See `docs/workers-config.md`.
- **Pane and bar status lines** — each worker pane's bottom line now reads
  `<goal> · <model> · started HH:MM · <age>`; the statusline's 🐝 worker bar
  collapsed from one row per running worker to a summary,
  `<provider> ▶N · <models ×count> · oldest <age>   ✓ok ✗bad today`. `pai
  worker goal <id> "<text>"` (or `worker say --goal "<text>" <id> <msg>`)
  relabels a running worker's goal without sending it a message.
- **`--chrome` passthrough** — allowlisting any `mcp__claude-in-chrome__*`
  tool in `--allowedTools` appends `--chrome` to the worker's launch
  automatically; it is not a configured MCP server.
- **`workers.caveman` and route pinning** — every Claude Code spawn (worker
  run, AG2 re-ask, `providers test`) repeats its `ANTHROPIC_BASE_URL` with
  `--settings`, which outranks the user settings' `env` block; a machine-wide
  proxy route there had been swallowing worker routes and sending provider
  tokens to Anthropic. Native-Anthropic runs are pinned to
  `api.anthropic.com`, or launched as `caveman claude` when
  `workers.caveman: true` in `config.yaml` (default off).
- **Whisper rule tags** — a `# @orchestrator` / `# @worker` comment line in
  whisper-rules.md marks every following rule as orchestrator-only or
  worker-only until the next section header; untagged sections reach both.
  Workers are distinguished by `PAI_WORKER=1` in their environment. See
  `docs/worker.md`.

### Fixed

- **Worker panes no longer vanish** — an exception in `follow`'s poll loop
  killed the process and iTerm closed the pane without a trace; errors now
  stay visible in the pane.
- **Security validator denials are readable** — the reason goes to stderr, so
  sessions see why a command was blocked instead of "No stderr output".
- **`pai memory embed` no longer runs out of memory** — it pages through the
  unembedded backlog instead of loading it at once.
- **Interactive launches keep project MCP pins** — `projectLaunchConfig` is
  async and is now awaited; worktree runs report their recorded commit count.
- **Worker follow panes open reliably** — iTerm intermittently fails window
  enumeration with -1708 ("every window doesn't understand count", ~5% of
  calls, in bursts up to ~2 s), and the swallowed error left headless workers
  without a pane. The AppleScript helper retries that one error (6 attempts,
  500 ms apart); a pane that still fails writes `PANE-FAIL` to the ledger.
- **Worker-path launch names the session** — a fresh `pai <name>` through
  `pai worker run` now carries `--name` and the `/Name … / go` opener like
  the claude path; sessions no longer open unnamed.
- **Resume is offered** — `pai <name>` asks `Resume it? [y/N]` when a
  transcript exists; default fresh; `-y`, `--resume`, non-TTY skip the
  question.
- **`pai worker kill`** — `kill <id>` raced the run's own SIGTERM handler
  and could overwrite its terminal status with a half-empty `killed
  rc=null ?s` row; it now waits for the run to self-report and only writes
  a status itself when that never arrives.
- **Status line live usage** — the statusline's usage gauge reads the
  Keychain item scoped to the current user (`security find-generic-password
  -a "$(id -un)"`); a stale, unscoped duplicate `Claude Code-credentials`
  item was shadowing the real one and freezing the reading at a stale
  value.

### Docs

- **Agent-tool gate** — documented in `docs/worker.md`: with workers on, a
  PreToolUse hook denies every `Agent` call and points the orchestrator at
  `pai worker run` instead; `pai worker off` or `ALLOW_ANTHROPIC_AGENTS=1`
  bypass it. Pre-existing behavior, not newly changed.

## [0.38.0] — 2026-09-17

### Added

- **Task classes** — roles became classes: `workers.classes` maps the nine
  standard task classes (draft, plan, implement, review, research, spotcheck,
  simple, complex, image) to a provider, `provider/fast`, or an object with
  routing constraints. Providers carry `costTier` (1 cheapest … 5, default 3)
  and `tags` (code, vision, image-gen, long-context, fast, reasoning); a class
  may set `maxCostTier`, `requireTags` and its own `order`, and auto-routing
  fails with the exclusion reason of every provider when nothing qualifies.
  `--class` replaces `--role` (kept as alias); `pai worker classes
  list/set/unset` manages them; old `roles` configs keep parsing and migrate
  to `classes` on first write.
- **Chains** — `pai worker run --chain draft,implement[,review]`: the draft
  stage turns the brief into a spec file under `<logDir>/specs/<chain id>.md`
  (goal, constraints, files likely touched, acceptance checks, verification
  commands), implement runs with that spec plus the original brief, review
  reads the diff against the spec and produces the structured report. Each
  stage is its own worker (own id and pane, `parent` set to the chain id);
  `ps` shows chains as trees; a failed stage (or a draft without a spec)
  stops the chain.
- **Agent definitions as workers** — `pai worker run --agent <name>` loads
  `~/.claude/agents/<name>.md`: the body becomes `--append-system-prompt`,
  `tools` the allowlist, `model` maps to a class (haiku→simple, sonnet→
  implement, opus→complex) unless `--class` is given; the label defaults to
  `<agent>: <first 50 chars of prompt>`.
- **MCP `worker_classes`** (list/set/unset, with `max_cost_tier`/
  `require_tags`) and **MCP `worker_run`** — start a worker or chain from
  chat, returning the id immediately. `worker_providers` gained `cost_tier`/
  `tags` on add and an `update` action. The Worker skill maps preference
  phrases ("route research to X", "cheap only for drafts", "show the routing
  table") onto these tools and never sends the user to a config file.

- **Chat line in the follow pane** — `pai worker follow <id>` on a TTY is a
  chat, not a tail: the transcript scrolls in an ANSI scroll region, the
  prompt row (`› `, readline editing) and the ticker row stay fixed, and
  Enter says the line to the running worker or resumes the finished one
  (the pane follows the fresh run). Commands `/help`, `/quit`,
  `/resume <text>`, `/status`; Ctrl-C leaves on an empty prompt and clears a
  draft, Ctrl-D leaves; the echoed `»` row appears once (the mirrored
  operator event is swallowed); the auto-exit countdown holds while the
  prompt has unsent text. Non-TTY output keeps the plain behaviour.

### Changed

- **Worker ids no longer collide** — two workers or chains starting in the
  same second of one process get a monotonic `-01`, `-02` suffix instead of
  overwriting each other's status and transcript files.
- **Viewer-side wrapping with an unbroken gutter bar** — `follow`/`replay`
  wrap rows at the terminal width (whitespace-preferred, hard-wrap fallback,
  ANSI escapes never split, diff colours carried onto continuation rows),
  and every continuation row carries a blank-time gutter that keeps the `│`
  bar, so no content lands left of it. Piped output keeps the terminal's own
  wrapping.

## [0.37.0] — 2026-09-17

### Added

- **Worker providers** — subagents run on endpoints you configure (any
  Anthropic-compatible API, any OpenAI-compatible API, or the Codex CLI)
  instead of the main session's Anthropic account.
  Typed `workers` section in `~/.config/pai/config.json`; `pai worker` CLI
  group (run, ps, follow, replay, pane, log, status-line, providers, roles,
  on/off, install); MCP tools `worker_status`, `worker_providers`,
  `worker_roles`, `worker_toggle`, `worker_ps`, `worker_replay`. A PreToolUse
  hook denies the Agent tool and rewrites delegation to `pai worker run`
  (bypass: `ALLOW_ANTHROPIC_AGENTS=1` or `pai worker off`). Provider routing
  with roles, cooldowns, quota probes and automatic rerouting; per-worker
  status files, an append-only ledger, iTerm follow panes, and a status-line
  entry. The glm/glm-run/glm-ps/glm-log commands survive as shims
  (`pai worker install` migrates and moves previous versions to
  `<name>.pre-pai`).
  See [docs/worker.md](docs/worker.md).

- **Worker proxy for OpenAI-protocol providers** — providers with
  `protocol: "openai"` + `upstreamUrl` run through a built-in translating
  proxy (Anthropic Messages API in, OpenAI Chat Completions out): system,
  multi-turn text, tool_use/tool_result ↔ tool_calls, tools ↔ functions,
  streaming SSE with streamed tool-call arguments, usage and error mapping.
  Loopback only, started on demand by `run` (pid file under the logDir),
  managed by hand with `pai worker proxy [--port N|stop]`; the config is
  re-read per request. The worker holds a placeholder token; the real one
  stays inside the proxy. `providers test` goes through it.

- **Codex engine for workers** — a provider with `engine: "codex"` runs
  `codex exec --json` instead of Claude Code; its JSONL events are folded
  into the same status fields, transcript shape and final print. Flags with
  no Codex equivalent (`--allowedTools`, MCP) are dropped with a ledger
  note; `providers test` reports `codex not installed` when the CLI is
  missing.

- **Stamped transcripts, gutter and liveness** — every mirrored event in
  `<id>.jsonl` carries an ISO `_ts`; `follow`/`replay` render a dim
  `HH:MM:SS │ ` gutter (worker-tagged when several run at once, day
  separator on rollover), and a TTY liveness line
  `⋯ <n>s since last event · <last action>` overwritten in place.

- **The worker contract** — headless runs append a system prompt fixing the
  final answer: one JSON message with `changed`/`commands`/`checks`/`open`/
  `notes`. The runner parses it (notes become the table's one-liner,
  `--output-format json` gains a `report` field) and the viewer renders it
  as a compact block. A caller's `--append-system-prompt` is applied
  alongside. Panes count down `pane.autoExitSecs` (now default 60).

- **say / resume** — headless runs keep stdin open (`--input-format
  stream-json`): `pai worker say <id> "<text>"` (or `worker_say`) forwards a
  message over the per-worker Unix socket while it runs, mirrored as `»`
  operator events; after the result, stdin closes 2 s later unless another
  message arrives. `pai worker resume <id> "<text>"` (or `worker_resume`)
  continues the same Claude session on the same provider (`↩ <label>`); a
  `follow` pane reads its own stdin the same way.

- **Context meter and worker MCP allowlist** — status files track
  `contextTokens`/`contextWindow` (init event, provider `contextWindow`, or
  200k); the `ps` table and status line show `ctx 84k/200k (42%)` past 60 %
  (yellow >70, red >85), the pane liveness always. Headless workers start
  with no MCP servers by default (server definitions cost context and
  startup); opt in per run with `--mcp office` / `--mcp memory,github` or a
  role's `"mcp": [...]`, expanded from `workers.mcpSets` + `~/.claude.json`
  into a filtered `<id>.mcp.json`; unknown names fail fast;
  `pai worker mcp list` shows what exists. Pane commands are now
  `exec pai worker follow …` (one process, direct signals).

### Fixed

- **Worker follow panes never got their profile** — reading iTerm's
  preferences went through `plutil -convert json` on the whole plist, which
  refuses real iTerm preferences (they contain `<date>` objects:
  "Invalid object in plist for JSON format"), so the `pai-worker` dynamic
  profile was never written and panes opened with the default profile. The
  read now uses key-scoped `plutil -extract`; and when the preferences
  cannot be read at all, the profile is still written — font
  `Menlo-Regular <fontSize>`, no parent, reason on stderr once — instead of
  being skipped.

### Changed

- **`workers.pane.fontScale` → `workers.pane.fontSize`** (default 13) — the
  pane profile's font is the default profile's family at that point size
  (`MesloLGLNFM-Regular 13` on a machine whose default is
  `MesloLGLNFM-Regular 18`) rather than a scaled size. A legacy `fontScale`
  value in the config is tolerated and ignored. `pai worker pane <id>
  --check` now also prints the profile file's path, whether it exists, and
  the font it contains or would write.

---

## [0.8.6] — 2026-04-07

### Added

- **4-layer wake-up context** — `memory_wakeup` MCP tool loads identity (L0, from `~/.pai/identity.txt`), essential story (L1, from recent session notes), with on-demand topic queries (L2) and deep search (L3) available during the session. Called automatically by the `SessionStart` hook. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Temporal knowledge graph** — New `kg_triples` table with `valid_from`/`valid_to` timestamps. Four MCP tools: `kg_add` (add a time-bounded fact), `kg_query` (query facts valid at a given point in time), `kg_invalidate` (expire a fact), `kg_contradictions` (surface conflicting facts). Facts can now evolve over time rather than accumulating as an undated flat store. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Memory taxonomy** — `memory_taxonomy` MCP tool returns a structured overview of all indexed content: per-project session and chunk counts, embedding coverage, and recent activity. Useful as both a user-facing status tool and a model-facing context signal. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Mid-session auto-save** — The Stop hook now fires a session-summary work item every 15 human messages (configurable via `PAI_AUTO_SAVE_INTERVAL` env var or `autoSaveInterval` in `config.json`). Returns `continue: true` to block the Stop event and keep the session running. A `stop_hook_active` flag on the work item prevents save loops. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

- **Cross-project tunnel detection** — `memory_tunnels` MCP tool detects concepts shared across multiple projects by comparing FTS vocabulary (SQLite: FTS5 `vocab` virtual table; PostgreSQL: `ts_stat()`). Returns ranked concept-tunnel pairs with a tunnel strength score. Inspired by [mempalace](https://github.com/milla-jovovich/mempalace).

### Previously shipped (v0.8.5) — credited here for completeness

- **God-note detection** (`zettel_god_notes`) — Surfaces notes with disproportionately high in-degree link counts. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Confidence tagging on vault links** — The `vault_links` table carries a `confidence` column on each directed link. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Query feedback loop** — Queries and results are logged to `~/.config/pai/queries/` to improve future retrieval. Inspired by [graphify](https://github.com/safishamsi/graphify).
- **Community detection** (`zettel_communities`) — Louvain community detection partitions the vault link graph into thematic clusters. Inspired by [graphify](https://github.com/safishamsi/graphify), which uses the Leiden algorithm.

---

## [0.8.0] — 2026-03-24

### Added

- **Topic-based note splitting** — The session summarizer now outputs a `TOPIC:` line. PAI compares this against the existing session note title using Jaccard word similarity. Topics with less than 30% similarity trigger creation of a new note, so a single session covering distinct subjects produces separate, focused notes.
- **Multi-note-per-day numbering** — When topic splitting creates additional notes in the same day, they receive sequential session numbers (e.g., 0042, 0043) rather than overwriting or appending to the existing note.
- **Garbage title filter** — Over 20 patterns are rejected as session note titles: task notification strings, `[object Object]`, hex hashes, bare numbers, and other artifacts that can appear in JSONL transcripts. Titles must describe actual work done, capped at 60 characters.
- **Topic-detect worker** (`src/daemon/topic-detect-worker.ts`) — Processes `topic-detect` work items using a BM25-based detector against the PAI memory database to identify project-level topic shifts.

---

## [0.7.8] — 2026-03-20

### Fixed

- **API key stripping** — The daemon now removes `ANTHROPIC_API_KEY` from the environment of spawned headless Claude CLI processes. This forces the CLI to authenticate via the Max plan subscription rather than the API billing path, preventing unintended API charges for automatic session summarization.

---

## [0.7.7] — 2026-03-18

### Added

- **Whisper rules hook** (`src/hooks/ts/user-prompt/whisper-rules.ts`) — A `UserPromptSubmit` hook that injects critical operating rules on every prompt submission. Rules are read from `~/.claude/whisper-rules.md` and survive compaction, `/clear`, and session restarts. Inspired by the Letta claude-subconscious pattern.

---

## [0.7.6] — 2026-03-16

### Fixed

- **Claude binary discovery** — `findClaudeBinary()` now checks `~/.local/bin/claude` before PATH resolution. The launchd environment used by the daemon does not include `~/.local/bin/`, which is the standard install location for Claude CLI. Sessions running under launchd can now spawn headless summarization processes reliably.

---

## [0.7.5] — 2026-03-15

### Added

- **Tiered model selection for summarization** — Session summary worker uses Opus (5-minute timeout, 500K JSONL bytes) for Stop-hook-triggered summarizations and Sonnet (2-minute timeout, 200K JSONL bytes) for PreCompact-triggered summarizations. Haiku is available as a budget option.

---

## [0.7.4] — 2026-03-14

### Fixed

- **Auto-register on parent match** — Fixed a case where broad parent projects (home directory, top-level `apps/` folder) were swallowing new projects that should have been auto-registered. `load-project-context` now detects when the current working directory contains its own project signals (`.git`, `package.json`, `pubspec.yaml`, etc.) even when a parent project matches, and registers the CWD as a separate project.

---

## [0.7.3] — 2026-03-13

### Added

- **AI-powered session notes via daemon** — The daemon now automatically generates structured session notes by spawning a headless Claude CLI process to summarize JSONL transcripts plus recent git history. Notes include: Work Done, Key Decisions, Known Issues, and Next Steps.
- **Session summary worker** (`src/daemon/session-summary-worker.ts`) — Processes `session-summary` work items from the daemon queue.
- **PreCompact and Stop hooks push session-summary items** — Both hooks enqueue summarization work rather than doing it synchronously. The Stop hook uses a `force: true` flag to bypass the 30-minute cooldown.
- **30-minute cooldown** — Prevents redundant summary updates during rapid compaction cycles in active sessions.

---

## [0.7.2] — 2026-03-10

### Added

- **Auto-registration of new projects** — The `load-project-context` SessionStart hook detects project signals (`.git`, `package.json`, `pubspec.yaml`, `Makefile`, `go.mod`, etc.) in the current working directory and registers the project automatically on first encounter.
- **One note per session** — PreCompact hook creates at most one session note per session (not one per compaction). Subsequent compactions update the existing note rather than creating new ones.
- **Garbage title filter** — Initial 20+ pattern list rejects non-descriptive titles from JSONL artifacts.
- **`/reconstruct` skill** (`src/daemon-mcp/prompts/reconstruct.ts`) — Retroactively creates session notes from JSONL transcripts and git history for sessions where automatic capture did not run or produced no output.

---

## [0.7.1] — 2026-02-28

### Added

- **Daemon work queue** (`src/daemon/work-queue.ts`) — Persistent file-backed queue at `~/.config/pai/work-queue.json`. Hooks become thin relays that push items and exit; the daemon processes items asynchronously with exponential backoff retry.
- **Thin relay hooks** — Stop, SessionEnd, and PreCompact hooks refactored to enqueue work items rather than doing synchronous work.
- **Session note fixes** — Various fixes to session note creation and numbering.

### Changed

- Work queue item types: `session-end`, `session-summary`, `note-update`, `todo-update`, `topic-detect`.

---

## [0.7.0] — 2026-02-20

### Added

- **Modular plugin architecture** — PAI restructured into 8 named modules across 3 pricing tiers (free, pro, enterprise).
- **Cross-platform manifests** — `pai-plugin.json` (canonical), `.claude-plugin/plugin.json` (Claude Code), `.cursor/plugin.json` (Cursor), `gemini-extension.json` (Gemini CLI).
- **User extension points** — `user-extensions/skills/` and `user-extensions/hooks/` directories (gitignored, survive `git pull`).
- **Module definitions** — `plugins/<module>/plugin.json` for each of the 8 modules.

---

## [0.6.6] — 2026-02-15

### Fixed

- SessionEnd hook abort race condition.

---

## [0.6.5] — 2026-02-12

### Added

- Symlink deployment for hooks and shell scripts (PAI-owned files symlinked from `~/.claude/` to source/build directories).
- Dynamic daily budget configuration.

---

## [0.6.4] — 2026-02-10

### Fixed

- Count directories correctly when numbering session notes.
