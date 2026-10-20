# Config defaults: mechanism and backlog

Policy values (thresholds, limits, intervals, lists, labels, mappings) live in configuration files, not code.

## Mechanism

- Shipped defaults: `src/config/defaults/config.yaml` and `src/config/defaults/workers.yaml`, copied to `dist/config/defaults/` by `npm run build` (`scripts/copy-defaults.mjs`).
- Loader: `src/config/shipped-defaults.ts`. Defaults load first and deep-merge UNDER the user's `config.yaml` / `workers.yaml`: user values win, arrays replace, objects merge. A missing user file yields the defaults alone.
- Values computed at load time (`socketPath`, per-user `postgres.connectionString`) stay in code and are defaults too: the user's file wins.
- `pai config get <key> --source` prints the effective value and whether it came from the user file or the shipped defaults.
- `PAI_DEFAULTS_DIR` names the defaults directory explicitly (esbuild test bundles outside dist).

## Moved: PAILot and session notices (2026-10-20)

The notice-path policy values live in `defaults/config.yaml` under `notices`, read at call time through the main-config loader (`src/workers/notice-policy.ts` → `effectiveMainConfig(paiConfigFilePath())`, so a user `config.yaml`/`config.json` wins):

| key | was | value |
|---|---|---|
| `notices.pailot.maxPerMinute` | `PAILOT_MAX_PER_MIN` (src/workers/pailot-guard.ts) | `5` |
| `notices.pailot.dedupHours` | `PAILOT_DEDUP_MS` (src/workers/pailot-guard.ts) | `24 h` |
| `notices.pailot.windowSecs` | the 60 s rate window (src/workers/pailot-guard.ts) | `60 s` |
| `notices.runReports.planGroupThrottleMinutes` | `PLAN_GROUP_THROTTLE_MS` (src/workers/run-events.ts) | `15 min` |
| `notices.runReports.queueReadyBatchMinutes` | `QUEUE_READY_BATCH_MS` (src/workers/run-events.ts) | `10 min` |
| `notices.trouble.throttleMinutes` | `TROUBLE_THROTTLE_MS` (src/workers/worker-trouble.ts) | `5 min` |
| `notices.trouble.denialWindowMinutes` | `DENIAL_WINDOW_MS` (src/workers/worker-trouble.ts) | `10 min` |
| `notices.trouble.denialThreshold` | `DENIAL_THRESHOLD` (src/workers/worker-trouble.ts) | `3` |
| `notices.trouble.stallMinutes` | `STALL_MS` (src/workers/worker-trouble.ts) | `10 min` |

## Moved: panes (2026-10-20)

The pane values live in `defaults/config.yaml` under `panes`, read at call time through `src/workers/pane-policy.ts` (`panePolicy()` → `effectiveMainConfig(paiConfigFilePath())`, so a user config wins):

| key | was | value |
|---|---|---|
| `panes.minCols` / `panes.minRows` | `MIN_COLS`/`MIN_ROWS`/`MIN_PANE_*` (pane.ts), `SMALL_COLS`/`SMALL_ROWS` (pane-audit.ts) | `40` / `6` |
| `panes.verifyTries` / `panes.verifyPollMs` | `tries`/`pollMs` defaults of `verifyPane` (pane.ts) | `25` / `300` |
| `panes.sessionMapMaxAgeDays` | `SESSION_MAP_MAX_AGE_MS` (pane.ts) | `7 d` |
| `panes.titleMax` | `PANE_TITLE_MAX` (pane-title.ts) | `40` |
| `panes.statusTickMs` | chat status-line tick (pane-bar.ts) | `1000` |
| `panes.helloWaitSecs` | `HELLO_WAIT_MS` (pane-exec.ts) | `20 s` |
| `panes.killGraceSecs` | `KILL_GRACE_MS` (pane-exec.ts), kill grace (pane-run.ts) | `3 s` |
| `panes.connectSecs` | wrapper socket connect (pane-exec.ts) | `10 s` |
| `panes.lingerSecs` | `PANE_LINGER_SECS` (pane-run.ts) | `5` |
| `panes.runPollMs` | follow poll (pane-run.ts) | `250` |
| `panes.runKeepHours` | `PANE_RUN_KEEP_MS` (pane-run.ts), keep (pane-audit.ts) | `24 h` |
| `panes.tailLines` | `TAIL_LINES` (pane-run.ts) | `40` |
| `panes.audit.startGraceSecs` / `endGraceSecs` / `launchGraceSecs` | `START_GRACE_MS` / `END_GRACE_MS` / `LAUNCH_GRACE_MS` (pane-audit.ts) | `30 s` / `60 s` / `15 s` |

