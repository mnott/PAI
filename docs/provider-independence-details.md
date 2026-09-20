# Provider Independence — Details

Everything technical about provider independence: what switches, the tools,
the configuration, the internals. The human-facing page is
[provider-independence.md](provider-independence.md).

## Switch what?

Two levels, one provider registry. Both switch by sentence or by command —
never by editing code:

| Level | What runs on the provider | Switch with |
| --- | --- | --- |
| The crew | delegated workers — research, drafting, implementation, review, spotchecks | `worker_providers` (use): "Use glm for the workers from now on." |
| The orchestrator | the session itself — the interactive chat you are typing into | start it with `glm` (the shim for `pai worker run`), or pick a project with `pai` — the picker follows the active provider |

The main session orchestrates, reviews and merges; workers do the work —
unless the session itself runs on a provider too, in which case everything is
off the Anthropic account.

### The crew — `worker_providers` add / use

- **Add once.** "Add a worker provider named glm, base URL <url>, model
  <model>, here is the key: <token>" → `worker_providers` (add). The key is
  parked in `~/.claude/pai/keys/<name>` (mode 0600); the config records only
  the path. OpenAI-compatible endpoint? Say "upstream URL" — PAI routes it
  through its local translating proxy. The first provider added also turns
  worker routing on and seeds the nine classes (`addProvider`,
  `src/workers/providers.ts:51`); from then a PreToolUse hook denies every
  in-process subagent.
- **Use.** "Switch the fleet to glm." → `worker_providers` (use): sets
  `workers.active` (`useProvider`, `src/workers/providers.ts:170`); classes
  without an explicit target follow.
- **Test.** "Is glm alive?" → `worker_providers` (test): a one-word pong
  probe, latency, OK/FAILED.
- **Off.** "Turn workers off." → `worker_toggle`: subagents run on Anthropic
  again; the registry is kept.

### The orchestrator — the session itself

There is no in-session switch: a session runs on a provider by being
**started that way**. The launcher is `glm` — a shim in `~/.local/bin`
written by `pai worker install` (`src/workers/install.ts:119` body
`exec pai worker run "$@"`; installed names `glm`, `glm-run`, `glm-ps`,
`glm-log`, `worker-say`, `:125`).

`pai worker run` without `-p` starts an **interactive** Claude Code session:
it spawns `claude` with the terminal inherited (`stdio: "inherit"`,
`src/workers/run.ts:452`) — that process *is* the chat pane, not a subagent
of it (`origin: "chat"`, `run.ts:394`). No MCP restriction applies.

The `pai` project picker follows the active provider the same way: its
launch keys start an interactive worker run in the chosen directory
(`w` forces it, `a` forces plain `claude`).

What actually puts it on the provider is the spawn environment
(`buildRunEnv`, `src/workers/run-env.ts`):

| Env var | Value | Where |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | deleted — the Anthropic key never reaches a provider session | `run-env.ts:19` |
| `ANTHROPIC_BASE_URL` | the provider's base URL; the local proxy's URL for OpenAI-protocol providers | `run-env.ts:25,37` |
| `ANTHROPIC_AUTH_TOKEN` | the token read from the provider's key file (proxy runs: placeholder) | `run-env.ts:40` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_MODEL` / `_OPUS_MODEL` | the provider's fast/default models — every model slot maps to the provider | `run-env.ts:41-43` |
| `ENABLE_TOOL_SEARCH` | `true` in interactive runs; headless runs get `PAI_WORKER=1` instead | `run-env.ts:47-49` |

- **Model.** `--model <provider default>` is passed unless you name one
  (`run.ts:438-439`). A `[1m]` suffix on the model id (`glm-5.3[1m]`) selects
  the 1,000,000-token window variant: the suffix is read wherever a window is
  needed (`contextWindowFromModelId()`, `src/utils/model-window.ts:33`) and
  stripped for the family name (`stripModelVariant()`, `:19`).
