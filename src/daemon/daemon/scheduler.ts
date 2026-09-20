/**
 * Index, embed, vault index, and registry scan schedulers for the PAI daemon.
 * Exports run* functions (also called on-demand by the IPC handler)
 * and the start* functions invoked once at daemon startup.
 */

import { indexAll } from "../../memory/indexer.js";
import { readWorkersSection } from "../../workers/config.js";
import { keepaliveSecs, runKeepaliveBeat, type BeatMetrics } from "../../workers/keepalive.js";
import { workersLogDir } from "../../workers/paths.js";
import { runSupervisionTick, stallMinutesFromEnv } from "../../workers/supervision.js";
import { storeObservationWithProject } from "../../observations/store.js";
import { runSessionKeepaliveTick } from "../session-keepalive.js";
import type { PostgresBackendWithPool, SQLiteBackendWithDb } from "./types.js";
import {
  registryDb,
  storageBackend,
  daemonConfig,
  indexInProgress,
  embedInProgress,
  vaultIndexInProgress,
  shutdownRequested,
  setIndexInProgress,
  setLastIndexTime,
  setIndexSchedulerTimer,
  setEmbedInProgress,
  setLastEmbedTime,
  setEmbedSchedulerTimer,
  setVaultIndexInProgress,
  setLastVaultIndexTime,
  setCacheKeepaliveTimer,
} from "./state.js";

// ---------------------------------------------------------------------------
// Index scheduler
// ---------------------------------------------------------------------------

/** Minimum interval between vault index runs (30 minutes). */
const VAULT_INDEX_MIN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Run a full index pass. Guards against overlapping runs with indexInProgress.
 * Called both by the scheduler and by the index_now IPC method.
 */
