# Worker Providers

PAI can run every subagent on a provider you configure — any endpoint that
speaks the Anthropic API, any endpoint that speaks the OpenAI Chat
Completions API (through the built-in proxy), or the Codex CLI — instead of
on the Anthropic account of the main session. This replaces the earlier
hard-wired `glm` wrapper with something provider-neutral, and keeps the same
daily commands.

```
main session (Anthropic)          workers (configured provider)
┌──────────────────────┐          ┌──────────────────────────┐
│ orchestration,       │  deny    │ pai worker run …         │
│ review, synthesis    │ ───────▶ │ (claude -p, headless,    │
└──────────────────────┘  Agent   │  strict MCP, streamed,   │
                          tool    │  followed in a pane)     │
                                  └──────────────────────────┘
```

## Config

`~/.config/pai/config.json`, `workers` section:

```json
{
  "workers": {
    "enabled": true,
    "active": "glm",
    "providers": {
      "glm": {
        "baseUrl": "https://api.z.ai/api/anthropic",
        "keyFile": "~/.config/zai/api_key",
        "models": { "default": "glm-5.3", "fast": "glm-5.3-flash" },
        "env": { "API_TIMEOUT_MS": "3000000" },
        "contextWindow": 200000,
        "costTier": 2,
        "tags": ["code", "long-context"]
      },
      "oai": {
        "protocol": "openai",
        "upstreamUrl": "https://api.openai.com/v1",
        "keyFile": "~/.config/pai/keys/oai",
        "models": { "default": "gpt-5.2", "fast": "gpt-5.2-mini" },
        "costTier": 4,
        "tags": ["reasoning", "vision"]
      },
      "codexprov": {
        "engine": "codex",
        "models": { "default": "gpt-5.2-codex" }
      }
    },
    "classes": {
      "implement": "glm",
      "research": { "maxCostTier": 2, "requireTags": ["long-context"] },
      "spotcheck": "glm/fast",
      "docs": { "provider": "glm", "mcp": ["office"] }
    },
    "mcpSets": {
      "office": ["memory", "github"],
      "tiny": ["fetcher"]
    },
    "pane": { "enabled": true, "fontSize": 13, "autoExitSecs": 60 },
    "logDir": "~/.claude/logs/workers",
    "routing": { "order": [], "cooldownMinutes": 30, "retryOnQuota": true }
  }
}
```

- `keyFile` holds the API token (chmod 600). Keys never go into the config.
- `active` is one provider name, or `"auto"` to walk `routing.order`.
- `protocol: "openai"` routes the provider through the built-in proxy (next
  section); it needs `upstreamUrl`, the Chat Completions base.
- `engine: "codex"` runs the provider on the Codex CLI instead of Claude
  Code (see below).
- `contextWindow` overrides the context-meter window when the endpoint's
  init event does not announce one (default 200 000).
- `costTier` (1 cheapest … 5 most expensive, default 3) and `tags` (from:
  `code`, `vision`, `image-gen`, `long-context`, `fast`, `reasoning`) describe
  a provider; classes use them to constrain routing (next section).
- A class target is `"provider[/model]"` or an object with `provider` and a
  `mcp` allowlist applied on top of `--mcp`, or an object with only routing
  constraints (`maxCostTier`, `requireTags`, `order`).

Or add one from the CLI:

```
pai worker providers add glm \
  --base-url https://api.z.ai/api/anthropic \
  --key-file ~/.config/zai/api_key \
  --model glm-5.3 --fast-model glm-5.3-flash \
  --env API_TIMEOUT_MS=3000000 \
  --cost-tier 2 --tags code,long-context
pai worker providers add oai \
  --upstream-url https://api.openai.com/v1 \
  --key-file ~/.config/pai/keys/oai --model gpt-5.2
pai worker providers update glm --cost-tier 1   # tiers/tags change later
```

The first provider also sets `enabled: true`, makes itself active and seeds
the nine classes. Then:

```
pai worker install     # Agent hook in settings.json + glm* shims + cleanup
```

## Task classes

Roles were renamed to **classes** — task classes pick the provider for a kind
of work. The nine standard classes: `draft`, `plan`, `implement`, `review`,
`research`, `spotcheck`, `simple`, `complex`, `image` (any other name can be
defined too). Configs with the old `roles` key keep parsing; the key migrates
to `classes` on the first write.

