# The local router

The router is a small HTTP service on `127.0.0.1:8790` between Claude Code (and
workers) and the model providers. It is off by default (`router.enabled: false`);
when enabled, the daemon keeps it running. Set `ANTHROPIC_BASE_URL` to it and
`/model` picks the provider.

## What it does

- **Proxy.** Each request names its provider in the `x-pai-provider` header; the
  router forwards it to that provider's endpoint and translates where the
  protocols differ. Local model servers listen on loopback only and the router
  is the one door to them. `router.bind` (default `loopback`) sets where it
  listens.
- **Usage log.** Every request records tokens and cache use per provider, model
  and session. That is the data behind `pai router stats` and `pai worker usage`
  and the cockpit's accounting.
- **Scheduler** for local engines (below).
- **Parking** of idle local conversations to disk (below).
- **Sampler** for the cockpit's Models cards (below).
- **Cockpit** at `http://127.0.0.1:8790/cockpit`.

```
pai router status
pai router stats --since 2d --by session
pai router restart        # the new router takes the port, the old one drains streams
```

Endpoint and flag reference: [../router.md](../router.md) and
[../commands/router.md](../commands/router.md).

## Lockout guard

A router that cannot resolve or reach its upstream locks every session out of
the cloud, so a replacement is checked before it takes over.

- **Successor preflight.** `pai router restart` starts the new router beside
  the old one. Before it takes the port (and before any startup work) it
  resolves and TLS-connects to `router.claudeUpstream` and to each enabled
  cloud provider (no auth, nothing sent). Only the Anthropic upstream blocks;
  other hosts are reported. A timeout is retried once, and the timeout counts
  connect progress, so a blocked event loop is not reported as network silence.
- **Abort.** On failure the new router exits and the old one keeps serving:
  `router restart aborted: successor cannot reach HOST: CODE; old router PID
  keeps serving; diag ...`. The diag line compares `lookup`, `resolve4`, the
  configured DNS servers and `dscacheutil`; a `trace` line gives the probe's
  start, connect and timer-lateness readings and the loop delay. The ledger
  gets a `ROUTER-PREFLIGHT-FAIL` row (host, code, diag, trace).
- **Daemon watchdog.** If `router.watchdog.failStreak` (5) consecutive cloud
  requests fail with ENOTFOUND, ECONNREFUSED or ETIMEDOUT within 60 s, and the
  daemon itself can reach the upstream, the daemon restarts the router (once
  per five minutes). If the daemon cannot reach it either, it logs "network
  down" and does nothing.
- **Escape hatch.** Claude Code started without `ANTHROPIC_BASE_URL` talks to
  Anthropic directly, bypassing the router. When the router is broken, run a
  plain `claude` in a shell where the variable is unset.

| Surface | What |
|---|---|
| CLI | `pai router restart\|status` |
| Cockpit | router state on the System section |
| MCP | `router_service` (action `restart`) |

## The local scheduler

A local engine serves one request at a time. Further requests wait in the router
instead of interleaving inside the engine. The order is fair across the sessions
that own the workers: each session's counter grows with the tokens its requests
cost the engine, divided by the session's weight, and the session with the
smallest counter goes next. Inside a session the order is first come, first
served, except that a worker whose conversation is still warm goes first.

Keys under `router.scheduling`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Schedule at all. |
| `wTokIn` | `1` | Weight of a fresh prefill token. |
| `wTokOut` | `2` | Weight of a decode token. |
| `agingSec` | `120` | A request waiting this long goes next regardless. |
| `sessionWeights` | `{}` | Per-session weight overrides; unnamed sessions weigh 1. |
| `warmMs` | `300000` | A worker whose last turn ended under this long ago counts as warm (prefix cached). |
| `pingMs` | `15000` | Ping interval of a queued stream. |
| `lowAgingSec` | `900` | A low-priority request waiting longer than this gets one turn although higher ones wait. |

Worker priority and pause: every worker has an engine priority (`high`, `normal`, `low`; set with `pai worker run --priority`, changed live with `pai worker priority <id> <level>`). At a serial engine the next request admitted is the oldest of the highest level waiting (inside a level the session-fair order above); `low` waits for every `high`/`normal` request unless it passed `lowAgingSec`. `pai worker pause <id>` parks the worker's next request in the router (the one in flight finishes; streams keep their ping) until `pai worker resume <id>`. The router reads both from the worker's status file at every admission, so a change applies to the next request. The cockpit Workers section has a selector and a pause button per running worker.

The queue is visible in the cockpit and in `pai worker ps`.

## Conversation slots and parking

A local engine keeps each worker's conversation (its KV cache) in a slot.
`conversationSlots` on a provider in workers.yaml states how many slots the
engine has (default: the provider's `maxConcurrent`); PAI admits workers below
that number, because more conversations than slots evict each other on every
turn.

When a worker waits a long time on a build gate, its slot would sit idle or be
evicted. **Parking** saves that conversation to disk while the worker waits and
restores it before its next request, instead of re-reading the whole prompt.
It is off by default and needs the engine started with
`--slot-save-path <PAI home>/state/strata-slots`; without that flag parking
reports itself unavailable and requests go on normally.

| Key | Default | Meaning |
|---|---|---|
| `router.parking.enabled` | `false` | Park idle conversations. |
| `router.parking.parkAfterSec` | `120` | Park only when the expected build wait is longer than this. |

## The runtime sampler

The cockpit's Models cards show a live reading of each running runtime. The
sampler keeps a ring of samples per runtime. Keys under `router.samples`:

| Key | Default | Meaning |
|---|---|---|
| `sampleMs` | `5000` | Sampling cadence. |
| `historyLen` | `60` | Samples kept (60 x 5 s = 5 minutes). |
| `engineStatusTimeoutMs` | `1000` | An engine's status endpoint must answer within this; a slow engine is not reported. |
| `cardReadingMaxAgeMs` | `2000` | Age at which the served card reading is re-taken. |

Page layout values are under `router.cockpit.layout.*`.

## `pai reload`

After a build, long-running processes keep the old code. `pai reload` restarts
the daemon, then the router (without refusing connections), then the pool host,
and prints old and new pid per process. The router and pool host are only
restarted when they run.

```
pai reload
```

Setting this up for the first time: [first workers](../install/first-workers.md).