export async function runIndex(): Promise<void> {
  if (indexInProgress) {
    process.stderr.write("[pai-daemon] Index already in progress, skipping.\n");
    return;
  }

  if (embedInProgress) {
    process.stderr.write("[pai-daemon] Embed in progress, deferring index run.\n");
    return;
  }

  setIndexInProgress(true);
  const t0 = Date.now();

  try {
    process.stderr.write("[pai-daemon] Starting scheduled index run...\n");

    if (storageBackend.backendType === "sqlite") {
      const { SQLiteBackend } = await import("../../storage/sqlite.js");
      if (storageBackend instanceof SQLiteBackend) {
        const db = (storageBackend as SQLiteBackendWithDb).getRawDb();
        const { projects, result } = await indexAll(db, registryDb);
        const elapsed = Date.now() - t0;
        setLastIndexTime(Date.now());
        process.stderr.write(
          `[pai-daemon] Index complete: ${projects} projects, ` +
            `${result.filesProcessed} files, ${result.chunksCreated} chunks ` +
            `(${elapsed}ms)\n`
        );
      }
    } else {
      const { indexAllWithBackend } = await import("../../memory/indexer-backend.js");
      const { projects, result } = await indexAllWithBackend(storageBackend, registryDb);
      const elapsed = Date.now() - t0;
      setLastIndexTime(Date.now());
      process.stderr.write(
        `[pai-daemon] Index complete (postgres): ${projects} projects, ` +
          `${result.filesProcessed} files, ${result.chunksCreated} chunks ` +
          `(${elapsed}ms)\n`
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Index error: ${msg}\n`);
  } finally {
    setIndexInProgress(false);
  }
}

/**
 * Run a vault index pass. Guards against overlapping runs with vaultIndexInProgress.
 * Skips if no vaultPath is configured, or if project index/embed is in progress.
 */
export async function runVaultIndex(): Promise<void> {
  if (!daemonConfig.vaultPath) return;

  if (vaultIndexInProgress) {
    process.stderr.write("[pai-daemon] Vault index already in progress, skipping.\n");
    return;
  }

  if (indexInProgress || embedInProgress) {
    process.stderr.write("[pai-daemon] Index/embed in progress, deferring vault index.\n");
    return;
  }

  // Import lastVaultIndexTime from state (re-read each call since it may change)
  const { lastVaultIndexTime } = await import("./state.js");
  if (lastVaultIndexTime > 0 && Date.now() - lastVaultIndexTime < VAULT_INDEX_MIN_INTERVAL_MS) {
    return;
  }

  let vaultProjectId = daemonConfig.vaultProjectId;
  if (!vaultProjectId) {
    const row = registryDb
      .prepare("SELECT id FROM projects WHERE root_path = ?")
      .get(daemonConfig.vaultPath) as { id: number } | undefined;
    vaultProjectId = row?.id ?? 999;
    if (!row) {
      process.stderr.write("[pai-daemon] Vault not in project registry — using synthetic project ID 999.\n");
    }
  }

  setVaultIndexInProgress(true);
  const t0 = Date.now();

  process.stderr.write("[pai-daemon] Starting vault index run...\n");

  try {
    const { indexVault } = await import("../../memory/vault-indexer.js");
    const r = await indexVault(storageBackend, vaultProjectId, daemonConfig.vaultPath!);
    const elapsed = Date.now() - t0;
    setLastVaultIndexTime(Date.now());
    process.stderr.write(
      `[pai-daemon] Vault index complete: ${r.filesIndexed} files, ` +
      `${r.linksExtracted} links, ${r.deadLinksFound} dead, ` +
      `${r.orphansFound} orphans (${elapsed}ms)\n`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Vault index error: ${msg}\n`);
  } finally {
    setVaultIndexInProgress(false);
  }
}

/**
 * Start the periodic index scheduler. Runs an initial pass 2 seconds after startup.
 */
export function startIndexScheduler(): void {
  const intervalMs = daemonConfig.indexIntervalSecs * 1_000;

  process.stderr.write(
    `[pai-daemon] Index scheduler: every ${daemonConfig.indexIntervalSecs}s\n`
  );

  // Indexing and embedding are mutually exclusive (each defers to the other),
  // and an index pass regularly outlasts the index interval. Left to two
  // independent timers, the embed tick therefore lands while indexing is in
  // progress and is dropped — observed live on 2026-08-01 as six consecutive
  // index passes with no embed pass at all, and a 143k-chunk embedding backlog.
  // Chaining embed onto the end of every index pass makes the alternation
  // guaranteed rather than a race: index, then vault, then embed, every cycle.
  const cycle = (label: string, withEmbed: boolean) =>
    runIndex()
      .then(() => runVaultIndex())
      .then(() => (withEmbed ? runEmbed() : undefined))
      .catch((e) => {
        process.stderr.write(`[pai-daemon] ${label} index error: ${e}\n`);
      });

  // The startup pass indexes but must NOT embed unless embedOnStartup says so.
  // startEmbedScheduler already refuses a startup embed for exactly that reason;
  // chaining runEmbed onto this pass reinstated the same CPU storm through the
  // back door. Seen live after a reboot: "Startup embed pass skipped
  // (embedOnStartup=false)" in the log, and minutes later the same boot running
  // a 5000-chunk pass at ~450% CPU. A guard one scheduler honours and another
  // walks around is not a guard.
  // With a maintenance hour configured there is no startup pass at all. Every
  // restart otherwise buys itself a full index run, so on a machine that is
  // rebooted or has the daemon reloaded during the day the "maintenance runs at
  // night" guarantee is worth nothing: the heavy work simply follows the
  // restarts around. Indexing waits for the window like everything else.
  if (daemonConfig.maintenanceHour === undefined) {
    setTimeout(() => void cycle("Startup", daemonConfig.embedOnStartup), 2_000);
  } else {
    process.stderr.write(
      "[pai-daemon] Startup index pass skipped (maintenanceHour is set).\n"
    );
  }

  // Anchor the recurring cycle to a wall-clock hour when one is configured.
  // setInterval alone counts from daemon start, so a machine rebooted at noon
  // gets its "daily" maintenance at noon every day thereafter — the interval
  // says how often, never when. Without an anchor there is no such thing as a
  // night-only pass, however long the interval.
  const firstDelayMs = msUntilNextAnchor(daemonConfig.maintenanceHour, intervalMs);
  if (daemonConfig.maintenanceHour !== undefined) {
    process.stderr.write(
      `[pai-daemon] Index scheduler anchored to ${String(daemonConfig.maintenanceHour).padStart(2, "0")}:00 local ` +
        `(next pass in ${Math.round(firstDelayMs / 60_000)} min)\n`
    );
  }

  let timer: ReturnType<typeof setInterval>;
  const startTimer = () => {
    timer = setInterval(() => void cycle("Scheduled", true), intervalMs);
    if (timer.unref) timer.unref();
    setIndexSchedulerTimer(timer);
  };

  const first = setTimeout(() => {
    void cycle("Scheduled", true);
    startTimer();
  }, firstDelayMs);
  if (first.unref) first.unref();
}

/**
 * Milliseconds until the next occurrence of `hour`:00 local time.
 * Falls back to the plain interval when no anchor hour is configured.
 */
function msUntilNextAnchor(hour: number | undefined, intervalMs: number): number {
  if (hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return intervalMs;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// ---------------------------------------------------------------------------
// Embed scheduler
// ---------------------------------------------------------------------------

/**
 * Run an embedding pass for all unembedded chunks (Postgres backend only).
 */
export async function runEmbed(): Promise<void> {
  if (embedInProgress) {
    process.stderr.write("[pai-daemon] Embed already in progress, skipping.\n");
    return;
  }

  if (indexInProgress) {
    process.stderr.write("[pai-daemon] Index in progress, deferring embed pass.\n");
    return;
  }

  if (storageBackend.backendType !== "postgres") {
    return;
  }

  setEmbedInProgress(true);
  const t0 = Date.now();

  try {
    process.stderr.write("[pai-daemon] Starting scheduled embed pass...\n");

    const projectNames = new Map<number, string>();
    try {
      const rows = registryDb
        .prepare("SELECT id, slug FROM projects WHERE status = 'active'")
        .all() as Array<{ id: number; slug: string }>;
      for (const r of rows) projectNames.set(r.id, r.slug);
    } catch { /* registry unavailable — IDs will be used instead */ }

    const { embedChunksWithBackend } = await import("../../memory/indexer-backend.js");
    // Explicit budgets so one embed phase can never outlast an index cycle.
    // Backlogs drain across passes, not within one.
    const count = await embedChunksWithBackend(
      storageBackend,
      () => shutdownRequested,
      projectNames,
      // Indexing settles to a few chunks per pass once caught up, so the daemon
      // is idle most of the cycle and the embed budget is what actually sets
      // drain rate. Measured 450 chunks per 90s against real (long) chunks, so
      // a backlog only clears at roughly the budget's share of the cycle. What
      // broke the starvation was bounding the pass at all, not this number —
      // it can be raised freely as long as it stays finite.
      { maxMillis: 240_000 },
    );

    let vaultEmbedCount = 0;
    if (daemonConfig.vaultPath) {
      try {
        const { SQLiteBackend } = await import("../../storage/sqlite.js");
        const { openFederation } = await import("../../memory/db.js");
        const federationDb = openFederation();
        const vaultSqliteBackend = new SQLiteBackend(federationDb);

        const vaultProjectNames = new Map(projectNames);
        if (!vaultProjectNames.has(999)) {
          vaultProjectNames.set(999, "obsidian-vault");
        }

        vaultEmbedCount = await embedChunksWithBackend(
          vaultSqliteBackend,
          () => shutdownRequested,
          vaultProjectNames,
          { maxMillis: 45_000 },
        );

        try { federationDb.close(); } catch { /* ignore */ }

        if (vaultEmbedCount > 0) {
          process.stderr.write(
            `[pai-daemon] Vault embed pass complete: ${vaultEmbedCount} vault chunks embedded\n`
          );
        }
      } catch (ve) {
        const vmsg = ve instanceof Error ? ve.message : String(ve);
        process.stderr.write(`[pai-daemon] Vault embed error: ${vmsg}\n`);
      }
    }

    const elapsed = Date.now() - t0;
    setLastEmbedTime(Date.now());
    process.stderr.write(
      `[pai-daemon] Embed pass complete: ${count} postgres chunks + ${vaultEmbedCount} vault chunks embedded (${elapsed}ms)\n`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[pai-daemon] Embed error: ${msg}\n`);
  } finally {
    setEmbedInProgress(false);
  }
}

/**
 * Start the periodic embed scheduler. Initial run is 60 seconds after startup.
 */
export function startEmbedScheduler(): void {
  const intervalMs = daemonConfig.embedIntervalSecs * 1_000;

  process.stderr.write(
    `[pai-daemon] Embed scheduler: every ${daemonConfig.embedIntervalSecs}s\n`
  );

  // Startup embed pass — OFF unless explicitly enabled.
  //
  // This used to run unconditionally 60s after every start, ignoring
  // embedIntervalSecs entirely. With a large backlog that makes every restart a
  // CPU storm: the interval was set to a day to stop the machine being bogged
  // down, the daemon was restarted, and it immediately began a 240-second pass
  // anyway. Throttling the recurring timer while leaving this armed means the
  // throttle silently does nothing for anyone who restarts.
  //
  // Measured backlog when this was found: 1,868,098 unembedded chunks at ~5.7
  // chunks/s — about 91 days of work that a restart would resume unbidden.
  if (daemonConfig.embedOnStartup) {
    setTimeout(() => {
      runEmbed().catch((e) => {
        process.stderr.write(`[pai-daemon] Startup embed error: ${e}\n`);
      });
    }, 60_000);
  } else {
    process.stderr.write(
      "[pai-daemon] Startup embed pass skipped (embedOnStartup=false).\n"
    );
  }

  // With a maintenance hour configured the index cycle already chains an embed
  // pass onto every anchored run, so this timer would only add a second pass
  // that counts from daemon start — observed as "every 86400s" armed at a
  // 20:08 boot, i.e. a daily daytime pass on a machine configured for 03:00.
  // The interval says how often, never when; without an anchor it cannot
  // deliver a night-only pass, so it is not armed at all.
  if (daemonConfig.maintenanceHour !== undefined) {
    process.stderr.write(
      "[pai-daemon] Standalone embed timer not armed (maintenanceHour is set; " +
        "embed runs at the end of each anchored index cycle).\n"
    );
    return;
  }

  const timer = setInterval(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Scheduled embed error: ${e}\n`);
    });
  }, intervalMs);

  if (timer.unref) timer.unref();
  setEmbedSchedulerTimer(timer);
}

