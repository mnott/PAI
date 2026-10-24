# Battery guard

On macOS the daemon keeps local-model work from draining the battery. Other
platforms: no effect. Cloud workers and your interactive sessions are never
touched; only headless runs on loopback providers are refused or stopped.

## What it does

The daemon reads `pmset -g batt` every `power.batteryGuard.intervalSecs` (60).

| State | Trigger | Effect |
|---|---|---|
| draining on AC | on AC, percent falls over the last `drainWindowReadings` readings | Warning in the daemon log, the cockpit System line and the ledger (`BATTERY-DRAIN-AC`). Nothing is stopped. |
| pause | at or below `pauseBelowPct` (25) | New local-model workers are refused at the worker gate and the scheduled memory index/embed passes do not start, with the reason shown (`BATTERY-PAUSE`). |
| stop | at or below `stopBelowPct` (12) | Running local workers end through the `pai worker kill` path (salvage as on any stop), the passes stop, runtimes PAI started stop through `models.runtimes.<name>.stop` (`BATTERY-STOP`, `BATTERY-RUNTIME-STOP`). |

Admission resumes only above `pauseBelowPct + hysteresisPct` (10)
(`BATTERY-RESUME`).

## Benchmark runs

A benchmark would be spoiled by a pause, so these runs are exempt from pause
and the normal stop: a run whose label names `strata-bench`, the night queue,
or contains `bench`/`benchmark`, and any process holding the marker below.
The guard warns at `pauseBelowPct` (`BATTERY-BENCH-WARN`) and keeps a last
resort: at or below `benchmarkStopBelowPct` (15), or earlier when the drain
rate projects `benchmarkProjectFloorPct` (10) within `benchmarkProjectMins`
(20). Then no new benchmark item starts, the running item gets SIGTERM and up
to `benchmarkSaveSecs` (120) to write its result and progress files, and the
runtimes PAI started stop (`BATTERY-BENCH-STOP`). A normal stop never stops a
runtime under a live benchmark.

### Marker for external runners

A script that is not a `pai worker` declares itself by writing
`<PAI home>/state/benchmark-run.json` while it runs:

```json
{ "pid": 12345, "label": "my-bench", "startedAt": "2026-01-01T12:00:00Z" }
```

The marker counts while `pid` is alive; a stale file is removed. On the
last-resort stop the pid gets SIGTERM and is waited on for the save window.

## Telemetry

Every tick, benchmark or not, appends one line to
`<PAI home>/battery-telemetry.jsonl`: `at`, `pct`, `source` (`ac`/`battery`),
`adapterWatts` (charger rating), `systemPowerInW`, `systemLoadW`, `batteryW`
(negative = discharging) and `drainPctPerMin`, the power values from
`ioreg -rn AppleSmartBattery`. Lines older than 14 days are dropped once a day,
or hourly when the file passes 5 MB.

## Config

| Key (`power.batteryGuard.`) | Default |
|---|---|
| `enabled` | `true` |
| `intervalSecs` | 60 |
| `pauseBelowPct` | 25 |
| `stopBelowPct` | 12 |
| `hysteresisPct` | 10 |
| `drainWindowReadings` | 10 |
| `benchmarkStopBelowPct` | 15 |
| `benchmarkProjectFloorPct` | 10 |
| `benchmarkProjectMins` | 20 |
| `benchmarkSaveSecs` | 120 |

## Where to see it

| Surface | What |
|---|---|
| CLI | `pai config get power.batteryGuard`; `pai worker ps` and `pai audit` show ledger rows |
| Cockpit | System section: percent, source, "local work paused/stopped", drain warning |
| MCP | `battery_status` (reading, gate, benchmark marker) |
