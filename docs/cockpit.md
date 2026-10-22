# The cockpit

The cockpit is one web page served by the [router](concepts/router.md). It answers four questions in one place: how full are my provider limits, where do delegated workers go and what are they doing, what are the local model servers and the machine doing, and where do my tokens and cache hits go. It is mostly read-only. The few controls it has start and stop local models and name them.

![The cockpit's top: Limits and local servers with the local server tiles and the cloud provider gauges, then Routing with one line per delegation tier](images/cockpit-limits-routing.jpg)

## Open it

Enable the router, which is off by default: `pai config set router.enabled true && pai reload`. The daemon then keeps it running, and the page is at:

```
http://127.0.0.1:8790/cockpit
```

If the Limits section shows your Anthropic gauge and the Routing section shows one row per tier, it works. An empty Totals section only means no workers have run yet.

`router.bind` is `loopback` by default, so only the machine itself can reach the page and no token is asked for. Normally you run nothing: the daemon keeps the router up. Use `pai router status` to check; the others are for when it is not:

```
pai router status      # is it up
pai router start       # start it in the background
pai router restart     # the new router takes the port, the old one drains streams
pai router stats       # the same token and cache totals in the terminal
```

Setting `router.bind` to `tailscale` (or an explicit IPv4 address) opens a second listener there, and the cockpit then needs a token: `?token=` in the URL, an `Authorization: Bearer` header, or the cookie the first token hit sets. The token is generated on first start, kept in the PAI home with mode 0600, and the full URL is printed once at startup. `0.0.0.0` is refused. See [the router](concepts/router.md) and [router command reference](commands/router.md).

The header has a **1 hour / Today / Week** switch (the window for the accounting sections), a stamp that reads "stale" when the data is older than `stampStaleSecs`, the reset-layout button and a light/dark toggle. The theme choice is kept in the browser.

## The sections, in page order

Each section is below with the title the page shows. The id in brackets is what `router.cockpit.sections` and `?sections=` take.

### Limits and local servers (`cloud`)

Answers: how much of each provider's allowance is used, and which local servers are up. Two groups: **Local** has one tile per local model server, showing up or down, memory in GB, tokens per second and the model. A server is up only when its endpoint actually serves that provider's model (several providers can share one port, so an answering port alone is not enough). A server that is slow to answer is busy, not down: it turns down when the connection is refused, when the endpoint answers without serving the model, or after `timeoutStrikes` timeouts in a row (see [Probe keys](#probe-keys)). A down tile says why; **Cloud** has one card per provider with a gauge per usage window (for example a five-hour and a weekly window) and its reset time. A gauge marked `estimated` is not read from the provider but derived; one marked `old` could not be refreshed and shows the age of its last reading. A provider that fails to answer shows its error in place of gauges. Limits refresh every `limitsPollMs`.

### Routing (`routing`)

Answers: where does a delegated worker go now. One line per delegation tier from `workers.yaml`, listing the models in the order they serve, each as a chip: the first available one wins, the rest are the fallback order. A local model that is not running is skipped, not started. Session-specific routes appear indented under their tier. The section is read-only. To change a route, run `pai worker route set` or edit `workers.yaml`; see [delegation tiers](concepts/delegation-tiers.md).

### Workers — running and waiting (`workers`)

Answers: what is running and what is queued behind a provider's capacity cap. Per provider, a table of running and waiting workers with their position, and for waiting ones the buttons **next** (runs next, without interrupting the running worker) and **up** (one place up). Where the queue is serial, rows can also be dragged by their grip to reorder.

### Worker pool (`pool`)

Answers: is the worker pool healthy. Its status as the pool reports it, refreshed every `poolPollMs`. The text is provider-neutral. When the pool is off, the panel gives the reason (for example config disabled, host down, or claims disabled because a terminal pane is required) next to how to turn it on.

### Models — runtimes (`models`)

Answers: which local model runtimes exist, what uses them and how they are doing. One foldable card per consumer, with the model's purpose as the title (the consumer's label, else the model name) and the model id in grey beside it. Metric tiles show memory, speed, users, workers (running, queued, slots, spares) and the conversation cache, with a short sparkline of the sampler's last five minutes (`router.samples`). A value the runtime does not report shows `–`.

Controls:

- **Start / stop** buttons run the commands configured under `start` and `stop` commands of a runtime under `models.runtimes` (see [local models](concepts/local-models.md)). A runtime without a command has no button. They are the same action as `pai models start|stop`. Several consumers can share one runtime, and a stop takes the whole runtime down: on a card whose runtime serves other consumers, the stop names them ("stop ollama: also PAI embedding - click again") and needs a second click within `confirmMs`; a click after that re-arms it without acting. A runtime serving only this card's consumers stops in one click. Start and load are unaffected.
- **Local model:** a button per coding tier switches the local engine to that tier. The active tier is disabled; switching while another model runs asks for a second click and names what it stops. **off** stops every local server. Both run as a job whose progress the card follows.
- **Alias:** the pencil beside a card's title opens an inline field in place of the title, with ✓ (save), ✕ (cancel) and, when an alias is set, ↺ (back to the original name). Enter saves and Escape cancels too; tapping elsewhere cancels. An empty value removes the alias. The alias is written to `models.labels` in your config, and it then names the model in the cards, the rings and the speed table. An embedding consumer is titled by `models.embeddingLabel`.

A runtime's note (`models.runtimes.<name>.note`) is the tooltip of the runtime chip in the card header, so consumers that share a runtime do not repeat it.

A card folds by clicking its header. By default a running coding runtime is open and the rest are folded.

![Models: the local engine card with speed, memory, workers and conversation cache tiles and the local model switch, then one card per consumer on the shared runtimes](images/cockpit-models.jpg)

### Memory (`memory`)

Answers: is the memory index healthy and is it embedding. Files, chunks, chunks without vectors (the backlog) and coverage; the embedding backend and model; the last index pass and last embed pass (time, duration, chunks done); the nightly schedule (`maintenanceHour`); embedding jobs, backend availability and pass failures. The title, thresholds and refresh interval come from `router.cockpit.layout` (`memoryTitle`, `memoryCoverageWarn`, `memoryCoverageBad`, `memoryPollMs`). This is the page that used to be served on port 8770; that server no longer exists.

- **embed backlog** runs `pai memory embed --all --background` detached and shows chunks embedded so far / backlog at start, rate, ETA and the last log line. **stop** ends it cleanly (the command is safe to stop and re-run). **index now** runs one index pass (`pai memory index --direct --background`).
- One run at a time. A run started by the CLI, the cockpit or the daemon's own pass is found through `<PAI home>/state/memory-run.json` and the card reads "running (started by …)"; a second start is refused.

### System — memory, load, temperature, power (`system`)

Answers: is the machine under pressure. Metric tiles for memory, load, temperature and power over the selected window, each with a sparkline of its recent history; a tile whose every sample is 0 is hidden and listed as "hidden". The **Power and GPU/CPU load** chart sits inside this section. Below, one tile per local server: status (with the reason when it is down), memory (RSS), end-to-end and decode tokens per second, and prefix-cache hit rate. `/cockpit/system` returns the same servers with a `downReason` for each one that is down.

Tile grids never leave a partial last row: in wide mode the grid has 12 tracks, and when the last row is short its tiles widen to fill it, so there is no 3+1.

![Workers and the worker pool, the Models cards, System tiles and Totals in this window](images/cockpit-workers-system.jpg)

### Totals in this window (`kpis`)

Answers: how much in all. Requests, tokens and errors over the selected 1 hour, Today or Week window.

### Tokens per bucket by kind (`tokens`)

Answers: when were tokens spent and of what kind. Stacked bars per time bucket in four kinds: fresh input, cache write, cache read and output. **weighted** counts them by price weight, **raw** counts tokens; the selector beside it narrows to one model. The **Power and GPU/CPU load** chart (watts on the left axis, load percent on a fixed 0-100 right axis) is shown in the System section.

### Cache hit ratio and Providers (`cache`)

Answers: is the cache earning its keep. **Cache hit ratio** is `cache_read / (read + write + fresh input)`, one ring per provider and model; models under `lowRequestMin` requests are folded into a chip instead. A local server that reports no cache fields per request shows its own prefix-cache counter instead, marked `*` (it covers the time since that server started, so its window differs from the router log). **Providers** is one tile per provider; the tiles fill their row. Each has requests, tokens, average latency and time to first token.

![Cache hit ratio and Providers, Tokens per day per model and Tokens per bucket by kind](images/cockpit-usage.jpg)

### Speed per model (`speed`)

Answers: how fast is each model. Per provider and model, each value as a pair `1h · 24h` (last hour, then last 24 hours): median and 90th-percentile time to first token, read speed (input tokens divided by time to first token, so prefill) and write speed (output tokens divided by decode time, replies of 16 or more tokens only).

### Cache verdict by pause (`pause`)

Answers: did the cache expire between turns. Per model, hits grouped by the pause since the previous request of the same session. A drop after five minutes means the cache expired (Anthropic's prompt cache expires after five idle minutes) and a [keepalive](cache-keepalive.md) under five minutes would have kept it.

### Sessions by tokens (`sessions`)

Answers: which sessions cost the most. The top `sessionsRows` sessions with models, requests, tokens, fresh input, output, hit percentage, cache busts, errors and last activity. A worker session carries its verdict.

### Worker runs (`runs`)

Answers: how did delegated workers end. The latest `workerRows` workers as label, verdict and tokens; the label takes two lines at most, with the provider and run id small beneath, and the full label is in the tooltip. The verdict is a short word and its full text is in the tooltip. Verdicts: **ok** and **done** in green, **report flagged** in amber (the worker finished but its report needs a look), **failed** in red; anything else is dim.

### Tokens per day per model (`daily`)

Answers: the long view. A stacked chart of tokens per day and model over the last `dailyDays` days (14 by default), with a model legend.

### Tables

Tables never scroll sideways and never break a header or a number mid-word. The first text column takes the free width. A table that does not fit its section (measured, not a fixed breakpoint) stacks into cards, one per row; a table that fits stays a table, whatever the screen.

## Layout

The page is yours to arrange, and the arrangement survives a refresh.

- **Fold.** Every section has a chevron in its header; click it to fold the section down to its title. Cards in the Models section fold on their own. Folded state is remembered.
- **Move sections.** Drag a section by the grip at the left of its title. Drop it beside another section to share a row, or above or below to put it on its own row. See [Cockpit windowing](#cockpit-windowing) for how cards, groups, drops and sizes work.
- **Move tiles.** Metric tiles inside a section have their own grip at the top right (visible on hover); drag a tile to reorder it within its section.
- **Keyboard.** Focus a grip and press Alt+Up or Alt+Down to move a section to the row above or below as its own row, Alt+Left or Alt+Right to move it within its row or out to a neighbouring row. On a tile grip, Alt+Left and Alt+Right reorder the tile. Escape cancels a drag in progress.
- **Reset.** The ⟲ button in the header discards the saved section arrangement and returns to the default.

What is stored where:

| Where | What |
|---|---|
| Browser (local storage) | Section arrangement, tile order, folded sections and cards, model colours, the weighted/raw choice, the window, the theme |
| Config | `router.cockpit.sections`, `router.cockpit.layout.*` (polling, geometry and colour thresholds), `router.cockpit.probe.*`, `models.labels`, `models.runtimes` |

Nothing about your arrangement is sent to the server, so a different browser starts from the default. The default arrangement comes from the card registry in the page source.

## Configuration

### Choosing sections

`router.cockpit.sections` is a list of section ids; only those are shown, in that order. A single page load can override it:

```
http://127.0.0.1:8790/cockpit?sections=cloud,routing,pool
```

An empty list shows every section. Unknown ids are ignored, and if all are unknown the full page is shown. A section that is not on the page fetches no data. The config is re-read on every page load.

### Layout keys

`router.cockpit.layout` holds the layout policy. The values are read when the page is built, so a user override changes the served page. The shipped defaults are in `src/config/defaults/config.yaml`; [config-defaults.md](config-defaults.md) explains how defaults and overrides merge, and `pai config get router.cockpit.layout.<key> --source` shows where a value comes from.

| Key | Default | Meaning |
|---|---|---|
| `gaugeMinWidthPx`, `gaugeMaxWidthPx` | 110, 120 | Width of a limits gauge tile |
| `ringMinWidthPx` | 92 | Minimum column width of a cache ring |
| `palette` | 24 colours | Model colours in assignment order (`#rrggbb`); the first four are the token-kind colours |
| `colorPruneDays` | 90 | Saved model colours not used for this long are forgotten |
| `sessionTitleMaxWidthPx` | 480 | Widest title in Sessions by tokens |
| `sparkHeightPx`, `sparkViewMaxPx`, `sparkPlotHeightPx`, `sparkPlotTopPx` | 32, 100, 28, 30 | Sparkline geometry in metric tiles |
| `donutSizePx`, `donutRadiusPx`, `donutStrokePx`, `donutViewBoxPx` | 84, 48, 16, 140 | Cache ring geometry |
| `dailyDays` | 14 | Days in Tokens per day per model |
| `sessionsRows` | 20 | Rows in Sessions by tokens |
| `sessionsTopRows` | 10 | Sessions shown before the rest collapse into one "+N more sessions" row |
| `sessionNameMaxPct` | 35 | Session-name column cap, percent of the table width |
| `workerRows` | 15 | Rows in Worker runs |
| `lowRequestMin` | 5 | Models under this many requests become chips, not rings |
| `pollMs` | 5000 | Refresh of the main data |
| `limitsPollMs` | 30000 | Refresh of Limits and local servers |
| `poolPollMs` | 15000 | Refresh of Worker pool |
| `clockTickMs` | 1000 | Tick of the header clock |
| `stampStaleSecs` | 15 | Age after which the stamp reads "stale" |
| `jobFirstDelayMs`, `jobPollMs`, `jobMaxTries` | 2000, 5000, 120 | Following a local switch, off or runtime job: first delay, poll interval, tries |
| `serverCounterStaleSecs` | 60 | A server prefix-cache counter older than this is marked |
| `minLabelGapPx`, `minBarPx` | 48, 3 | Time-axis labels are thinned to a label every k buckets so neighbours keep this many px; bar charts merge buckets (caption names the bucket size) so a bar stays at least this wide |
| `sysHistoryLen` | 60 | System tiles are metric tiles with a sparkline; a metric without a server series keeps this many recent polls in the page |
| `gaugeWarnPct`, `gaugeBadPct` | 70, 90 | A limits gauge at/above the bad percent colours red, at/above the warn percent amber |
| `hitWarn`, `hitBad` | 0.8, 0.5 | A cache hit ratio below the warn ratio colours amber, below the bad ratio red (cache rings, pause verdicts, sessions and provider hit columns) |
| `errorWarn`, `errorBad` | 0.02, 0.1 | An error rate at/above the bad ratio colours red, at/above the warn ratio amber (totals strip, provider err%) |

Keys removed with the windowing cut-over (`gridCols`, `gridBreakpointPx`, `minSectionPx`, `providerTileMinPx`, `runtimeCardMinPx`, `tilesWideBreakpointPx`, `tilesWideCols`, `tilesNarrowCols`, `tilesOneColBreakpointPx`, `bigDonutSizePx`, the six `*ChartWidthPx`/`*ChartHeightPx`, `chartResizeSlackPx`, `chartResizeDebounceMs`, `confirmMs`, `foldDefaultKind`, `rows`, `maxPerRow`, `touchPressMs`, `edgeScrollPx`) have no effect. A config that still sets one is not an error: the router ignores it and writes one line to its log naming the keys. Card arrangement and sizes are not configuration; see [Cockpit windowing](#cockpit-windowing).

The sampler behind the Models tiles is `router.samples` (`sampleMs`, `historyLen`, `engineStatusTimeoutMs`, `cardReadingMaxAgeMs`), also in the shipped defaults.

### Probe keys

`router.cockpit.probe` holds the local-server probe policy, read when the router polls its limits.

| Key | Default | Meaning |
|---|---|---|
| `timeoutStrikes` | 3 | A local server whose TCP connect or `/v1/models` answer times out is busy, not down; it turns down after this many consecutive timeouts (refused / not serving = down at once) |
| `tcpTimeoutMs` | 3000 | TCP connect timeout of the local-server probe |
| `stallLogMs` | 1000 | The router logs one line when its event loop is blocked longer than this, with the requests in flight and the slow synchronous handlers |

## Cockpit windowing

The page is a tree of windows, not a fixed grid. Everything on it is a card; cards sit in containers; you rearrange and resize them directly. The arrangement is the browser's, not the config's.

**Cards and groups.** A card has a header (grip, title, status, minimize button) and a body drawn by its type. A group is a card whose body holds other cards, laid out by the same rules inside the group's box. The page root is a column of bands; a band is a single card or a row of cards side by side.

**Types.** A card's type decides what it draws and its minimum and default size (`src/router/cockpit-page/win/types.ts` and the `cards-*.ts` files next to it). The general types draw whatever data a card's spec returns:

| Type | Draws |
|---|---|
| `kv` | a big value with a sub line and an optional header status |
| `table` | a table (stacks into cards when it does not fit, as in [Tables](#tables)) |
| `note` | one text line |
| `list` | a keyed row list, or plain markup |
| `metric` | a value with unit, sub line, extra markup and a sparkline |
| `metricm` | the same, taller, for a metric with a larger sparkline |

Section types draw the page's own parts: `group`, `chart`, `ring`, `chips`, `server`, `provider`, `runtime`, `model`, `eplist`, `rtflow`, `routing-row`, and the registry editor's `editor` and `backups`.

**Drag.** Drag a card by its grip and drop it on the left, right, top or bottom edge of another card, within that card's container. The outer quarter of each side is a drop zone; the middle is not. Left or right makes the two cards a row; top or bottom stacks them in a column. A drop that would leave any card below its type's minimum size, or force a row to stack its cards, is refused: the marker turns a red dashed line and gives the reason. Escape cancels. By keyboard: focus the grip, press Enter or Space to pick the card up, the arrow keys to move it to the other side of the nearest neighbour in that direction, Enter or Space to drop, Escape to restore it; each step is announced to screen readers.

**Minimize and restore.** Every card has a button in its header that folds the card down to its header; press it again to restore it. The ANE load, CPU W, GPU W and ANE W cards start minimized. In a root band or a row only that card shrinks and the space below it stays empty; in a group the siblings share the freed height.

**Gutters.** The gap between two siblings is a handle. Drag it with the pointer (or focus it and use the arrow keys) to trade size between the two neighbours; other siblings keep theirs. A resize that would push a neighbour under its minimum is refused, and minimized neighbours have no handle.

**Heights: fit once, grow only.** Until you move or resize something, a card's height is the height of its content, measured once. After that a height only grows: content that shrinks later does not make the card or its neighbours jump. A size you have set yourself is saved as it is. A card added while the page is open (a new runtime, for example) grows its group, and the neighbours keep their size; a card that goes away shrinks the group the same way. When something above the view grows, the view stays where it is instead of jumping. Below 480 px width the cards are stacked in one column for display only; the stored arrangement is unchanged.

**Persistence.** The arrangement, sizes, minimized cards and group contents are saved in the browser's local storage under `pai.cockpit.win.v2`. The saved state wins over the defaults; a card that is new in a later version is added to the default place, and a saved card that no longer exists is dropped. The older `pai.cockpit.layout.v1`, `pai.cockpit.tiles.v1` and `pai.cockpit.collapsed` entries are removed on first load. A change made just before you close the tab or switch away is saved too. A saved layout you never changed, whose only difference from the default is the order of the top-level groups, is put back in the default order. The ⟲ button clears the saved state. Nothing is sent to the server.

**Controls.** Every button, chip close, stop and similar control on a card is a registered action with a title (tooltip and accessible name).

**Registry editor.** The Registry card edits the model registry (`workers.yaml`) in the page:

- *Validate* checks the text with the config loader's own parsers plus uniqueness, port, model file and running-instance checks, shows errors with line numbers, and shows a line diff against the file on disk.
- *Save* re-validates, refuses if the file changed on disk since you loaded it, copies the current file to a timestamped backup, writes the new text to a temporary file, re-reads and re-validates it, and renames it over the registry. A failure at any step leaves the registry byte-identical.
- *Backups* lists the timestamped backups, newest first, with a diff summary against the current file; *restore* (a second click confirms) runs the same validate and atomic save, and backs up the file it replaces.
- *Duplicate* copies a `local_tiers` entry under a new name on the next free port, other fields identical.

Mutations are POST-only, same-origin and written to the cockpit action ledger.
