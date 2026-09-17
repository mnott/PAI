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
        "contextWindow": 200000
      },
      "oai": {
        "protocol": "openai",
        "upstreamUrl": "https://api.openai.com/v1",
        "keyFile": "~/.config/pai/keys/oai",
        "models": { "default": "gpt-5.2", "fast": "gpt-5.2-mini" }
      },
      "codexprov": {
        "engine": "codex",
        "models": { "default": "gpt-5.2-codex" }
      }
    },
    "roles": {
      "implement": "glm",
      "research": "glm",
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
- A role target is `"provider[/model]"` or an object with `provider` and a
  `mcp` allowlist applied on top of `--mcp`.

Or add one from the CLI:

```
pai worker providers add glm \
  --base-url https://api.z.ai/api/anthropic \
  --key-file ~/.config/zai/api_key \
  --model glm-5.3 --fast-model glm-5.3-flash \
  --env API_TIMEOUT_MS=3000000
pai worker providers add oai \
  --upstream-url https://api.openai.com/v1 \
  --key-file ~/.config/pai/keys/oai --model gpt-5.2
```

The first provider also sets `enabled: true`, makes itself active and seeds
the three roles. Then:

```
pai worker install     # Agent hook in settings.json + glm* shims + cleanup
```

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
pai worker ps                    # this session's workers
pai worker follow [id]           # live transcript (type to talk to it)
pai worker replay <id>           # transcript of one worker
pai worker say <id> "<text>"     # message a running worker
pai worker resume <id> "<text>"  # continue a finished one, context intact
pai worker mcp list              # MCP servers + sets usable in --mcp
pai worker proxy [--port N|stop] # the translating proxy, by hand
pai worker log [all|tail|<id>]   # raw streams + routing ledger
```

Roles pick the provider for a task class: `--role implement|research|spotcheck`.
`--no-pane` suppresses the iTerm follow pane; `--provider <name>` bypasses
roles entirely. If you bring your own `--append-system-prompt`, the worker
contract below is added alongside it, not instead.

The old habits keep working: `glm`, `glm-run`, `glm-ps`, `glm-log` are shims
to the pai commands (`pai worker install` moves any previous versions to
`<name>.pre-pai`).

## Routing

A run resolves its provider as: `--provider` > `--role` > `active`.

With `active: "auto"`, providers are tried in `routing.order`, skipping:

- disabled providers,
- providers in a cooldown (set for `cooldownMinutes` after a quota failure),
- providers whose `quotaProbe` URL reports ≥ `quotaSkipAt` (default 95).

A quota failure before the first tool call is re-run on the next provider and
logged as `WORKER-REROUTE`. `pai worker providers enable <name>` clears a
cooldown by hand.

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
and prints a fresh worker id with `--print-id`. A pane running `follow` reads
its own stdin the same way: type to say while it runs, or to resume after it
finished.

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
`--strict-mcp-config --mcp-config`. Role targets may add `"mcp": ["office"]`
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

`worker_status`, `worker_providers` (list/add/remove/use/enable/disable/test),
`worker_roles`, `worker_toggle`, `worker_ps`, `worker_replay`,
`worker_say` (message a running worker), `worker_resume` (continue a
finished one) — the same library the CLI calls. `worker_providers add`
accepts a raw `key`, parks it in `~/.config/pai/keys/<name>` (mode 0600) and
stores only the path.

## Status line

Line 4 of the statusline lists this session's running workers (provider,
label, age, current tool, context meter past 60 %) plus today's ✓/✗ tally.
It prefers the standalone `~/.claude/worker-status-line.mjs` (plain node,
built by `bun run build`) and falls back to `pai worker status-line`.
