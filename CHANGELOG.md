# Changelog

All notable changes to PAI Knowledge OS are documented here.

---

## [Unreleased]

### Added

- **Cockpit layout:** the cockpit is arranged in sections by purpose, and sections and tiles can be rearranged by drag and drop; tiles drop where the pointer is. `router.cockpit.sections` limits the page to the listed sections. Cards fold, and folds and open lists survive a refresh and a redraw. A refresh no longer moves the page, and the page fits its viewport at any zoom and font size.
- **Cockpit models:** the Models section shows one card per consumer, titled by purpose (including the PAI embedding card and on-demand models), with live tiles, a metric tile with sparkline, a single local-model switch, and a start/stop action configured per runtime. Models carry editable aliases (pencil next to the headline, working on touch with save, cancel and reset). Numbers use binary GB and match the engine's own monitor; disabled providers and unloaded tiers no longer appear as down.
- **Cockpit on a phone:** session names, the sessions and pause tables, and stacked tables fit the screen; headers are compact and card names stay readable.
- **Cockpit readability:** every model keeps one distinct colour across all charts, axes and legends are readable, rings are drawn by model, and tables, totals, workers, pool and system read cleanly. Job chips, card purpose lines, a scheduler line and server memory in GB were added; a flagged report is no longer shown as a failed run.
- **Delegation tiers and routing:** routing follows three delegation tiers — t0 session, t1 orchestrator, t2 worker — instead of nine class rows; every class routes by its tier list, and the chain set in the cockpit is the order routing uses. The default delegation table ships with PAI. `pai worker route` shows and sets the routing, the cockpit has a routing section with per-class model chips and model ranks per role, and a session can override the routing for itself. Local tiers exist for Strata and scripts, and the local switch stops every local engine.
- **Escalation one tier up:** a worker that cannot finish is retried one tier higher, automatically, from the salvaged branch — on a full context, a missing tool or a repeated failure. A loop stop with saved work escalates at once; a local run that committed is reviewed rather than redone on the cloud, and a loop after committing counts as finished work.
- **Worker pool and reload:** pool spares are pre-started, task-less workers that take one task each; the pool seeds the local provider and refreshes stale spares, and pane titles show the worker's purpose. `pai reload` restarts the daemon, and the pool host reloads itself after a build.
- **Worker panes are owned by the process:** `worker run`, `pane run` and `plan run` start their command inside the pane that owns it, so closing the pane ends the process. A process started inside a pane, or a worker's child worker, gets its own pane. The auditor is now a bug detector only: it writes to a ledger and kills orphan sides, and never reopens a pane.
- **Providers test:** `pai providers test` checks what workers would really use, including the native Claude provider, which is probed by spawning like a worker and reading the reply.
- **Install:** the repo is its own plugin marketplace, so installing takes two commands, and the setup skill was rewritten to install PAI on its own with sequential steps and correct counts.
- **Documentation:** concept pages for tiers, routing policy, escalation, session profiles, workers, providers, panes, pool, router, local models, loop guard and notifications; install and first-workers pages; a cockpit page walking through each section with screenshots. The README and docs index lead with the install skill and orchestration. Stale worker and config docs were rewritten, and a test now requires documented keys and commands to exist.

### Changed

- **Config values out of code:** defaults for delegation, router, cockpit layout, panes, notices and runtimes live in shipped defaults files under the user config instead of in code. `pai config get --source` shows where a value comes from.
- **PAILot only for replies:** automatic notices never go to PAILot; a run end produces at most one notice, and the messenger is rate-limited.
- **Workers:** a worker never runs in place while editing — an existing branch is reused or renamed. Run reports reach a background session's tab, and panes for a background session are found through the Claude daemon's control socket.

### Fixed

- **Reload and daemon:** shipped defaults resolve from the daemon bundle, not the working directory; `pai reload` starts a stopped daemon or reports the failure. A pool host self-update always comes back and reload waits for it.
- **Loop guard:** the guard fingerprints content, so touching a file no longer gets a repeated command past it.
- **Killing workers:** the owning session may kill its worker when it runs as a background session.
- **Context meter:** context fill is the largest turn, not the run's token total.
- **Workers:** a missing or unseen pane never blocks a worker start; pooled runs end and fall through like fresh ones; a pooled worker is alive only while its slot process is; read files are not reported as changes; AG2 shape slips are repaired before validating; the follow view prints plain text and titles only to a terminal.
- **Panes:** launcher panes show the live status and input lines; one rule decides pane or not, and resume no longer takes `--no-pane`; ended pane runs are not violations.

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
