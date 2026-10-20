# Shipped defaults

Policy values (thresholds, limits, intervals, lists, labels, mappings) live in configuration files, not in code. PAI ships a default for each; you override only what you want to change.

## Where they live

- `src/config/defaults/config.yaml` and `src/config/defaults/workers.yaml` in the package, copied to `dist/config/defaults/` by the build. Open them to read every default with its comment.
- `PAI_DEFAULTS_DIR` names another defaults directory (for tests that run outside `dist`).
- Values computed at load time (`socketPath`, the per-user `postgres.connectionString`) stay in code and count as defaults too.

## How to override

Defaults load first and are deep-merged **under** your files: your `config.yaml` (main settings) and `workers.yaml` (providers, tiers, local tiers). Objects merge, arrays replace, your values win; a missing file yields the defaults alone. Do not edit the shipped files.

```
pai config get router.parking --source      # value, and "user config" or "shipped defaults"
pai config set router.parking.enabled true  # writes your config.yaml
pai config unset router.parking.enabled     # your value goes, the shipped one applies again
pai config list --all                       # every setting with defaults merged in
```

More on the commands: [config.md](config.md). Worker keys: [workers-config.md](workers-config.md), [worker.md](worker.md).

## Key map by area

| Area | Keys (in `config.yaml` unless noted) | What they set |
|---|---|---|
| Daemon passes | `indexIntervalSecs` 300, `embedIntervalSecs` 600, `embedMaxMinutes` 60, `embedMaxLoad` 8, `passPriority` | How often and how hard the daemon indexes and embeds. |
| Storage and embeddings | `storageBackend`, `postgres.*`, `embedding.*` | Backend and embedding source. |
| Search | `search.*` | Mode, rerank, recency boost, limits. |
| Notices to your phone | `notices.pailot.*`, `notices.runReports.*`, `notices.trouble.*` | What may reach PAILot: rate limit (default 5 per minute), de-duplication window (24 h), run-report throttles, worker-trouble thresholds. |
| Panes | `panes.*` | Minimum pane size, pane verification tries, grace and linger times, how long pane run records are kept. |
| Router | `router.enabled` (default off), `router.bind` | The local-model router ([router](concepts/router.md)). |
| Router scheduling | `router.scheduling.*` | One request per engine, fair across sessions: token weights, aging, session weights, warm and ping times. |
| Router parking | `router.parking.enabled` (off), `parkAfterSec` 120 | Park an idle local conversation to disk. |
| Router sampling | `router.samples.*` | Sample interval and history length for the cockpit's model cards. |
| Cockpit layout | `router.cockpit.layout.*` | Grid breakpoints, chart sizes, row limits, polling intervals, drag-and-drop defaults (`rows`, `maxPerRow`). The arrangement you drag is kept per browser, not in config. |
| Local model consumers | `models.consumers`, `models.runtimes` | Who uses a runtime, and the start/stop/ready commands `pai models start|stop` run; the shipped defaults configure `ollama` and `docker-model-runner`, your entries win per key ([local models](concepts/local-models.md)). |
| Workers (`config.yaml`) | `workers.*`, shipped in `workers.yaml` defaults | Pool, routing budget walls, supervision, capacity and stagger, gc ([worker.md](worker.md)). |
| Delegation tiers (`workers.yaml`) | `tiers`, `providers.anthropic.models` | The shipped t0/t1/t2 table ([delegation tiers](concepts/delegation-tiers.md)). |
| Cache keepalive | `sessions.cacheKeepalive.*`, `workers.cacheKeepaliveSecs` | Off by default ([cache-keepalive.md](cache-keepalive.md)). |

Exact key names and values: the two defaults files. The history of what moved out of code, with the old constant names, is in the [migration log](dev/config-migration-log.md).
