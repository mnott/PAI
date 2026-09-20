# Worker prompt-cache keepalive

Why `workers.cacheKeepaliveSecs` exists, what the provider cache actually
does, and the measured numbers behind the default.

## Mechanism

Workers on an anthropic-compat GLM endpoint (`protocol: "anthropic"`) carry no
`cache_control` blocks, yet the endpoint caches implicitly: the final `result`
usage of a real worker run showed `cache_read_input_tokens: 1,129,984` with
`cache_creation_input_tokens: 0` (worker `20260918-120947-11956`, 2026-09-18).

The keepalive arms that implicit cache for future spawns with a trivial
single-turn worker (`src/workers/keepalive.ts`) driven by the daemon on
`workers.cacheKeepaliveSecs` (`src/daemon/daemon/scheduler.ts`,
`startCacheKeepalive`). The beat goes through `runWorker` itself — the
maximal sharing of prefix construction (env, tool grants, contract prompt) —
so a beat and a real worker differ in nothing but the user message. Beats run
in the workers logDir, adopt no session identity, notify nobody, and write one
`WORKER-KEEPALIVE` ledger line each; on a Postgres backend they also store one
observation row via `storeObservationWithProject`.

Measurement constraints (measured, not assumed): per-turn `assistant` events
on this endpoint always carry `usage: {input_tokens: 0, output_tokens: 0}`
with no cache fields; the only real usage is the final `result` event. A
single-turn worker therefore reads its first-turn usage straight off its
result line, and `duration_api_ms` is the TTFT proxy.

## Measured numbers (2026-09-18, probe `scripts/probe-cache-keepalive.ts`)

Every spawn is a fresh claude process and session; prompt identical; class
`simple` on glm-5.3-flash. "gap" = time between the two spawns of a pair.

| pair | gap | spawn | input_tokens | cache_read | cache_creation | duration_api_ms |
|------|-----|-------|--------------|-----------|----------------|-----------------|
| back-to-back | ~16 s | 1 | 17,906 | 0 | 0 | 12,911 |
| back-to-back | ~16 s | 2 | 15,282 | **2,624** | 0 | **7,316** |
| gap 120 s | ~2.2 min | 1 | 17,957 | 0 | 0 | 8,401 |
| gap 120 s | ~2.2 min | 2 | 17,909 | 0 | 0 | 9,812 |
| gap 240 s | ~4.4 min | 1 | 17,909 | 0 | 0 | 10,827 |
| gap 240 s | ~4.4 min | 2 | 17,881 | 0 | 0 | 10,037 |
| gap 360 s | 6 min | 1 | 17,949 | 0 | 0 | 10,132 |
| gap 360 s | 6 min | 2 | 17,951 | 0 | 0 | 9,714 |

## Armed-cadence proof (60 s beats through the real beat code, then a pair)

| run | after | input_tokens | cache_read | duration_api_ms |
|-----|-------|--------------|-----------|-----------------|
| beat 125003 | — | 14,445 | 0 | 5,307 |
| beat 125111 | ~68 s | 14,010 | 0 | 5,480 |
| beat 125220 | ~69 s | 14,010 | 0 | 8,577 |
| probe-1 125232 | ~12 s | 17,989 | 0 | 6,687 |
| probe-2 125242 | ~10 s | 17,736 | **256** | 10,034 |

Ledger lines: `WORKER-KEEPALIVE id=… provider=glm model=glm-5.3-flash
input_tokens=… cache_read_input_tokens=… duration_api_ms=…` land as designed.

## Decision

1. **Cross-session implicit caching exists, but only at seconds range.**
   Spawn 2 of the back-to-back pair is a different process and session than
   spawn 1 and still got `cache_read > 0` — but the only positive readings
   across nine pairs came 10–16 s after the previous identical request
   (2,624 tokens at ~16 s; 256 at ~10 s), and the hit size is unstable. At
   every gap ≥ 60 s — including a 60 s heartbeat cadence proven live through
   the shipped beat code — every spawn was cold.
2. **A keepalive therefore cannot hold this cache at any cadence the
   constraints allow** ("cadence is minutes, not seconds"): holding it would
   need a beat every few seconds, billing ~14–18k fresh input tokens per
   beat around the clock, to serve at best a few hundred to ~2.6k cached
   tokens to the next spawn. The drafted "default = TTL/2" rule assumed a
   TTL in minutes; the measured TTL/2 ≈ 5–30 s, which no sane daemon
   interval meets, and a 60 s default was disproven by the armed proof.
3. **Therefore `DEFAULT_CACHE_KEEPALIVE_SECS = 0`** (a deliberate deviation
   from the drafted spec, per its own STOP-on-negative-evidence rule): the
   instrument ships — knob, beat, daemon wiring, ledger, observations, tests
   — and stays off unless the operator explicitly arms it
   (`"cacheKeepaliveSecs": <secs>` in the workers section). The honest
   reading of the measurement: this endpoint's implicit cache is a
   short-range replay buffer, not a warmable baseline; new-worker cold starts
   cannot be removed by a heartbeat, and the fix would have to live in the
   provider (explicit `cache_control` support) rather than in the daemon.

## Interactive sessions

`sessions.cacheKeepalive` is a *different* problem from the worker keepalive
above: an anthropic Claude Code session's ephemeral prompt cache has a 1-hour
TTL. A cache **read** (the daemon typing a trivial prompt into an idle
session) refreshes that TTL at roughly 0.1x the input-token price of a normal
turn. If the cache is instead allowed to expire, the next real prompt has to
rebuild the whole context from scratch — an input-token rewrite billed at
2x. So each beat that prevents one expiry is worth roughly 20x its own cost
(0.1x spent vs. 2x avoided over the same context size) — the break-even is
around 20 avoided expiries per beat's worth of spend, which is why the
feature caps itself at a handful of beats per idle stretch rather than
beating forever: past `maxBeats`, further beats are pure cost with nothing
left to protect (either the user came back, or the idle stretch has already
run past anything the TTL math pays for).

