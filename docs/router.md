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