- **Machine-wide instead of per-session.** `worker_fallback` (on) writes the
  same env into the `env` block of `~/.claude/settings.json`
  (`src/workers/fallback.ts:90-94`; path override `CLAUDE_SETTINGS_PATH` for
  dry runs, `:46`), so every NEW Claude Code process — interactive,
  task-bus, daemon summarizer — runs on the provider. `off` restores the
  saved previous state. Running sessions keep their provider until
  restarted; worker routing is unchanged while on.
- **Bypass.** `ALLOW_ANTHROPIC_AGENTS=1` in the environment re-enables the
  Agent tool for one session.

## Tools (MCP)

Everything here happens in chat: you say the sentence, the session calls the
tool — you never name the tool yourself. These are the **twelve `worker_*`
tools** the pai MCP server registers (`src/daemon-mcp/index.ts:804-1334`);
there is no worker surface outside them. Parameter names are the schema's
own.

### At a glance

| Tool | You say | What it does |
| --- | --- | --- |
| `worker_status` | "How is the worker system doing?" | On/off, active provider, providers, today's run tally, running workers with waiting handoffs |
| `worker_providers` | "Switch the workers to glm." | Manage providers: list / add / update / remove / use / enable / disable / test |
| `worker_fallback` | "Run everything on glm." | Machine-wide: every NEW Claude Code process on a provider — or back on the Anthropic login |
| `worker_classes` | "Make spotchecks cheaper." | Map task classes to providers or routing constraints |
| `worker_model` | "Put glm on the 1M-context model." | Show or set a provider's model ids (default and fast slots) |
| `worker_run` | "Fix the black buttons bug." | Start a worker or chain; returns the id immediately |
| `worker_handoff` | (inside a worker) "Ask the parent whether …" | Send a proposal / question / blocker / result up to the parent |
| `worker_toggle` | "Turn workers off." | Route subagents to workers (on) or back to Anthropic (off) |
| `worker_ps` | "What are my workers doing?" | Running workers plus the last finished |
| `worker_replay` | "What did 3390 do?" | Transcript of one worker |
| `worker_say` | "Tell 3390 to skip the docs." | One message to a running worker, mid-run |
| `worker_resume` | "Have 3390 also update the docs." | Continue a finished worker, context intact |

### Tool details

#### `worker_status` — the state page
No parameters. Workers on/off, active provider, provider list, today's tally
(started / ok / failed, hook denied / allowed / rerouted), running workers
with `◆N` waiting handoffs. Use it before delegating to see what routing
will choose.

#### `worker_providers` — manage providers
`action` (default `list`): **list** · **add** · **update** · **remove** ·
**use** · **enable** · **disable** · **test**. `name` is required for every
action but `list`.

- **add** — needs `name`, `model`, and `key_file` or `key`. `base_url` for an
  Anthropic-protocol endpoint, or `upstream_url` with `protocol=openai`
  (routed through the local proxy). Optional: `engine` (`claude`|`codex`),
  `fast_model`, `context_window` (the meter; unset hides it unless the init
  event announces one), `env`, `note`, `quota_probe`, `cost_tier` (1 cheapest
  … 5), `tags` (`code`, `vision`, `image-gen`, `long-context`, `fast`,
  `reasoning`). The first provider added also turns routing on and seeds the
  classes.
- **update** — `cost_tier` and/or `tags`.
- **use** — make it active; unset classes follow it.
- **enable / disable** — in or out of auto-routing.
- **test** — one-word pong probe: latency, OK/FAILED.
- **remove** — drop it, and any classes pointing at it.

#### `worker_fallback` — the machine-wide switch
`action` (default `status`): **on** · **off** · **status**; `on` takes
`provider` (default: active). See the orchestrator section above for exactly
what it writes and restores.

