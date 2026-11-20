# The PAI router

A small local HTTP proxy (default `127.0.0.1:8790`) that sits between Claude
Code and the model providers.

- **Provider routing** — each request names its provider in the
  `x-pai-provider` header; the router forwards it to that provider's endpoint
  and translates where the protocol differs.
- **Loopback local providers** — local model servers (llama.cpp, vLLM and the
  like) listen on loopback only; the router is the one door to them.
- **Usage log** — every request records tokens and cache use per provider,
  model and session, the data behind `pai router stats` and
  `pai worker usage`.
- **Limits and cockpit** — provider limits and the cockpit's accounting read
  the same log.

The daemon restarts the router when it is down.

## Commands

```
pai router start                 # start in the background (no-op when running)
pai router stop                  # stop the background router
pai router restart               # new router takes the port, old one drains in-flight streams
pai router status                # running? will the daemon restart it?
pai router run --port 8791       # foreground, until Ctrl-C
pai router stats --since 2d --by session   # token and cache totals
```

`run` also takes `--usage-file PATH` (read the accounting from a file and
record nothing, for second instances) and `--wait-bind SECONDS` (used by
`restart`). `stats --by` is `provider` (default) or `session`; `--since` takes
spans like `30m`, `1h`, `2d`. A port other than the default never touches the
pid file.

Over MCP, `router_service` takes `action` status, start, stop or restart and calls the same functions (`src/router/service-control.ts`).

Concept overview (scheduler, parking, sampler): [concepts/router.md](concepts/router.md).

Full reference: [commands/router.md](commands/router.md).

## Daemon service

```
pai daemon status                # running? uptime, index state
pai daemon start                 # load the service (launchd / systemd user)
pai daemon stop                  # unload it; stays stopped until `start`
pai daemon restart
```

While the daemon is stopped, scheduler passes and router supervision do not run. `pai help` lists these under Services. MCP: `daemon_service` with the same four actions.

## Failover to the local model

When the cloud subscription is exhausted or there is no network, a normal session (`pai NAME`) keeps working on the local model without a restart. The router retries the same request on the running local model (the one `pai worker run --local` resolves, e.g. gyro-l) when a cloud request fails with

- a usage or subscription limit: HTTP 429/402 whose body says "usage limit reached" (or whose `retry-after` is 5 minutes or more). An ordinary short rate limit is not an exhaustion and keeps the normal cloud retry;
- a network failure before any response byte: DNS failure, connection refused or reset, no connection within 10 s.

The model id is mapped to the local model, thinking blocks and the billing header are stripped like for any local provider, and the local answer is streamed back in the same format. The session (`x-pai-session`, else the Claude session id) stays local for `router.failover.stickyMin` minutes (default 30); then a 1-token cloud probe decides when to go back. Workers already on a local provider are unaffected.

If the request is larger than the local window (`workers.localContextTokens`), the client gets an error asking it to `/compact` instead of an oversized prompt reaching the engine.

Each failover writes one ledger line `ROUTER-FAILOVER` (session, reason `usage-limit` or `offline`, `to`), and sends one notice per failover to the session's mailbox and PAILot ("cloud unavailable (<reason>), this session now runs on the local model"). Local requests carry the session id, so the cockpit shows the session as local.

Switch: `pai config set router.failover.enabled false` (default true); `router.failover.stickyMin` sets the sticky minutes.

### Starting without network

`pai NAME` and `pai NAME --local` start offline: `--local` launches set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and the launcher's only network step before exec is the route probe of the local router, limited to 2 s. When the router answers that its cloud upstream is unreachable, the session stays on the router (which fails over) instead of falling back to the first-party URL.

MCP servers that need the network and simply return errors while offline: coogle, todoist, teams, webfetch and browsr (web pages). Local ones (aibroker, pai) keep working.