```
pai worker classes                          # list
pai worker classes set implement glm        # pin a provider
pai worker classes set spotcheck glm/fast   # …its fast model
pai worker classes set research --max-cost-tier 2 --require-tags long-context
pai worker classes unset research
```

Every provider carries a **cost tier** (1 cheapest … 5 most expensive,
default 3) and **tags** (`code`, `vision`, `image-gen`, `long-context`,
`fast`, `reasoning`). A class resolves its provider as:

1. `--provider` (explicit flag) wins;
2. else the class mapping when it pins a provider;
3. else auto-routing (see below) restricted to providers within the class's
   `maxCostTier` and carrying all its `requireTags`;
4. nothing qualifies → the run fails with a message listing why every
   provider was excluded.

`classes.<name>.order` overrides `routing.order` for that class. Cooldown and
quota logic is unchanged.

### Preferences from chat

The Worker skill maps phrases onto the MCP tools — the answer is one or two
lines, and the user is never told to edit a file:

- "use X for image generation" / "route research to kimi" →
  `worker_classes set <class>=<provider>`
- "prefer the flash model for simple tasks" / "cheap only for drafts" →
  `worker_classes set simple|draft=<provider>/fast` (or `max_cost_tier`)
- "reviews should use a reasoning model" → `worker_classes set review` with
  `require_tags: ["reasoning"]`
- "what handles reviews" / "show the routing table" → `worker_classes list`

## The proxy (OpenAI-protocol providers)

A provider with `protocol: "openai"` cannot be talked to by Claude Code
directly, so PAI ships a translating proxy: Anthropic Messages API on the
front (loopback only), OpenAI Chat Completions on the back. System prompts,
multi-turn text, tool_use/tool_result ↔ tool_calls, tools ↔ functions,
streaming SSE (including streamed tool-call arguments), usage and error
mapping (429 → `rate_limit_error`, 401 → `authentication_error`, 5xx →
`api_error`) are translated in both directions.

- One proxy serves every openai provider: the provider name in the URL path
  selects the upstream. `run` points `ANTHROPIC_BASE_URL` at
  `http://127.0.0.1:8797/<provider>` and starts the proxy on demand
  (detached, pid file under the logDir). The worker config is re-read per
  request, so provider edits apply without a restart.