#### `worker_classes` — map classes to providers
`action` (default `list`): **list** · **set** · **unset**. `set` takes
`class` plus either `target` (`<provider>` or `<provider>/fast`) or routing
constraints — `max_cost_tier` (1–5) and/or `require_tags` — with which
auto-routing picks any qualifying provider. `unset` frees a class back to
the active provider.

#### `worker_model` — model slots
`action` (default `get`): **get** — model ids of one provider (`provider`,
default active) or all when omitted; **set** — needs `model`, `slot` picks
`default` or `fast`. `[1m]` suffix = 1M window, derived from the id.

#### `worker_run` — start work
`prompt` (required — the task, self-contained). Optional: `chain`
(`draft,implement` or `draft,implement,review`), `class` (the nine below),
`label` (shown in `worker_ps` and the statusline — always give one), `cwd`,
`allowed_tools` (comma-separated allowlist), `mcp` (servers/sets the worker
may load). Returns the id at once; the run is a background task — the result
arrives later as a task notification (`result` plus a parsed `report`:
changed paths, ✓/✗ checks, open items). The orchestrator ends its turn
instead of waiting, and reviews the diff itself — workers never merge their
own work.

#### `worker_handoff` — from inside a worker
`kind` (required): `proposal` · `question` · `blocker` · `result`; `text`
(required, one paragraph); optional structured `data`. Lands in the parent's
inbox. Only works inside a worker — no sideways or downward path. Results
are sent automatically when you finish; send one yourself only for mid-run
findings.

#### `worker_toggle` — routing switch
`enabled` (required). `true`: the Agent-tool hook denies in-process
subagents and rewrites them to workers. `false`: they run on Anthropic
again. Registry kept either way.

#### `worker_ps` — the list
Optional `all`: `true` = every session's workers, default this session's.
Running workers show id, provider, age, turns, current tool; the last
finished is included.

#### `worker_replay` — one transcript
`id` (required), optional `tail` (last N rendered lines, 1–2000). Plain
text: tool calls, short outputs, result.

#### `worker_say` — talk to a running worker
`id`, `text` (both required). Lands on the worker's open stdin as a user
message, mid-run, without breaking its stream. Fails with an explanation
when the worker finished — then `worker_resume`.

#### `worker_resume` — continue a finished worker
`id`, `text` (both required). `claude --resume` on the same provider, same
session, context intact; returns the new worker id. Not for running workers.

## Configure

Providers, model roles and class routing live in `~/.claude/pai/workers.yaml`
(the primary, hand-editable mechanism — see **docs/workers-config.md**).
Everything else worker-related still lives in the `workers` section of
`~/.claude/pai/config.json` (`readWorkersSection` / `writeWorkersSection`,
`src/workers/config.ts:619`); every sentence and tool above writes it
atomically — no hand-editing.

**Classes** (`WORKER_CLASSES`, `src/workers/config.ts:131`):

| Class | Work |
| --- | --- |
| `draft` · `plan` | spec writing, planning |
| `implement` · `complex` | code (get their own git worktree on `worker/<id>`) |
| `review` | reads the diff |
| `research` | web research (give it `WebSearch,WebFetch`) |
| `spotcheck` · `simple` | fast verification, small jobs |
| `image` | image generation |

A class maps to `<provider>`, `<provider>/fast`, or to constraints
(`maxCostTier` 1–5, `requireTags`, per-class `order`). Unset classes follow
the active provider; `active: "auto"` routes by `workers.routing.order`
instead.

**Provider fields** (registry entry, `parseProvider`,
`src/workers/config.ts:264`): protocol, base URL (or upstream URL for the
proxy), key file path, model slots (default / fast, `[1m]` suffix for the
1M window), engine, `cost_tier`, `tags`, extra `env`, `context_window`.

**Defaults you inherit** (`src/workers/config.ts:209-226`):

