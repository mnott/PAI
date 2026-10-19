# Session profiles

One store answers "which models does this session use", per named session:
`session-profiles.yaml` in the PAI home (written atomically; the old
`session-workers.json` is migrated into it and removed).

```yaml
job-search:
  chat:     { provider: anthropic, model: opus }
  workers:  { provider: kimi, model: fast }        # model: default | fast | <id>
  fallback: [ { provider: glm, model: fast }, { provider: local } ]
  parallel_min: 2
```

The key is the session's persistent name (AIBroker name / custom title). `pai`
exports it as `PAI_SESSION_NAME` when it starts the session; AIBroker gets it
from `pai project config <name> --json` (effective env and flags).

## Resolution

Every worker spawn (`pai worker run`, MCP handoff, queue and plan tools) asks
one function, `resolveWorkers` (`src/workers/session-profile.ts`):

1. explicit target (`--where`, `--provider`, `--model`)
2. the session profile's `workers`
3. `PAI_SESSION_WORKER_PROVIDER` from a setup launch
4. the global class map / `active`

If the chosen provider is exhausted (a fresh budget reading at or above its
wall, default 95% of any window, or a recorded quota cooldown) the profile's
`fallback` list is walked in order, else the global routing order. In a batch
(queue run, plan run with parallel > 1, `pai worker run --batch`) fallback
targets whose concurrency cap is below `parallel_min` are skipped; when
nothing is left the spawn is refused with the reasons instead of running
serialised. Each resolution carries a one-line reason, for example
`glm fast (fallback: kimi 5h at 100%)`.

## Changing it

- MCP: `session_profile_get`, `session_profile_set` (workers, fallback,
  parallel_min, chat; `apply_now` sends `/model <m>` into the running session).
  Workers changes apply to the next spawn.
- Launch: choosing a setup on the launch screen writes the session's profile
  only, never the global config. The status line shows `workers: <provider/model>`.

## max_parallel

`max_parallel: <n>` limits how many of the session's workers run at once, on any provider (1 = one after the other). A worker waits at the capacity gate (queue `session~<name>`, shown in `pai worker ps` and the cockpit, whose session block reads "max N at a time") while the session already has n running. Set it with `session_profile_set max_parallel 1`, clear it with `max_parallel: null`. It is independent of the provider cap (`maxConcurrent` in workers.yaml, the model's default concurrency): serial comes from a cap of 1 or from this key, never from a provider being local.
