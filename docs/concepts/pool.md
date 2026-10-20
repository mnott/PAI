# Worker pool and spares

Starting a worker costs time: a git worktree, a `claude` process and a cold
prompt cache. The pool pays part of that cost in advance. It is off by default.

## What is pre-started

The pool host is a small background process (loopback port `workers.pool.port`,
default 8798) that keeps **spares**: task-less workers whose worktree exists and
whose `claude` is waiting for its first user turn. There are
`workers.pool.spares` spares per (repo, provider) key (default 1; 0 turns spares
off). A spare starts after a worker has run on that repo and provider, so the
host learns which keys are worth warming.

## When a spare is claimed

A new `pai worker run` for the same repo and provider asks the host for a spare.
On a hit the host binds the run's id to the waiting worker: setup is much
shorter than a fresh start (`pai worker pool status` prints both timings), and
the spare does exactly one task. A
claim can miss (no spare yet, spare still starting, spare stale or dead, dirty
checkout, not a git repo); the run then spawns fresh as usual. `pai worker pool
status` counts hits and misses by reason.

An unclaimed spare is retired after `workers.pool.idleKillSec` seconds
(default 1800; 0 = never).

## Why claims are off while a terminal exists

Every worker gets a visible pane that owns its process (see
[panes](panes.md)). A spare was started without one, so with a terminal the pane
rule wins: the run spawns fresh through its pane instead of claiming a spare.
Claims therefore apply to runs with no terminal at all (daemon-started runs,
background sessions). Idle spares themselves get no pane.

## Turning it on and off

```
pai worker pool status    # slots, spares, hits and misses, cache savings
pai worker pool on        # start the host and enable routing
pai worker pool off       # stop both
```

## Keys under `workers.pool`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Pool routing on/off (`pool on|off` sets it). |
| `spares` | `1` | Spares per (repo, provider) key; 0 = off. |
| `idleKillSec` | `1800` | Seconds before an unclaimed spare is retired; 0 = never. |
| `maxSlots` | `3` | Most slot processes the host keeps across all keys. |
| `idleSecs` | `900` | Idle seconds before a slot is killed; 0 = never. |
| `port` | `8798` | Loopback port of the host. |
| `native` | `true` | Native Anthropic runs may use pooled slots; worktree runs never do. |
| `continuation` | `false` | The old multi-task path where one slot serves successive tasks. |

`pai reload` restarts the host onto the code on disk: busy slots finish their
task first; idle spares are retired and recreated.

## Relation to the cache keepalive

They are independent. The pool pre-starts processes. The keepalive
(`workers.cacheKeepaliveSecs`, default 0 = off) has the daemon run a trivial
heartbeat worker so the provider's prompt cache stays warm. See
[cache-keepalive.md](../cache-keepalive.md).