- The proxy holds the real token (from the provider's `keyFile`) and injects
  it upstream; the worker itself runs with a placeholder, so a leaked worker
  env leaks nothing.
- `pai worker proxy [--port N]` starts it by hand (default 8797, loopback
  only), `pai worker proxy stop` stops it again. `providers test` on an
  openai provider goes through the proxy too.

## The codex engine

A ChatGPT plan gives no API key, only Codex CLI access — such a provider
sets `engine: "codex"` and `run` shells out to `codex exec --json <prompt>`
(non-interactive) instead of Claude Code. The Codex JSONL events are folded
into the same status fields and the same transcript shape, so `ps`, `follow`,
`replay`, the ledger and the final `--output-format` print work unchanged.

Differences: `--allowedTools` and MCP flags have no Codex equivalent and are
dropped with a `WORKER-NOTE` ledger line; resume continues a Claude session,
so it is unavailable for codex workers (their thread id is kept, but
`pai worker resume` refuses with an explanation). `providers test` reports
`codex not installed` (exit 0) when the CLI is missing.

## Daily use

```
pai worker run --label "fix black buttons" -p '<task spec>' \
  --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' --output-format json \
  --mcp office
pai worker run --chain draft,implement -p '<brief>'   # spec-first (below)
pai worker run --agent engineer -p '<task>'           # agent library (below)
pai worker ps                    # this session's workers
pai worker follow [id]           # live transcript (type to talk to it)
pai worker replay <id>           # transcript of one worker
pai worker say <id> "<text>"     # message a running worker
pai worker resume <id> "<text>"  # continue a finished one, context intact
pai worker mcp list              # MCP servers + sets usable in --mcp
pai worker proxy [--port N|stop] # the translating proxy, by hand
pai worker log [all|tail|<id>]   # raw streams + routing ledger
```

Classes pick the provider for a task class: `--class implement|research|spotcheck|…`
(`--role` still works as its alias). `--no-pane` suppresses the iTerm follow
pane; `--provider <name>` bypasses classes entirely. If you bring your own
`--append-system-prompt`, the worker contract below is added alongside it, not
instead.

## Chains (draft → implement → review)

```
pai worker run --chain draft,implement -p '<brief>'
pai worker run --chain draft,implement,review -p '<brief>'   # + review pass
```

- The **draft** class turns the brief into a full spec file under
  `<logDir>/specs/<chain id>.md` — goal, constraints, files likely touched,
  acceptance checks, verification commands. It reads the repository first and
  implements nothing.
- **implement** (or any other stage class) runs with that spec as its prompt
  and the original brief attached.
- **review** reads the spec and the working-tree diff and produces the
  structured report.
- Each stage is its own worker: own id, own pane, `parent` set to the chain
  id — `ps` shows the chain as a tree.
- A stage that fails stops the chain (the exit code is the first failing
  stage's); a draft that produces no spec stops it with a message telling the
  caller to write the spec and re-run without the draft stage.
- `--class` alongside `--chain` overrides the class of every stage; `--label`
  names the chain (stages render as `<label> · <stage>`).

## Agent definitions as workers

`pai worker run --agent <name>` loads `~/.claude/agents/<name>.md` and runs it
on a worker: the front matter's `model` maps to a class (haiku→simple,
sonnet→implement, opus→complex — `--class` overrides), `tools` becomes
`--allowedTools`, and the body is passed via `--append-system-prompt` (your
own flags on the command line still win). The label defaults to
`<agent>: <first 50 chars of prompt>`.

The agent library therefore runs on workers, not on the orchestrator's
Anthropic account — same hooks, same classes, same `ps`/`follow`/`replay`.

The old habits keep working: `glm`, `glm-run`, `glm-ps`, `glm-log` are shims
to the pai commands (`pai worker install` moves any previous versions to
`<name>.pre-pai`).

## Routing

A run resolves its provider as: `--provider` > `--class` > `active`.

With `active: "auto"`, providers are tried in `routing.order` (or the class's
own `order`), skipping:

- disabled providers,
- providers in a cooldown (set for `cooldownMinutes` after a quota failure),
- providers whose `quotaProbe` URL reports ≥ `quotaSkipAt` (default 95),
- providers above the class's `maxCostTier` or missing one of its
  `requireTags`.

Nothing qualifying fails the run with the exclusion reason of every provider
in the order.

A quota failure before the first tool call is re-run on the next provider and
logged as `WORKER-REROUTE`. `pai worker providers enable <name>` clears a
cooldown by hand.

## When the Anthropic plan runs out

`pai worker fallback on [provider]` switches the whole machine: every NEW
Claude Code process — interactive sessions, task-bus sessions, the daemon's
headless summarizer — runs on that worker provider instead of the Anthropic
login, until `pai worker fallback off`. Use it when the plan budget is gone
but work must continue.

What `on` does:

- Writes the provider into the `env` block of `~/.claude/settings.json`:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the three
  `ANTHROPIC_DEFAULT_*_MODEL` pins (fast model as haiku, default as sonnet
  and opus), the provider's own env (`API_TIMEOUT_MS` …), plus
  `ENABLE_TOOL_SEARCH=true` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Pins the top-level `model` key to the provider's default model.
- Saves the replaced values under `workers.fallback.saved` in
  `~/.config/pai/config.json` and writes a `FALLBACK-ACTIVE.md` note into the
  workers log dir telling running sessions what to do.

Notes:

- **The token sits in settings.json.** `on` reads it from the provider's key
  file at switch time; `off` removes it again. That is the price of switching
  every process without touching each one's environment.
- `off` restores settings.json exactly — only the keys `on` touched change.
  Both files are written atomically; `CLAUDE_SETTINGS_PATH` points `on`/`off`
  at a copy for dry runs.
- **Running sessions are not switched.** A Claude Code process keeps the
  provider it started with until restarted. `pai worker fallback status`
  lists running sessions (AIBroker registry when populated, else `ps`) and
  the note path; its one-line instruction for each of them: restart the
  session in its project directory, keep the same AIBroker name.
- The Agent hook is unchanged: subagents keep routing to `pai worker run`
  workers, which set their own per-provider env.
- `on` is idempotent (re-applying heals an interrupted switch), and switching
  providers while on restores the first switch's savings before saving fresh.
- MCP: `worker_fallback` (action `on`/`off`/`status`, optional `provider`);
  chat phrases "switch everything to glm", "fallback on", "back to
  anthropic", "fallback off", "is fallback on" are mapped in the Worker
  skill.

## What a worker is

- One `claude -p … --output-format stream-json --verbose` process per call,
  run with `--input-format stream-json` and its stdin held open: the task
  arrives as the first user message on stdin, and further lines (see `say`
  below) continue the conversation while it runs.
- Env: `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from the provider (token
  read from `keyFile`, never from the environment; openai providers point at
  the local proxy instead), `ANTHROPIC_API_KEY` stripped so nothing can fall
  back to Anthropic billing, the three `ANTHROPIC_DEFAULT_*_MODEL` vars, the
  provider's `env`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Headless runs get `--strict-mcp-config --mcp-config <config>` and
  `PAI_WORKER=1` so PAI's per-session hooks leave them alone. Interactive
  runs keep full MCP and get `ENABLE_TOOL_SEARCH=true`.
- Every mirrored event carries an ISO `_ts` stamp; the stream lands in
  `<logDir>/<id>.jsonl`, live state in `<id>.status`, every event in
  `<logDir>/ledger.log`.

### The worker contract

Headless runs append a system prompt that fixes the shape of the final
answer: act, verify, then stop with ONE JSON message

```json
{"changed":[{"path":"…","summary":"…"}],"commands":["…"],
 "checks":[{"name":"…","ok":true,"detail":"…"}],"open":["…"],"notes":"one line"}
```

The runner parses it: `notes` becomes the one-line `last` the table shows,
and `--output-format json` carries the parsed `report` next to the raw
`result`. `follow`/`replay` render it as a compact block (changed paths,
✓/✗ checks, open items). A final message that is not the contract stays raw
text — nothing is lost either way.

### Talking to a worker (say / resume)

While a headless worker runs, `pai worker say <id> "<text>"` (or the MCP
tool `worker_say`) forwards the text to the child as a user message over the
per-worker Unix socket `<logDir>/<id>.sock`; it is mirrored into the
transcript as an `operator` event (`»` marker). After the worker's result,
stdin closes two seconds later unless another message arrives — after that
`say` refuses and points at `resume`.

`pai worker resume <id> "<text>"` continues the same Claude session (the id
recorded from the init event) on the same provider, labelled `↩ <original>`,
and prints a fresh worker id with `--print-id`.

A `follow <id>` pane on a TTY is a chat, not a tail: the transcript lives in
a scroll region that ends two rows above the pane's bottom, the last two rows
are fixed — the prompt row (`› `, full readline editing: arrows, backspace,
Ctrl-A/E, Ctrl-U) and the ticker row — and every transcript line is inserted
above them with a save-cursor / restore-cursor write, so the cursor never
leaves the prompt. Enter sends the line: said to the worker while it runs,
`resume`d into the same session once it has finished (the pane follows the
fresh run id and keeps the chat). The sent line is echoed into the transcript
as a `»` row with its time gutter, exactly once — the mirrored `operator`
event is swallowed. `/help` lists the commands:

| key | action |
| --- | --- |
| `/quit` | close the pane |
| `/resume <text>` | resume the finished worker with `<text>` |
| `/status` | one-line worker status |
| anything else | a message — said, or resumed |

Ctrl-C on an empty prompt leaves the pane, on a draft it clears the prompt;
Ctrl-D leaves. The auto-exit countdown never fires while the prompt holds
unsent text. Without a TTY (piped output) the pane keeps the plain scrolling
behaviour — no prompt row, no ticker, stdin still the operator channel.

### Sub-workers and handoffs

Any worker may start its own workers: the runner exports `PAI_WORKER_ID` in
every worker's environment, and a `pai worker run` launched from inside one
records `parent` in its status — so the forest is visible in `ps` (children
indented under their parent, `├`/`└` connectors), the status line (`↳` under
the parent) and each child gets its own follow pane. Handoffs travel **up
only**, from a child to its parent:

```
pai worker handoff '{"kind":"proposal","text":"run this on a cheap provider","data":{…}}'
```

(or the MCP tool `worker_handoff`; kinds `proposal`, `question`, `blocker` —
`result` is sent automatically when a child finishes). The handoff is appended
to `<logDir>/<parent>.inbox.jsonl` (durable, ordered) and, when the parent is
running, also delivered as an operator message `[handoff from <child id>]`. The
parent sees it in its pane (`◆ from <id> · kind: text`, magenta), `ps` and the
status line show `◆N` for an inbox with N handoffs, and `replay`/`follow`
merge them into the transcript by timestamp. There is no sideways channel:
siblings never see each other, everything goes up.

Two caps keep the tree bounded (`workers.tree`):

- `maxDepth` (default 2) — how deep sub-workers may nest; a launch one level
  past the cap fails with a message that suggests a handoff instead,
- `maxChildren` (default 4) — how many children of one parent may run at the
  same time (finished children do not count).

Chain stages and planner sub-tasks carry a parent too, but a parent without a
status file (a chain id) is not a worker and is never capped by depth.

### Worktrees and merge

A run whose class writes files (`implement`, `complex`, `plan`) in a git repo,
with a prompt that is not read-only, gets **its own git worktree** by default:
`<logDir>/worktrees/<id>` on branch `worker/<id>` from the current HEAD. The
worker commits its work on that branch (the no-commit rule applies to the main
branch only — the appended system prompt says so); when git refuses (no
commits yet, detached setup) the run degrades to in place with a note on
stderr and in the ledger.

```
pai worker merge <id>     # git merge --no-ff worker/<id> + remove the worktree
pai worker discard <id>   # remove worktree and branch, keep nothing
```

`ps` marks a worker with an unmerged branch `⎇<commits>` (yellow); the status
file records `branch`, `commits` and `worktreeDir`. Chains give a worktree to
the implement stage only; `--worktree` forces one on, `--no-worktree` opts
out.

### The planner class

`--class plan` runs a small orchestration, not one worker:

1. a planner worker reads the repository and writes
   `<logDir>/plans/<planner id>.json` — sub-tasks (`title`, `brief`, `class`,
   `files`, `acceptance`), 5–50 of them, fewer only when the goal names a
   smaller count;
2. the runner validates the plan and spawns the sub-tasks as children of the
   planner, at most `workers.tree.maxChildren` at a time;
3. each child's structured report arrives in the planner's inbox as a
   `kind: "result"` handoff;
4. the run finishes with a summary report (`n/m sub-tasks ok`) and the
   `pai worker merge` lines for any unmerged branches.

The planner's prompt carries the prompt rules that make plans executable:
domain-specific instructions only (real files, real commands), constraints
over step lists, explicit quantity ranges, no checkbox style.

### Clickr controls (desktop set)

The default `mcpSets` ship one set: `desktop = ["clickr"]`. A worker launched
`--mcp desktop` receives the clickr MCP server — screen control for GUI work
— and follows the same control handover as a session:

```
pai worker controls <id> you    # hand control of the desktop to the worker
pai worker controls <id> me     # take it back
```

`controls` runs the `clickr controls you|me` CLI and the worker's screenshot
and input tools honour it. Control starts with the operator: a worker cannot
drive the desktop until it is handed over.

### Context meter

Status files carry `contextTokens` (input + cache read + cache creation +
output of the last assistant turn) and `contextWindow` (from the init event,
else the provider's `contextWindow`, else 200 000). The `ps` table and the
status line show `ctx 84k/200k (42%)` once it passes 60 % — yellow past
70 %, red past 85 % — and the pane's liveness line always shows it.

### MCP for workers

Headless workers start with **no MCP servers by default**: every server
definition lands in the system prompt and costs context (and often a
startup process) before the worker has done anything. When a task genuinely
needs servers, opt in per run:

```
pai worker run --mcp office …      # a set, or names: --mcp memory,github
```

`--mcp` takes server names and/or `mcpSets` names (comma-separated,
repeatable); the filtered config is written from `~/.claude.json`'s
`mcpServers` to `<logDir>/<id>.mcp.json` and passed with
`--strict-mcp-config --mcp-config`. Class targets may add `"mcp": ["office"]`
on top. An unknown name fails fast, listing what exists;
`pai worker mcp list` shows servers and sets. A caller-provided
`--mcp-config` always wins; MCP is chosen at launch, not mid-run.

## Scoping (who sees whose workers)

`ps`/`follow`/status line show the workers of the asking terminal:

1. AIBroker session id (from `~/.aibroker/session-names.json`) — every pane of
   a named session sees its workers,
2. else the iTerm tab key (`w<n>t<n>` of `ITERM_SESSION_ID`).

`--all` (or no iTerm at all) widens to every worker.

## Follow, replay and the pane

`follow` renders the live transcript with a `HH:MM:SS │ ` gutter (dim; the
worker's short id in front when several run at once, a `── date ──`
separator when the day changes) and, on a TTY, a liveness line
`⋯ 12s since last event · Bash: npm test` that is overwritten in place and
erased before the next event. `replay` shows a finished transcript with the
same gutter.

The pane wraps rows itself at the terminal width (re-read on resize, so a
narrower pane re-wraps what arrives after the resize): breaks on whitespace
where it can, hard-wraps a long token otherwise, never splits an ANSI escape
(it measures printable columns, not string length), and carries diff colours
onto every continuation row. Each continuation row carries a blank-time
gutter with the `│` bar kept — the bar runs unbroken down the pane and no
content ever lands left of it. In the chat layout the transcript scrolls
inside an ANSI scroll region (`ESC[1;rows-2r`, reset on exit and re-set on
resize) so the prompt and ticker rows stay fixed; piped output keeps the
terminal's own wrapping instead.

The pane command is `exec pai worker follow …` so the pane holds exactly one
process — signals reach the follow directly, and when the worker finishes
the pane counts down its `auto-exit` (default 60 s, `pane.autoExitSecs`).

Panes run under the `pai-worker` dynamic profile, written to
`~/Library/Application Support/iTerm2/DynamicProfiles/pai-worker.json`:
the font family of iTerm's default profile at `pane.fontSize` points
(default 13; a legacy `pane.fontScale` is ignored), inheriting everything
else from that profile. When iTerm's preferences cannot be read the profile
is still written, with `Menlo-Regular <fontSize>` and no parent, and the
reason lands on stderr. `pai worker pane <id> --check` prints the profile
file's path, whether it exists, and the font it contains or would write.

## The Agent-tool hook

With workers on, a PreToolUse hook denies every `Agent` call and the deny
reason tells the orchestrator to delegate via `pai worker run` in the
background instead. Decisions are ledgered (`DENIED-ANTHROPIC-AGENT`,
`ALLOWED-ANTHROPIC-AGENT`).

- `pai worker off` — Agent subagents run on Anthropic again.
- `ALLOW_ANTHROPIC_AGENTS=1` — bypass for one session.

## MCP tools

`worker_status`, `worker_providers`
(list/add/update/remove/use/enable/disable/test — `update` changes
`cost_tier`/`tags`), `worker_classes` (list/set/unset), `worker_run` (start a
worker or chain from chat, returns the id immediately), `worker_toggle`,
`worker_ps`, `worker_replay`, `worker_say` (message a running worker),
`worker_resume` (continue a finished one), `worker_handoff` (from inside a
worker: send a proposal/question/blocker up to its parent) — the same library
the CLI calls.
`worker_providers add` accepts a raw `key`, parks it in
`~/.config/pai/keys/<name>` (mode 0600) and stores only the path.

## Status line

Line 4 of the statusline lists this session's running workers (provider,
label, age, current tool, context meter past 60 %) plus today's ✓/✗ tally.
It prefers the standalone `~/.claude/worker-status-line.mjs` (plain node,
built by `bun run build`) and falls back to `pai worker status-line`.

The first segment is the chat pane itself (the interactive `pai worker run`
that owns the terminal, status `origin: "chat"`): its provider, `▶N` counting
only its running spawned workers (nothing at zero), its own age when none
run, and `· <last activity>` — never its id or label, it is not a worker.

Example: `glm ▶2 · interactive | #4969 fix black buttons 6m · Edit: button.ts | #2924 spotcheck login 1m · Bash: npm test   ✓75 ✗4 today`

Segment by segment:

- provider tag (`glm`) — the chat pane's provider; `workers` when there is no tracked chat pane and the running workers are mixed
- `▶2` — this terminal's running SPAWNED workers: `state=running` **and** a live pid **and** not the chat-pane tracker; omitted entirely at zero (the pane's own age takes the slot)
- `· interactive` — the chat pane's last activity (`interactive` until it ends)
- `#4969` — short worker id (last 4 chars, same short form `pai worker ps` shows), on spawned workers only
- label (`fix black buttons`) — `--label`, else the first 70 chars of the prompt; `unlabeled` when the run had neither
- age (`6m`) — time since the worker started
- last activity (`Edit: button.ts`) — most recent event line (current tool, or what the worker last said)
- `◆N` — unread handoffs waiting in that worker's inbox
- `ctx 150k/200k (75%)` — worker context load, joined once it passes 60 %
- `↳ ` — a sub-worker, indented under its parent
- `✓75 ✗4 today` — today's finished workers: done vs failed
