/**
 * Index, embed, and vault index schedulers for the PAI daemon.
 * Exports run* functions (also called on-demand by the IPC handler)
 * and the start* functions invoked once at daemon startup.
 */

import { indexAll } from "../../memory/indexer.js";
import type { SQLiteBackendWithDb } from "./types.js";
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

  setTimeout(() => {
    runIndex()
      .then(() => runVaultIndex())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Startup index error: ${e}\n`);
      });
  }, 2_000);

  const timer = setInterval(() => {
    runIndex()
      .then(() => runVaultIndex())
      .catch((e) => {
        process.stderr.write(`[pai-daemon] Scheduled index error: ${e}\n`);
      });
  }, intervalMs);

  if (timer.unref) timer.unref();
  setIndexSchedulerTimer(timer);
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
    const count = await embedChunksWithBackend(storageBackend, () => shutdownRequested, projectNames);

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

  setTimeout(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Startup embed error: ${e}\n`);
    });
  }, 60_000);

  const timer = setInterval(() => {
    runEmbed().catch((e) => {
      process.stderr.write(`[pai-daemon] Scheduled embed error: ${e}\n`);
    });
  }, intervalMs);

  if (timer.unref) timer.unref();
  setEmbedSchedulerTimer(timer);
}