## Backlog: policy constants still in code

Each later topic commit moves one area into the defaults files. Generated from `NAME = number/list` constants in non-test sources.

| file:line | name | value |
|---|---|---|
| src/tasks/transport/aibroker.ts:25 | `DEFAULT_DISPATCH_TIMEOUT_SECS` | `180` |
| src/tasks/transport/aibroker.ts:36 | `KILL_MARGIN_MS` | `15_000` |
| src/tasks/scheduler.ts:45 | `DEFAULT_EXPECTED_MINUTES` | `30` |
| src/tasks/scheduler.ts:72 | `ABANDON_FLOOR_MINUTES` | `120` |
| src/tasks/poller.ts:58 | `HISTORY_LIMIT` | `5` |
| src/tasks/poller.ts:190 | `ALARM_REPEAT_MS` | `24 * 60 * 60 * 1000` |
| src/tasks/poller.ts:1072 | `NOT_RECEIVED_BACKOFF_BASE_MIN` | `2` |
| src/tasks/schedule-install.ts:30 | `DEFAULT_INTERVAL_SECS` | `900` |
| src/memory/embed-pass.ts:14 | `DEFAULT_EMBED_MAX_MINUTES` | `60` |
| src/config/pai-files.ts:150 | `SESSION_STOP_LOCK_ABANDONED_AFTER_MS` | `60 * 60 * 1000` |
| src/cli/lib/setups.ts:107 | `PORT_TIMEOUT_MS` | `500` |
| src/cli/lib/aibroker-client.ts:67 | `SEND_TIMEOUT_MS` | `30_000` |
| src/cli/lib/health.ts:45 | `SNAPSHOT_MAX_AGE_MS` | `6 * 3600_000` |
| src/cli/lib/audit.ts:534 | `DEFAULT_CTX_THRESHOLD` | `200_000` |
| src/cli/commands/session.ts:106 | `LISTING_WAIT_MS` | `400` |
| src/cli/commands/session/restore.ts:231 | `LIST_LIMIT` | `20` |
| src/cli/commands/session/pause-all.ts:37 | `SETTLE_MS` | `4_000` |
| src/cli/commands/session/pause-all.ts:39 | `POLL_MS` | `2_000` |
| src/builds/reap.ts:25 | `REAP_GRACE_MS` | `5000` |
| src/builds/config.ts:46 | `DEFAULT_STALL_MINUTES` | `5` |
| src/storage/factory.ts:40 | `CLI_RETRY_DELAYS_MS` | `[500, 1_000, 2_000]` |
| src/storage/factory.ts:43 | `DAEMON_RETRY_CAP_MS` | `15_000` |
| src/storage/postgres/dashboard-queries.ts:9 | `EXACT_TIMEOUT_MS` | `20_000` |
| src/audit/ladder.ts:24 | `LADDER_TIMEOUT_MS` | `180_000` |
| src/audit/mcp.ts:49 | `THIRTY_DAYS_MS` | `30 * 24 * 60 * 60 * 1000` |
| src/audit/severity.ts:19 | `HOOK_TOKEN_LIMIT` | `1000` |
| src/audit/severity.ts:22 | `FIRST_TURN_CONTEXT_LIMIT` | `30_000` |
| src/audit/severity.ts:23 | `DAEMON_FAILURE_RATE_LIMIT` | `0.05` |
| src/audit/severity.ts:32 | `MODEL_SWITCH_REBUILD_LIMIT` | `20_000` |
| src/audit/hooks.ts:15 | `HOOK_TIMEOUT_MS` | `20_000` |
| src/audit/files.ts:26 | `SINGLE_FILE_LIMIT` | `5000` |
| src/audit/files.ts:27 | `TOTAL_LIMIT` | `10000` |
| src/daemon/stale-pass.ts:11 | `DAY_MS` | `24 * 3600_000` |
| src/daemon/session-summary-worker.ts:55 | `SUMMARY_COOLDOWN_MS` | `30 * 60 * 1000; // 30 minutes` |
| src/daemon/session-summary-worker.ts:566 | `TOPIC_OVERLAP_THRESHOLD` | `0.15` |
| src/daemon/worktree-gc.ts:12 | `WORKTREE_GC_TICK_MS` | `60 * 60_000` |
| src/daemon/worktree-gc.ts:14 | `THROTTLE_MIN` | `55` |
| src/daemon/registry-scan-trigger.ts:17 | `REGISTRY_SCAN_COALESCE_MS` | `10 * 60 * 1000` |
| src/daemon/quiet.ts:25 | `QUIET_POLL_MS` | `30_000` |
| src/daemon/dashboard.ts:26 | `TICK_MS` | `30_000` |
| src/daemon/dashboard.ts:27 | `COUNTS_TTL_MS` | `5 * 60_000` |
| src/daemon/dashboard.ts:28 | `STALL_MS` | `5 * 60_000` |
| src/daemon/dashboard.ts:29 | `RATE_WINDOW_MS` | `5 * 60_000` |
| src/daemon/dashboard.ts:30 | `HISTORY_MAX` | `120; // 1 h of 30 s samples` |
| src/daemon/dashboard.ts:31 | `HISTORY_PERSIST_MS` | `30_000; // write at most every 30s` |
| src/daemon/dashboard.ts:32 | `HISTORY_PRUNE_AGE_MS` | `2 * 60 * 60_000; // 2 hours` |
| src/daemon/work-queue.ts:85 | `COMPLETED_TTL_MS` | `60 * 60 * 1000;           // 1 hour` |
| src/daemon/work-queue.ts:86 | `FAILED_TTL_MS` | `24 * 60 * 60 * 1000;         // 24 hours` |
| src/daemon/work-queue.ts:89 | `BACKOFF_MS` | `[` |
| src/daemon/daemon/scheduler.ts:72 | `PASS_RETRY_DELAYS_MS` | `[5 * 60_000, 10 * 60_000, 15 * 60_000]` |
| src/daemon/daemon/scheduler.ts:120 | `VAULT_INDEX_MIN_INTERVAL_MS` | `30 * 60 * 1000` |
| src/daemon/daemon/scheduler.ts:478 | `REGISTRY_SCAN_INTERVAL_MS` | `30 * 60 * 1000; // 30 minutes` |
| src/daemon/daemon/scheduler.ts:479 | `REGISTRY_SCAN_STARTUP_DELAY_MS` | `10_000;     // 10 seconds after daemon start` |
| src/daemon/daemon/scheduler.ts:516 | `SUPERVISION_TICK_MS` | `30_000` |
| src/daemon/daemon/scheduler.ts:519 | `SUPERVISION_STARTUP_DELAY_MS` | `15_000` |
| src/daemon/daemon/scheduler.ts:522 | `PANE_REAP_GRACE_MS` | `3_000` |
| src/daemon/daemon/scheduler.ts:525 | `PANE_REAP_TICK_MS` | `2_000` |
| src/daemon/daemon/scheduler.ts:680 | `KEEPALIVE_STARTUP_DELAY_MS` | `60_000` |
| src/daemon/daemon/scheduler.ts:775 | `SESSION_KEEPALIVE_TICK_MS` | `60_000` |
| src/daemon/daemon/scheduler.ts:811 | `ROUTER_TICK_MS` | `30_000` |
| src/daemon/slow-task.ts:8 | `TASK_BUDGET_MS` | `50` |
| src/daemon/work-queue-worker.ts:71 | `WORKER_INTERVAL_MS` | `5_000` |
| src/daemon/work-queue-worker.ts:72 | `HOUSEKEEPING_INTERVAL_MS` | `10 * 60 * 1000; // 10 minutes` |
| src/daemon/build-reap.ts:5 | `BUILD_REAP_TICK_MS` | `60_000` |
| src/daemon/ipc-client.ts:32 | `IPC_TIMEOUT_MS` | `60_000` |
| src/hooks/ts/session-start/initialize-session.ts:31 | `DEBOUNCE_MS` | `2000` |
| src/hooks/ts/pre-compact/context-compression-hook.ts:54 | `DAEMON_TIMEOUT_MS` | `3_000` |
| src/hooks/ts/pre-compact/context-compression-hook.ts:559 | `HANDOVER_WAIT_MS` | `35_000` |
| src/hooks/ts/stop/stop-hook.ts:43 | `DAEMON_TIMEOUT_MS` | `800` |
| src/hooks/ts/stop/stop-hook.ts:167 | `AIBROKER_TIMEOUT_MS` | `2_000` |
| src/hooks/ts/lib/sleep-poll-gate.ts:27 | `SLEEP_ALLOWED_SECS` | `60` |
| src/hooks/ts/lib/worker-guard.ts:388 | `MAX_FOREGROUND_SECS` | `120` |
| src/hooks/ts/lib/context-fill.ts:54 | `STATUSLINE_STALE_MS` | `5 * 60 * 1000; // 5 minutes` |
| src/hooks/ts/lib/context-fill.ts:305 | `DEFAULT_AUTOCOMPACT_PCT` | `80` |
| src/hooks/ts/lib/context-fill.ts:614 | `SAMPLE_CACHE_MAX_AGE_MS` | `24 * 60 * 60 * 1000` |
| src/hooks/ts/lib/wait-timeout.ts:13 | `DEFAULT_SAFE_SECS` | `110` |
| src/hooks/ts/lib/wait-timeout.ts:14 | `MAX_TIMEOUT_MS` | `600_000` |
| src/hooks/ts/lib/wait-timeout.ts:15 | `SLACK_SECS` | `15` |
| src/hooks/ts/lib/context-handover-cache.ts:51 | `HANDOVER_MAX_AGE_MS` | `2 * 60 * 60 * 1000` |
| src/hooks/ts/lib/loop-guard.ts:74 | `WAIT_CAP_MS` | `45 * 60_000` |
| src/workers/status.ts:407 | `TERMINAL_RECHECK_MS` | `5 * 60_000` |
| src/workers/status.ts:555 | `OWNS_TTL_MS` | `60_000` |
| src/workers/status.ts:587 | `LOST_GRACE_MS` | `2 * 60_000` |
| src/workers/status.ts:643 | `SLEEP_FLOOR_SECS` | `60` |
| src/workers/local-provider.ts:49 | `LOCAL_PROBE_TIMEOUT_MS` | `2000` |
| src/workers/scope.ts:162 | `SPAWNER_SESSION_TTL_MS` | `10 * 60_000` |
| src/workers/scope.ts:165 | `SESSION_MAP_PRUNE_MS` | `60 * 60_000` |
| src/workers/hang-probe.ts:23 | `DEFAULT_IDLE_SECS` | `60` |
| src/workers/help.ts:21 | `HELP_MAX_MINUTES` | `20` |
| src/workers/pool.ts:703 | `SPARE_WARM_WINDOW_MS` | `60 * 60_000` |
| src/workers/deadline.ts:87 | `DEADLINE_GRACE_MS` | `10_000` |
| src/workers/standalone/session-name-cache.ts:16 | `SESSION_NAME_CACHE_TTL_MS` | `5 * 60_000` |
| src/workers/reaper.ts:25 | `REAP_TICK_MS` | `30_000` |
| src/workers/reaper.ts:26 | `REAP_MIN_AGE_SECS` | `120` |
| src/workers/reaper.ts:27 | `REAP_CPU_PCT` | `50` |
| src/workers/reaper.ts:57 | `START_SLACK_MS` | `5000` |
| src/workers/wait-probes.ts:12 | `PROBE_DEFAULT_SECS` | `100` |
| src/workers/wait-probes.ts:13 | `PROBE_CAP_SECS` | `590` |
| src/workers/routing.ts:60 | `PROBE_TIMEOUT_MS` | `10_000` |
| src/workers/routing.ts:62 | `BUDGET_COOLDOWN_MIN` | `10` |
| src/workers/model-inventory.ts:25 | `MODEL_INVENTORY_REFRESH_MS` | `30_000` |
| src/workers/model-inventory.ts:26 | `MODEL_INVENTORY_MAX_AGE_MS` | `90_000` |
| src/workers/model-inventory.ts:27 | `PROBE_MS` | `2000` |
| src/workers/supervision.ts:136 | `DEFAULT_STALL_MINUTES` | `10` |
| src/workers/supervision.ts:224 | `HOLLOW_MS` | `10 * 60_000` |
| src/workers/supervision.ts:227 | `BACKLOG_AGE_MS` | `3_600_000` |
| src/workers/supervision.ts:229 | `BACKLOG_MIN` | `10` |
| src/workers/supervision.ts:692 | `POINTER_AFTER_MS` | `60_000` |
| src/workers/pending.ts:29 | `STALE_HOURS` | `24` |
| src/workers/wait-on.ts:17 | `WAIT_DEFAULT_SECS` | `110` |
| src/workers/wait-on.ts:18 | `WAIT_CAP_SECS` | `590` |
| src/workers/wait-on.ts:19 | `POLL_MS` | `2000` |
| src/workers/wait-on.ts:20 | `HEARTBEAT_MS` | `20_000` |
| src/workers/wait-on.ts:22 | `REUSE_SLACK_MS` | `2000` |
| src/workers/wait-on.ts:26 | `KILL_GRACE_MS` | `5000` |
| src/workers/stagger.ts:24 | `POLL_STEPS_MS` | `[250, 500, 1000, 2000]` |
| src/workers/engines/image.ts:38 | `DEFAULT_IMAGE_TIMEOUT_MS` | `120_000` |
| src/workers/wait.ts:163 | `WAIT_MAX_DEFAULT_SECS` | `100` |
| src/workers/wait.ts:164 | `WAIT_MAX_CAP_SECS` | `590` |
| src/workers/tool-errors.ts:36 | `SAME_WORKER_MIN` | `3` |
| src/workers/tool-errors.ts:37 | `CROSS_WORKER_MIN` | `2` |
| src/workers/tool-errors.ts:38 | `CROSS_WORKER_WINDOW_MS` | `30 * 60_000` |
| src/workers/tool-errors.ts:39 | `SAME_WORKER_WINDOW_MS` | `2 * 60 * 60_000` |
| src/workers/tool-errors.ts:40 | `RESEND_MS` | `30 * 60_000` |
| src/workers/tool-errors.ts:41 | `SIGNATURE_MAX` | `160` |
| src/workers/tool-errors.ts:42 | `RAW_MAX` | `300` |
| src/workers/tool-errors.ts:43 | `INPUT_MAX` | `1000` |
| src/workers/budget.ts:45 | `BUDGET_TTL_MS` | `5 * 60_000` |
| src/workers/local-status.ts:15 | `LOCAL_STATUS_REFRESH_MS` | `30_000` |
| src/workers/local-status.ts:17 | `LOCAL_STATUS_MAX_AGE_MS` | `90_000` |
| src/workers/route-classifier.ts:17 | `LOCAL_FAILURE_LIMIT` | `2` |
| src/workers/result-grace.ts:12 | `RESULT_GRACE_MS` | `20_000` |
| src/workers/run-env.ts:90 | `COPY_MAX_AGE_MS` | `7 * 24 * 3600 * 1000` |
| src/workers/capacity.ts:75 | `MAX_TOTAL_WAIT_MS` | `2 * 3_600_000` |
| src/workers/capacity.ts:78 | `HEARTBEAT_MS` | `60_000` |
| src/workers/capacity.ts:113 | `AGING_MS` | `15 * 60_000` |
| src/workers/model-runtimes.ts:77 | `RUNTIME_READY_TIMEOUT_MS` | `120_000` |
| src/workers/model-runtimes.ts:78 | `RUNTIME_READY_POLL_MS` | `2_000` |
| src/workers/run.ts:1198 | `SIGNAL_SALVAGE_MS` | `5_000` |
| src/workers/local-tiers.ts:281 | `VLLM_READY_MS` | `10 * 60 * 1000` |
| src/workers/local-tiers.ts:282 | `STRATA_READY_MS` | `5 * 60 * 1000` |
| src/notifications/providers/whatsapp.ts:38 | `HUB_TIMEOUT_MS` | `10_000` |
| src/session/context-handover-trigger.ts:50 | `ENQUEUE_TIMEOUT_MS` | `2_000` |
| src/session/context-handover-trigger.ts:61 | `PENDING_TIMEOUT_MS` | `5 * 60 * 1000` |
| src/session/context-handover-trigger.ts:64 | `REARM_AGE_MS` | `30 * 60 * 1000` |
| src/session/forge-sink.ts:31 | `FORGE_BUDGET_MS` | `5000` |
| src/session/checkpoint-block.ts:83 | `ARCHIVE_LIMIT` | `5` |
| src/session/checkpoint-block.ts:613 | `AUTHORED_GRACE_MS` | `60 * 60 * 1000` |
| src/router/pool-panel.ts:82 | `DAY_MS` | `24 * 3600_000` |
| src/router/scheduler.ts:37 | `WARM_MS` | `5 * 60_000` |
| src/router/scheduler.ts:38 | `PING_MS` | `15_000` |
| src/router/limits.ts:80 | `BACKOFF_MAX` | `30 * 60_000` |
| src/router/limits.ts:82 | `ANTHROPIC_POLL_MS` | `5 * 60_000` |
| src/router/limits.ts:462 | `PREFIX_STATS_TIMEOUT_MS` | `15_000` |
| src/router/limits.ts:601 | `PREFIX_STALE_MS` | `10 * 60_000` |
| src/router/runtime-samples.ts:34 | `RUNTIME_SAMPLE_MS` | `5_000` |
| src/router/runtime-samples.ts:38 | `ENGINE_STATUS_TIMEOUT_MS` | `1_000` |
| src/router/runtime-samples.ts:414 | `CARD_READING_MAX_AGE_MS` | `2_000` |
| src/router/system.ts:40 | `SLOW_TTL` | `5 * MIN` |
| src/router/system.ts:42 | `TOP_TTL` | `10_000` |
| src/router/cockpit.ts:52 | `RETRY_WITHIN_MS` | `120_000` |
| src/router/prompt-tokens.ts:170 | `MAX_WAIT_MS` | `10_000` |
| src/router/sessions.ts:165 | `ATTRIBUTE_SLACK_MS` | `120_000` |