Unlike the worker keepalive, this cannot run on a fixed timer: an interactive
session's cache is only ever at risk while genuinely idle, and beating a
session the user is actively reading burns tokens and clutters the
transcript for zero benefit. So the daemon tick (`src/daemon/session-keepalive.ts`,
started from `src/daemon/daemon/scheduler.ts` only when enabled) runs every
60 seconds and, per live interactive session, beats it only when *every* one
of these holds:

- idle time (time since the transcript file was last written) is at least
  `idleMinutes`
- the local clock is inside `activeHours`
- the last known context size is at least `minContextTokens` (a session too
  small to have paid for a 1h cache in the first place is not worth beating)
- the session is not mid-turn (its last transcript line is a finished
  assistant turn, not a streaming one or an unanswered prompt)
- fewer than `maxBeats` beats have been sent since the last real (non-beat)
  user prompt

A worker session is not excluded "for free": a `claude -p` worker running in
a worktree writes its own transcript under `~/.claude/projects` (Claude Code
encodes its worktree cwd — under `<workers.logDir>/worktrees` — as the
project-dir name), so an unguarded tick could beat a worker pane. The tick
instead checks each session's transcript path against the workers log dir's
worktrees directory (`isWorkerSession` in `session-keepalive.ts`) and skips
with `skipped:worker` when it matches.

### Config

Off by default. Enable by editing the PAI config file directly (there is no
`pai config set` for this yet — see the config-CLI work landing separately):

```json
{
  "sessions": {
    "cacheKeepalive": {
      "enabled": true,
      "idleMinutes": 50,
      "maxBeats": 6,
      "activeHours": "08:00-22:00",
      "minContextTokens": 20000,
      "prompt": "keepalive"
    }
  }
}
```

- `idleMinutes` — how long a session must sit untouched before it is beaten
  (default 50, just under the 1h TTL).
- `maxBeats` — hard cap on consecutive beats since the last real prompt, so a
  session left open overnight does not accrue an unbounded bill; resets the
  moment a genuine new prompt appears.
- `activeHours` — `"HH:MM-HH:MM"`, local time; a window may wrap midnight
  (e.g. `"22:00-06:00"`). Keeps beats confined to hours where a fresh cache
  is actually likely to be used again soon.
- `minContextTokens` — skip sessions too small to have a cache worth
  protecting.
- `prompt` — the literal text sent as the beat. The `UserPromptSubmit` hook
  (`src/hooks/ts/user-prompt/whisper-rules.ts`, `isCacheKeepaliveBeat`)
  recognizes this exact word and replies with the smallest possible
  instruction ("reply with a single period, no tools"), suppressing every
  other injected rule/advisor block for that one prompt — the point of the
  beat is a cheap round trip, and injecting the usual ~5KB of rules into it
  would erase most of the saving.

### State file

Per-session beat counters live at `~/.claude/pai/session-keepalive.json`
(`PAI_HOME`-relative, rebuildable — a damaged file just resets counters, it
is never a reason to skip beating):

```json
{
  "<session-id>": {
    "beats": 2,
    "lastRealPromptKey": "<uuid-of-last-real-prompt>",
    "lastBeatAt": "2026-09-20T10:00:00.000Z"
  }
}
```

### Ledger

Every tick decision — sent or skipped, with the reason — writes one line to
the same ledger `WORKER-KEEPALIVE` already uses
(`<workers.logDir>/ledger.log`). `session=` is the Claude transcript session
id (resolved from the AIBroker pane id via `claude-session-map.json`, see
below); `pane=` is the raw AIBroker/iTerm pane id, kept alongside it so both
identities are visible:

```
2026-09-20 10:00:00 SESSION-KEEPALIVE session=<id> pane=<pane-id> idle_min=52.3 context=84213 beat=1/6 result=sent
2026-09-20 10:01:00 SESSION-KEEPALIVE session=<id> pane=<pane-id> idle_min=0.2 context=84501 beat=1/6 result=skipped:idle:0.2min
2026-09-20 10:02:00 SESSION-KEEPALIVE pane=<pane-id> result=skipped:unmapped
```

`fetchLiveSessions()` identifies a live session by its AIBroker/iTerm pane id,
not the Claude session id its transcript is named after — the status line
bridges the two on every refresh (`claude-session-map.json` in the workers
log dir, see `resolveClaudeSessionIdFromMap` in `session-keepalive.ts`). A
pane with no (fresh enough) mapped Claude session — too new, or a non-iTerm
terminal the status line never wrote an entry for — is skipped with
`skipped:unmapped` and sent no beat, since it has no transcript to read.

### Checking payoff

`pai daemon keepalive` prints whether the feature is enabled, its current
parameters, every session's beat counter, and the last 10 ledger lines.

`pai audit tokens session` reports, on any session transcript, `idle gaps >
60min: N` (how many times the session actually sat idle long enough to be at
risk) alongside `keepalive beats: N` (how many of that session's prompts were
beats rather than real turns) — the two numbers together show whether the
feature is firing where it is needed and how much it is costing to do so.

### Caveat

A beat is still a real API call and, on a Max-plan subscription, still
counts against the plan's rate-limit window even though its token cost is
small — `maxBeats` and `activeHours` exist as much to bound that call count
as to bound spend. An operator on a tight rate window should keep `maxBeats`
low and `activeHours` narrow rather than assuming "cheap" means "free."