| Area | Default |
| --- | --- |
| Routing | cooldown 30 min after a quota/rate failure, `retryOnQuota` true |
| Sub-worker tree | depth 2, 4 children per parent |
| Follow pane | font 13 pt, auto-exit 60 s |
| Logs | `~/.claude/logs/workers` |

**Environment variables:**

| Var | Effect |
| --- | --- |
| `PAI_WORKER=1` | carried by every headless spawn — marks the worker session, exempts it from orchestrator-only hooks (`src/workers/run-env.ts:47`) |
| `ALLOW_ANTHROPIC_AGENTS=1` | re-enables the Agent tool for one session |
| `ENABLE_TOOL_SEARCH=true` | set in interactive provider runs (`run-env.ts:49`) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | every provider spawn (`run-env.ts:45`) |
| `CLAUDE_SETTINGS_PATH` | dry-run target for `worker_fallback` |

## How it works

One orchestrator, many workers, split made mechanical by four hooks:

| Hook | Enforces | Where |
| --- | --- | --- |
| PreToolUse (`Agent\|Task`) | every in-process subagent denied, unconditionally and in every project, so all delegated work stays visible in `pai worker ps`; the deny reason prints the `pai worker run --provider anthropic …` line to use instead. `ALLOW_ANTHROPIC_AGENTS=1` is the only bypass | `src/hooks/ts/lib/agent-gate.ts` (decision), `src/hooks/ts/pre-tool-use/route-agents-to-worker.ts` (I/O), deployed `${PAI_DIR}/Hooks/route-agents-to-worker.mjs` |
| PreToolUse (Edit/Write) | no code edits by the orchestrator inside a git work tree; `PAI_WORKER=1` sessions are exempt | `${PAI_DIR}/Hooks/route-edits-to-worker.mjs` (deployed config) |
| SessionStart (compact) | saved state replayed and the live worker list injected — a compacted orchestrator still sees every worker | `src/hooks/ts/session-start/post-compact-inject.ts`, `${PAI_DIR}/Hooks/post-compact-workers.mjs` |
| PreToolUse (TaskOutput) | blocking waits denied unless `block: false` — end the turn; the result arrives as a task notification | `${PAI_DIR}/Hooks/block-taskoutput-wait.mjs` |

Every routing decision lands in the routing ledger (`pai worker log`). A
chain `draft,implement[,review]` gives each stage its own worker — own id,
own follow pane, tree in the worker list; a failing stage stops the chain.
Writing classes work in their own git worktree on `worker/<id>`; merging or
discarding is a deliberate operator (or orchestrator) action.

The **statusline** carries the worker row (line 4):

```
glm ▶1  #3390 unlabeled 30s · interactive   ✓74 ✗4 today
```

Segments: provider badge (`glm`; `workers` when mixed) · `▶N` this
terminal's running workers with a live pid · short id · label · age ·
current step · today's finished count. Full legend (`◆N` handoffs, `ctx`
meter, `↳` sub-workers): the *Status line* section of
[worker.md](worker.md).

What else follows the active provider — statusline plan windows,
daemon-side summarizer calls, compaction history, the translating proxy:
[provider-abstraction.md](provider-abstraction.md).

### Code map

