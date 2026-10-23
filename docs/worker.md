# Workers: reference

> Overview: [concepts/workers.md](concepts/workers.md). Routing: [delegation tiers](concepts/delegation-tiers.md), [routing policy](concepts/routing-policy.md). Every flag: [commands/worker.md](commands/worker.md). Provider and tier keys: [workers-config.md](workers-config.md).

This page holds what the concept pages and the generated command page do not: the shipped defaults, how a worker process is built, supervision, chains, and the details of sub-workers, merge and cleanup.

## Config summary

Two files, both under the PAI home (`pai config path`, `pai worker config path`):

| File | Holds |
|---|---|
| `workers.yaml` | `providers`, `tiers`, `classes`, `capabilities`, `mcp_sets`, `active`, `local`, `local_tiers`, `merge.verify` ([keys](workers-config.md)) |
| `config.yaml`, section `workers` | everything else: `enabled`, `pane`, `routing`, `tree`, `supervision`, `pool`, `cacheKeepaliveSecs`, `defaultMaxMinutes`, `gcOlderThanHours`, `worktreesMaxGb`, `caveman`, ... |

Both are layered over shipped defaults ([config-defaults.md](config-defaults.md)). A fresh install has workers **off** (`workers.enabled: false`), one provider (the built-in `anthropic`, models `default: sonnet`, `fast: haiku`), the three shipped tiers `t0`/`t1`/`t2` and `classes: {}` (the class-to-tier mapping lives in each tier's `classes` list). `pai worker on` enables workers; `pai worker config init` writes a starter `workers.yaml`.

Selected `workers` keys and their shipped values:

| Key | Default | Meaning |
|---|---|---|
| `defaultMaxMinutes` | `60` | Time limit of every run; 0 = none. |
| `waitAlarmMinutes` | `120` | Minutes a run may queue for a slot before the owner is told. |
| `tree.maxDepth` / `tree.maxChildren` | `2` / `4` | Sub-worker nesting and concurrent children per parent. |
| `supervision.stallMinutes` | `10` | Minutes without a tool call before a run counts as stalled. |
| `supervision.push` | `harness` | Which alerts reach the session: `harness` or `all`. |
| `supervision.pointer` | `false` | Type "N worker alerts pending" lines into session panes. |
| `pane.enabled` / `pane.autoExitSecs` | `true` / `5` | Follow pane, and its countdown after the worker ends. |
| `gcOlderThanHours` / `worktreesMaxGb` | `6` / `20` | Hourly gc archives finished worktrees older than this, or the oldest ones past the size cap. |
| `stagger.*`, `capacity.*` | on | Start gate and per-provider concurrency cap (local default cap 1, uncapped queue cap 3). |
| `priority.sessions` | `{}` | Queue priority per named session, `{ "<session>": high\|normal\|low }`. When a provider is full, queued runs are admitted high before normal before low, oldest first within a priority (sessions still take turns); running workers are never preempted. `pai worker run --priority high\|normal\|low` overrides it for one run. `pai worker priority` lists and changes the entries without editing workers.yaml. `pai worker ps` and the cockpit queue show the priority. |
| `cacheKeepaliveSecs` | `0` | Daemon cache heartbeat; off. See [cache-keepalive.md](cache-keepalive.md). |
| `reaper` | `true` | Daemon reaper for orphaned worker processes. |
| `caveman` | `false` | Run native-Anthropic workers through `caveman claude`; off pins them to `api.anthropic.com`. |

Read or change any of them with `pai config get|set workers.<key>`.

### Pool keys

Under `workers.pool` (behaviour: [concepts/pool.md](concepts/pool.md)):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Pool routing; `pai worker pool on|off` sets it. |
| `spares` | `1` | Pre-started task-less workers per (repo, provider) key; 0 = off. |
| `idleKillSec` | `1800` | Seconds before an unclaimed spare is retired; 0 = never. |
| `maxSlots` | `3` | Most slot processes the host keeps across all keys. |
| `idleSecs` | `900` | Idle seconds before a slot is killed; 0 = never. |
| `port` | `8798` | Loopback port of the pool host. |
| `native` | `true` | Native Anthropic runs may use pooled slots; worktree runs never do. |
| `continuation` | `false` | Old path where one slot serves successive tasks. |

## What a worker is

- One `claude -p ... --output-format stream-json --verbose` process per call, with `--input-format stream-json` and stdin held open: the task is the first user message and `say` lines continue it.
- Environment from the provider: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (read from the key, never from the caller's environment), the three `ANTHROPIC_DEFAULT_*_MODEL` pins, the provider's `env`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. `ANTHROPIC_API_KEY` is stripped so nothing falls back to Anthropic billing. OpenAI-protocol providers point at the local proxy instead.
- The route is repeated with `--settings '{"env":{...}}'`, which outranks the `env` block of `~/.claude/settings.json`; a machine-wide proxy there cannot swallow a worker's route. A native-Anthropic run with no route is pinned to `https://api.anthropic.com`.
- Headless runs get `--strict-mcp-config --mcp-config <file>` and `PAI_WORKER=1`, which makes PAI's per-session hooks leave them alone.
- The stream lands in `<logDir>/<id>.jsonl`, live state in `<id>.status`, every event in `<logDir>/ledger.log` (`logDir` defaults to `~/.claude/logs/workers`). Context use (`contextTokens` of `contextWindow`) shows in `ps` past 60 %.

A worker's final message follows the report contract described in [concepts/workers.md](concepts/workers.md); the exact system-prompt text is `WORKER_CONTRACT_PROMPT` in `src/workers/report.ts`. `.pai/worker.md` in the project root is appended after it under a `## Project worker rules` header (see [worker-project-setup.md](worker-project-setup.md)); a file over 16 KB is refused.

## Supervision

The daemon watches the workers ledger every 30 seconds (`src/workers/supervision.ts`, no model calls) and pushes one line to the owning session for each of:

| Event | Condition |
|---|---|
| `worker <id> <label> finished rc=0` | clean end |
| `worker <id> <label> failed rc=N` / `failed runner gone` | non-zero rc, error state, or the runner pid vanished while `running` |
| `worker <id> <label> stalled Nm no turns` | no new turn for `supervision.stallMinutes` (env `PAI_WORKER_STALL_MINUTES` overrides) |

Delivery goes through AIBroker `send_to_session` when the session is reachable; otherwise, and always as a record, one JSON line per event is appended to `<logDir>/supervision/<session>.events` and the `worker-supervision` UserPromptSubmit hook shows unseen lines on the next prompt. Delivered ids persist in `supervision/state.json`, so a daemon restart does not repeat them. Which alerts count is `supervision.push`.

## Chains and agents

`pai worker run --chain draft,implement[,review] -p BRIEF` runs stages one after the other, each its own worker with its own pane, `parent` set to the chain id. `draft` writes a spec under `<logDir>/specs/<chain id>.md`; `implement` takes the spec as its prompt; `review` reads the spec and the diff. A failing stage stops the chain; `--class` overrides every stage's class; `--label` names the chain. Only the implement stage gets a worktree.

`pai worker run --agent NAME` loads `~/.claude/agents/NAME.md` (front-matter `model`: haiku to `simple`, sonnet to `implement`, opus to `complex`; `tools` to `--allowedTools`; body appended to the system prompt) and runs it as a worker.

`--class plan` runs a small orchestration: a planner writes `<logDir>/plans/<id>.json` (5-50 sub-tasks), the runner spawns them as its children up to `tree.maxChildren` at a time, their reports return as `result` handoffs, and the run ends with an `n/m sub-tasks ok` summary. For scripted plans see [plan-runner.md](plan-runner.md).

## Sub-workers and handoffs

Every worker has `PAI_WORKER_ID` in its environment; a `pai worker run` launched inside one records `parent`, so `ps` shows a tree. Handoffs travel up only: `pai worker handoff '{"kind":"proposal|question|blocker","text":"..."}'` appends to `<logDir>/<parent>.inbox.jsonl` and, if the parent runs, arrives as `[handoff from <id>]`. `ps` shows `◆N` for N handoffs. Depth and breadth are capped by `tree.maxDepth` and `tree.maxChildren`; a launch past the depth cap fails and suggests a handoff. A chain id is not a worker and is never depth-capped.

## Talking to a worker

`pai worker say ID TEXT` writes to the worker over `<logDir>/<id>.sock` while it runs; stdin closes two seconds after the result, after which `say` refuses and points at `resume`. `pai worker resume ID TEXT` continues the same Claude session on the same provider (not available for `engine: codex` workers). `pai worker goal ID TEXT` relabels a running worker without a message. In a `follow` pane on a terminal, typed lines are said or resumed; `/quit`, `/resume TEXT` and `/status` are the commands.

## Worktrees, merge, gc

A run that writes files (`implement`, `complex`, `plan`) in a git repo gets `<logDir>/worktrees/<id>` on branch `worker/<id>` from HEAD; if git refuses, it runs in place and says so. `ps` marks an unmerged branch `⎇<commits>`.

- `pai worker merge ID` merges with `--no-ff`. `--verify CMD` (or `merge.verify` in `workers.yaml`) runs on the merged tree; a non-zero exit reverts with `git revert` and keeps the branch. `--no-verify` skips the configured default with a warning. A stub scan of added `src/` lines (`TODO: implement`, empty stubs, `not implemented` throws) always runs and reverts the same way.
- `pai worker discard ID` removes worktree and branch.
- `pai worker gc` moves old finished worktrees to `refs/pai-archive/ID` (flag default 24 h; the hourly automatic gc uses `gcOlderThanHours`). Gitignored knowledge files such as `Notes/` are copied into the main checkout first; a worktree that cannot be salvaged is kept.
- `pai worker usage [--since WHEN]` sums exact tokens and cost per provider and model.

## Waiting

Never sleep-poll. Each wait verb returns within `--max` seconds (default about 100, up to 590); exit 0 means ready, 3 means not yet, call again.

| Verb | Waits for |
|---|---|
| `pai worker wait IDS` | child workers; returns when any finishes |
| `pai worker wait-on PID` | a detached process (`--log` prints its tail) |
| `pai worker wait-file PATHS` | every path to exist |
| `pai worker wait-url URL` | the URL to answer |

## Engines

- **Proxy.** A provider with `protocol: openai` goes through a loopback translating proxy (default port 8797, started on demand; `pai worker proxy [--port N|stop]`). It holds the real token; the worker runs with a placeholder.
- **Codex.** `engine: codex` runs `codex exec --json`. `--allowedTools` and MCP flags are dropped with a `WORKER-NOTE`; `resume` is unavailable.
- **Image.** `engine: image` plus `--capability image` POSTs to `{url}/images/generations` and writes the PNG (`--out`, `--size`); no process, worktree or pane. Capability preference: [workers-config.md](workers-config.md#capabilities).

## Budget routing

With `active: auto`, or when a session's provider is full, the walk follows `routing.policy` (`budget` by default, `order` for the plain walk). Candidates come from `routing.priority`, else `routing.order`, else `routing.budgetPriority` (`anthropic, glm, kimi`). A provider whose live budget reaches its wall is skipped (`routing.budgetPercent`: anthropic 95, glm 90, kimi 85; override per provider in `routing.budgetWalls`). Budgets come from each provider's `usage` endpoint, cached five minutes; a failed probe counts as unknown. A walled provider is in cooldown until `max(now + 10 min, resetAt)`; a quota failure before the first tool call reruns on the next provider (`WORKER-REROUTE`, `routing.retryOnQuota`, cooldown `routing.cooldownMinutes` 30). The provider is fixed at spawn and never switched mid-run.

## Machine-wide fallback

`pai worker fallback on [PROVIDER]` writes the provider into the `env` block of `~/.claude/settings.json`, so every new Claude Code process runs on it until `pai worker fallback off` restores the file. The token sits in settings.json while it is on. Running sessions are not switched; `pai worker fallback status` lists them. To start one session on another provider use `pai launch --provider NAME`.

## Visibility and enforcement

`ps`, `follow` and the status line show the workers of the asking session; `--all` widens. `ps` also appends a `scope: MACHINE` section for live workers of other sessions, so none is hidden. A headless run opens and verifies a visible pane or is refused ([panes](concepts/panes.md)); the operator can allow hidden runs with `PAI_WORKER_ALLOW_HIDDEN=1` in their own shell or the file `~/.pai/headless-ok`.

With workers on, a PreToolUse hook denies the `Agent` tool and tells the orchestrator to use `pai worker run`. `pai worker off` or `ALLOW_ANTHROPIC_AGENTS=1` (one session) lifts it. Whisper rules tagged `# @orchestrator` or `# @worker` reach only that side; a process knows its side from `PAI_WORKER=1`.

## Status line

Line 4 of the status line, prefixed 🐝, summarises workers: provider head, `▶N` live worker panes on the machine, distinct models with `×N`, `oldest Nm`, and today's `✓ ✗` tally. It uses `~/.claude/worker-status-line.mjs` when present, else `pai worker status-line`. Per-worker detail lives in each pane's bottom row and in `pai worker ps`.

## MCP

`worker_status`, `worker_providers`, `worker_classes`, `worker_run`, `worker_toggle`, `worker_ps`, `worker_replay`, `worker_say`, `worker_resume`, `worker_handoff`, `worker_fallback`, `worker_capability`, `worker_model` call the same library as the CLI. Headless workers start with no MCP servers; opt in per run with `--mcp NAMES` (server names or `mcp_sets` names; `pai worker mcp list`). Allowlisting any `mcp__claude-in-chrome__*` tool adds `--chrome`.