// ---------------------------------------------------------------------------
// Registry scan scheduler
// ---------------------------------------------------------------------------

const REGISTRY_SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REGISTRY_SCAN_STARTUP_DELAY_MS = 10_000;     // 10 seconds after daemon start

/**
 * Start the periodic registry scan scheduler.
 * First scan runs 10 seconds after startup (enough time for IPC to stabilise).
 * Subsequent scans run every 30 minutes.
 * Uses the work-queue so the scan runs on the worker thread without blocking IPC.
 */
export function startRegistryScanScheduler(): void {
  process.stderr.write(
    "[pai-daemon] Registry scan scheduler: every 30min (first in 10s)\n"
  );

  setTimeout(() => {
    import("../../daemon/work-queue-worker.js")
      .then(({ enqueueRegistryScan }) => enqueueRegistryScan())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Startup registry scan error: ${e}\n`);
      });
  }, REGISTRY_SCAN_STARTUP_DELAY_MS);

  const timer = setInterval(() => {
    import("../../daemon/work-queue-worker.js")
      .then(({ enqueueRegistryScan }) => enqueueRegistryScan())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Scheduled registry scan error: ${e}\n`);
      });
  }, REGISTRY_SCAN_INTERVAL_MS);

  if (timer.unref) timer.unref();
}

