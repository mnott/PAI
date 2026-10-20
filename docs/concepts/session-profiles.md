# Session profiles

A session profile answers "which models does this named session use". It is
per session, so one session can use a local worker while another uses Sonnet.
The store is `session-profiles.yaml` in the PAI home. The key is the session's
persistent name, exported as `PAI_SESSION_NAME` when `pai` starts it.

```yaml
job-search:
  chat:     { provider: anthropic, model: opus }
  workers:  { provider: kimi, model: fast }        # model: default | fast | <id>
  fallback: [ { provider: glm, model: fast }, { provider: local } ]
  parallel_min: 2
  max_parallel: 1
```

## Tier overrides for one session

```
pai worker route --session self                       # effective table for this session
pai worker route set --session self t2 gyro-m         # use a local worker for implementers here
pai worker route set --session self t2 anthropic/sonnet   # sonnet for implementers here
pai worker route set --session self implement anthropic/sonnet   # a class sets its tier
pai worker route clear --session self t2              # back to the global row
```

`--session` takes a session name or `self`. Runs started from that session use
its row; any other row is the global one. The override applies to the next
worker run. The cockpit Routing section lists sessions that override a tier.

## Resolution of a worker spawn

1. explicit target (`--where`, `--provider`, `--model`)
2. the profile's `workers`
3. `PAI_SESSION_WORKER_PROVIDER` from a setup launch
4. the global tier table / class map / `active`

If the chosen provider is exhausted (budget at its wall or a quota cooldown),
the profile's `fallback` list is walked in order, else the global routing order.
In a batch (queue run, plan run with parallel above 1, `pai worker run
--batch`), fallback targets whose concurrency cap is below `parallel_min` are
skipped; if none remain the spawn is refused with the reasons.

## max_parallel

`max_parallel: <n>` limits how many of the session's workers run at once, on any
provider (1 = one after the other). Extra workers wait at the capacity gate,
shown in `pai worker ps` and the cockpit. It is independent of the provider cap
(`pai worker providers cap`). Clear it with `max_parallel: null`.

## Changing a profile

- MCP: `session_profile_get` and `session_profile_set` (fields `chat`,
  `workers`, `fallback`, `parallel_min`, `max_parallel`, `routes`; `apply_now`
  sends `/model` into the running session).
- Launch: choosing a setup on the launch screen writes that session's profile
  only, never the global config.
