# The cockpit

The cockpit is a single read-mostly web page served by the [router](concepts/router.md). It shows provider limits, local model servers, the delegation routing, the worker pool, memory and power, and token, cache and speed accounting per provider and model.

## Open it

Enable the router (`router.enabled: true`, off by default); the daemon then keeps it running. The page is at `http://127.0.0.1:8790/cockpit`. `pai router status` shows whether it is up. By default it binds loopback only (`router.bind`).

## Sections

Section ids, in page order:

| Id | Shows |
|---|---|
| `cloud` | Provider gauges, local and cloud: limits and how full they are |
| `routing` | Per delegation tier, the models in serving order and what each tier resolves to now. Read-only: edit `workers.yaml` or run `pai worker route set` |
| `workers` | Workers running and waiting in the provider capacity queue |
| `pool` | Worker pool status |
| `models` | Model runtimes: one card per local engine, with consumers and aliases |
| `system` | Memory, load, temperature, power |
| `kpis` | Headline totals |
| `tokens` | Tokens per bucket by kind, weighted or raw |
| `cache` | Cache hit ratio: cache_read / (read + write + fresh input), per provider and model |
| `speed` | Speed per model: time to first token, read and write rates (medians) |
| `pause` | Cache verdict by pause: whether a cache expired between turns |
| `sessions` | Sessions by tokens |
| `runs` | Worker runs |
| `daily` | Tokens per day per model |

## Choose sections

Set `router.cockpit.sections` to a list of ids to show only those, in that order. A single page load can override it with `?sections=`:

```
http://127.0.0.1:8790/cockpit?sections=cloud,routing,pool
```

An empty list shows every section; unknown ids are ignored, and if all are unknown the full page is shown. A section that is not on the page fetches no data. The config is re-read on every page load.

## Aliases

`models.labels` gives a runtime, or one model of a runtime, a readable name on the Models cards: `labels: {ollama: "Chat helper"}` or `labels: {ollama: {"qwen3:8b": "Summaries"}}`. See [local models](concepts/local-models.md). `models.embeddingLabel` names PAI's own embedding consumer.

## Layout

`router.cockpit.layout` holds the page's layout policy: grid breakpoint, tile and card widths, chart sizes, history windows, row limits and refresh intervals (`pollMs`, `limitsPollMs`, `poolPollMs`). Values are read when the page is built, so a user override changes the served page. The keys and their defaults are in `src/config/defaults/config.yaml`; see [config-defaults.md](config-defaults.md) for how defaults and overrides merge (`pai config get <key> --source` shows where a value comes from).

Screenshots: coming