// ---------------------------------------------------------------------------
// Worker supervision scheduler
// ---------------------------------------------------------------------------

/** How often the daemon looks at the worker ledger for supervision events. */
const SUPERVISION_TICK_MS = 30_000;

/** First supervision pass waits for the first statuses to exist at all. */
const SUPERVISION_STARTUP_DELAY_MS = 15_000;

/**
 * Start the worker supervisor: one tick every 30 s over the workers ledger
 * (src/workers/supervision.ts) that pushes finished/failed/stalled events to
 * the owning session — the daemon-side replacement for orchestrator polling.
 * Daemon code only: no model call has any business being here, and none is
 * made. Disabled workers disable the supervisor with it.
 */
export function startWorkerSupervisor(): void {
  let enabled = false;
  try {
    enabled = readWorkersSection().workers.enabled;
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Worker supervisor: not started (${e instanceof Error ? e.message : String(e)})\n`
    );
    return;
  }
  if (!enabled) {
    process.stderr.write("[pai-daemon] Worker supervisor: disabled (workers are off)\n");
    return;
  }

  const tick = () => {
    runSupervisionTick(workersLogDir(readWorkersSection().workers), {
      stallMs: stallMinutesFromEnv() * 60_000,
    })
      .then((r) => {
        for (const ev of r.events) {
          process.stderr.write(`[pai-daemon] Supervision: ${ev.text}\n`);
        }
      })
      .catch((e) => {
        // a broken tick must never take the daemon down with it
        process.stderr.write(
          `[pai-daemon] Supervision tick error: ${e instanceof Error ? e.message : String(e)}\n`
        );
      });
  };

  const first = setTimeout(tick, SUPERVISION_STARTUP_DELAY_MS);
  if (first.unref) first.unref();
  const timer = setInterval(tick, SUPERVISION_TICK_MS);
  if (timer.unref) timer.unref();
  process.stderr.write(
    `[pai-daemon] Worker supervisor: every ${Math.round(SUPERVISION_TICK_MS / 1000)}s\n`
  );
}

// ---------------------------------------------------------------------------
// Worker prompt-cache keepalive scheduler
// ---------------------------------------------------------------------------

/** First beat waits a while after boot; the daemon start is itself a warm request. */
const KEEPALIVE_STARTUP_DELAY_MS = 60_000;

/**
 * Start the cache keepalive: every workers.cacheKeepaliveSecs one trivial
 * single-turn worker (src/workers/keepalive.ts) re-arms the provider's
 * implicit prompt cache so real worker spawns start warm. Needs no storage
 * backend — it starts with the IPC server, not after the federation connect.
 * 0 (or workers off) keeps it off. A failed beat is logged and swallowed.
 */
export function startCacheKeepalive(opts: {
  configPath?: string;
  beat?: () => Promise<BeatMetrics | null>;
} = {}): void {
  let workers: ReturnType<typeof readWorkersSection>["workers"];
  try {
    workers = readWorkersSection(opts.configPath).workers;
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Cache keepalive: not started (${e instanceof Error ? e.message : String(e)})\n`
    );
    return;
  }
  if (!workers.enabled) {
    process.stderr.write("[pai-daemon] Cache keepalive: disabled (workers are off)\n");
    return;
  }
  const secs = keepaliveSecs(workers);
  if (!secs) {
    process.stderr.write("[pai-daemon] Cache keepalive: disabled (cacheKeepaliveSecs is 0)\n");
    return;
  }

  let notedNoPostgres = false;
  const sqliteNote = () => {
    const pool = (storageBackend as PostgresBackendWithPool | undefined)?.getPool?.();
    if (pool) return pool;
    if (!notedNoPostgres) {
      notedNoPostgres = true;
      process.stderr.write(
        "[pai-daemon] Cache keepalive: observation rows need Postgres — ledger line only\n"
      );
    }
    return null;
  };

  const beat = async (): Promise<void> => {
    const m = await (opts.beat ?? runKeepaliveBeat)();
    if (!m) return; // overlap guard: previous beat still running
    const pool = sqliteNote();
    if (!pool) return; // ledger line already written by the beat itself
    try {
      await storeObservationWithProject(registryDb, pool, {
        session_id: m.id,
        type: "change",
        title: `cache keepalive ${m.ok ? "ok" : "failed"} (cache_read=${m.cache_read_input_tokens}, api_ms=${m.duration_api_ms})`,
        tool_name: "cache-keepalive",
        narrative: `beat ${m.id}: input=${m.input_tokens} cache_read=${m.cache_read_input_tokens} cache_creation=${m.cache_creation_input_tokens} duration_api_ms=${m.duration_api_ms}`,
        tool_input_summary: undefined,
        files_read: [],
        files_modified: [],
        concepts: [],
      });
    } catch (e) {
      // a failed observation must never fail the beat
      process.stderr.write(
        `[pai-daemon] Cache keepalive observation error: ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
  };

  const first = setTimeout(() => {
    beat().catch((e) => {
      process.stderr.write(
        `[pai-daemon] Cache keepalive beat error: ${e instanceof Error ? e.message : String(e)}\n`
      );
    });
  }, KEEPALIVE_STARTUP_DELAY_MS);
  if (first.unref) first.unref();

  const timer = setInterval(() => {
    beat().catch((e) => {
      process.stderr.write(
        `[pai-daemon] Cache keepalive beat error: ${e instanceof Error ? e.message : String(e)}\n`
      );
    });
  }, secs * 1000);
  if (timer.unref) timer.unref();
  setCacheKeepaliveTimer(timer);
  process.stderr.write(`[pai-daemon] Cache keepalive: every ${secs}s\n`);
}

// ---------------------------------------------------------------------------
// Interactive-session prompt-cache keepalive scheduler
// ---------------------------------------------------------------------------

/** Tick cadence: coarse enough to be cheap, fine enough that a session
 *  crossing idleMinutes gets beaten within a minute of becoming eligible. */
const SESSION_KEEPALIVE_TICK_MS = 60_000;

/**
 * Start the interactive-session cache keepalive: every 60s, beat every live
 * session that has gone idle past `sessions.cacheKeepalive.idleMinutes`
 * (src/daemon/session-keepalive.ts). Off unless
 * `sessions.cacheKeepalive.enabled` is true — no hot-reload, matching
 * startCacheKeepalive above: config changes need a daemon restart.
 */
export function startSessionKeepalive(): void {
  const config = daemonConfig.sessions.cacheKeepalive;
  if (!config.enabled) {
    process.stderr.write("[pai-daemon] Session keepalive: disabled (sessions.cacheKeepalive.enabled is false)\n");
    return;
  }

  const tick = () => {
    runSessionKeepaliveTick(config).catch((e) => {
      process.stderr.write(
        `[pai-daemon] Session keepalive tick error: ${e instanceof Error ? e.message : String(e)}\n`
      );
    });
  };

  const timer = setInterval(tick, SESSION_KEEPALIVE_TICK_MS);
  if (timer.unref) timer.unref();
  process.stderr.write(
    `[pai-daemon] Session keepalive: every ${SESSION_KEEPALIVE_TICK_MS / 1000}s ` +
      `(idle >= ${config.idleMinutes}min, hours ${config.activeHours}, max ${config.maxBeats} beats/stretch)\n`
  );
}