| What | Where |
| --- | --- |
| Provider registry, classes (`WORKER_CLASSES`) | `src/workers/config.ts:131` |
| Config read/write, `workers` section | `src/workers/config.ts:619` |
| Provider validation (`parseProvider`) | `src/workers/config.ts:264` |
| First-provider takeover (enabled + active + seeded classes) | `src/workers/providers.ts:51` (`addProvider`) |
| `providers use` (sets `workers.active`) | `src/workers/providers.ts:170` (`useProvider`) |
| `pai worker on/off` (`setWorkersEnabled`) | `src/workers/providers.ts:279` |
| Runner / chain / agent definitions | `src/workers/run.ts`, `src/workers/chain.ts`, `src/workers/agents.ts` |
| Spawn env — base URL, token, model pins | `src/workers/run-env.ts` |
| Machine-wide fallback (settings.json) | `src/workers/fallback.ts` |
| Shims (`glm`, `glm-run`, …) installer | `src/workers/install.ts` |
| Worktrees and merge | `src/workers/worktree.ts` |
| CLI surface (`run`, `ps`, `follow`, `replay`, `merge`, `discard`) | `src/cli/commands/worker/index.ts` |
| Providers / classes CLI | `src/cli/commands/worker/providers.ts:124,334` |
| Model slots CLI (`pai worker model`) | `src/cli/commands/worker/model.ts` |
| Statusline worker row | `src/workers/render.ts`, `statusline-command.sh` (line 4), built `${PAI_DIR}/worker-status-line.mjs` |
| Context window from model id (`[1m]`) | `src/utils/model-window.ts` |
| Agent-tool gate hook (repo) | `src/hooks/ts/pre-tool-use/route-agents-to-worker.ts` |
| Post-compact reinjection (repo) | `src/hooks/ts/session-start/post-compact-inject.ts`, `src/hooks/ts/lib/context-fill.ts` |
| Worker-session exemption | `src/hooks/ts/lib/worker-session.ts` |
| Deployed hooks (config, not repo) | `${PAI_DIR}/Hooks/route-edits-to-worker.mjs`, `block-taskoutput-wait.mjs`, `post-compact-workers.mjs` — registered in `${PAI_DIR}/settings.json` |
| MCP tool surface — all 12 `worker_*` tools | `src/daemon-mcp/index.ts:804-1334` (`worker_model` handler: `src/daemon-mcp/tools/worker-model.ts`) |
| Neighbour docs | [provider-independence.md](provider-independence.md), [provider-abstraction.md](provider-abstraction.md), [worker.md](worker.md), [commands/worker.md](commands/worker.md) |

## CLI fallback

For scripts and terminals outside sessions — the twin of a tool above; flags
live in [commands/worker.md](commands/worker.md). (`worker_status` has no
single twin; `pai worker ps` + `pai worker log` show the same facts.)

| Command | Twin of |
| --- | --- |
| `pai worker run [claude-args…]` | `worker_run` — and the only place a one-call `--provider` override exists |
| `pai worker ps [--all]` | `worker_ps` |
| `pai worker replay <id> [--tail n]` | `worker_replay` |
| `pai worker say <id> <text>` | `worker_say` |
| `pai worker resume <id> <text>` | `worker_resume` |
| `pai worker handoff <json>` | `worker_handoff` |
| `pai worker providers <list\|add\|update\|remove\|use\|enable\|disable\|test>` | `worker_providers` — keys via `--key-file`, never pasted |
| `pai worker classes <list\|set\|unset>` | `worker_classes` |
| `pai worker model [what] [model]` | `worker_model` |
| `pai worker on` / `pai worker off` | `worker_toggle` |
| `pai worker fallback <on [provider]\|off\|status>` | `worker_fallback` |

Terminal-only (no tool equivalent):

| Command | What it does |
| --- | --- |
| `pai worker watch` | `ps` refreshed every 2 seconds |
| `pai worker follow [id]` / `pai worker pane [id]` | live transcript pane for one worker or this session's |
| `pai worker log [all\|tail\|<id>]` | the routing ledger, or one worker's raw event stream |
| `pai worker merge <id>` / `pai worker discard <id>` | land a worker's worktree branch in the original checkout, or drop it entirely |
| `pai worker controls <id> you\|me` | hand the desktop controls (clickr) to a worker, or take them back |
| `pai worker status-line [term] [cwd]` | one-line worker summary for a status bar (called by `statusline-command.sh`) |
| `pai worker proxy [stop]` | the local Anthropic↔OpenAI proxy |
| `pai worker mcp [list]` | MCP servers/sets workers may load |
| `pai worker install` | migration: Agent hook in settings.json, `~/.local/bin` shims (`glm`, …), old script cleanup |
