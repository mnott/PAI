/**
 * IPC server and daemon entry point.
 * Owns: isSocketLive, startIpcServer, serve (exported).
 */

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, connect, Socket, Server } from "node:net";
import { setPriority } from "node:os";
import { createStorageBackend, createRegistryBackend } from "../../storage/factory.js";
import { configureEmbeddingModel } from "../../memory/embeddings.js";
import { loadNotificationConfig } from "../../notifications/config.js";
import { writeDaemonPidfile, removeDaemonPidfile } from "../daemon-pid.js";
import { logWorkersConfigShadowsOnce } from "../../workers/config-shadow.js";
import type { PaiDaemonConfig } from "../config.js";
import type { IpcRequest } from "./types.js";
import {
  setRegistryBackend,
  setStorageBackend,
  setDaemonConfig,
  setStartTime,
  setNotificationConfig,
  setShutdownRequested,
  inflightRequests,
  trackRequest,
  indexInProgress,
  embedInProgress,
  indexSchedulerTimer,
  embedSchedulerTimer,
  cacheKeepaliveTimer,
  storageBackend,
  notificationConfig,
} from "./state.js";
import { registerQuietRunner, startQuietWatcher } from "../quiet.js";
import { triggerRegistryScan } from "../registry-scan-trigger.js";
import { backfillKgFromNotes } from "../../memory/kg-backfill.js";
import { runObsidianSyncIfDue, startObsidianSyncScheduler } from "../obsidian-sync.js";
import { interruptStaleJobs } from "../../router/cockpit-job-recovery.js";
import { paiHomeDir } from "../../config/pai-home.js";
import { startOrphanCheck } from "../orphan-check.js";
import { quietRunners, startIndexScheduler, startEmbedScheduler, startRegistryScanScheduler, startWorkerSupervisor, startCacheKeepalive, startSessionKeepalive, startRouterSupervisor, startDistWatch } from "./scheduler.js";
import { startLocalStatusRefresh } from "../../workers/local-provider.js";
import { startInventoryRefresh } from "../../workers/model-inventory.js";
import { handleRequest, sendResponse } from "./handler.js";
import { loadQueue } from "../../daemon/work-queue.js";
import { startWorker, stopWorker } from "../../daemon/work-queue-worker.js";
import { startMemoryStatus, stopMemoryStatus } from "./dashboard-live.js";
import { batteryGuardTimer, registryBackend } from "./state.js";
import { startBatteryGuard } from "./scheduler.js";
import { migrateFtsConfig } from "../../storage/postgres/fts-migration.js";

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an existing socket file is actually being served by a live process.
 */
function isSocketLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(path);
    const timer = setTimeout(() => { client.destroy(); resolve(false); }, 500);
    client.on("connect", () => { clearTimeout(timer); client.end(); resolve(true); });
    client.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** Longest accepted IPC request line; a client exceeding it is disconnected. */
const MAX_IPC_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Start the Unix Domain Socket IPC server.
 */
async function startIpcServer(socketPath: string): Promise<Server> {
  if (existsSync(socketPath)) {
    const live = await isSocketLive(socketPath);
    if (live) {
      throw new Error("Another daemon is already running — socket is live. Aborting startup.");
    }
    try {
      unlinkSync(socketPath);
      process.stderr.write("[pai-daemon] Removed stale socket file.\n");
    } catch {
      // If we can't remove it, bind will fail with a clear error
    }
  }

  const server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_IPC_LINE_BYTES && buffer.indexOf("\n") === -1) {
        sendResponse(socket, { id: "?", ok: false, error: "Request line too long" });
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        if (line.trim() === "") continue;

        let request: IpcRequest;
        try {
          request = JSON.parse(line) as IpcRequest;
        } catch {
          sendResponse(socket, { id: "?", ok: false, error: "Invalid JSON" });
          socket.destroy();
          return;
        }

        trackRequest(handleRequest(request, socket)).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          sendResponse(socket, { id: request.id, ok: false, error: msg });
          socket.destroy();
        });
      }
    });

    socket.on("error", () => {
      // Client disconnected — nothing to do
    });
  });

  server.on("error", (e) => {
    process.stderr.write(`[pai-daemon] IPC server error: ${e}\n`);
  });

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch (e) {
      process.stderr.write(`[pai-daemon] Could not chmod socket: ${e}\n`);
    }
    process.stderr.write(
      `[pai-daemon] IPC server listening on ${socketPath}\n`
    );
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main daemon entry point
// ---------------------------------------------------------------------------

export async function serve(config: PaiDaemonConfig): Promise<void> {
  setDaemonConfig(config);
  setStartTime(Date.now());

  setNotificationConfig(loadNotificationConfig());

  process.stderr.write("[pai-daemon] Starting daemon...\n");
  process.stderr.write(`[pai-daemon] Socket: ${config.socketPath}\n`);
  process.stderr.write(`[pai-daemon] Storage backend: ${config.storageBackend}\n`);
  process.stderr.write(
    `[pai-daemon] Notification mode: ${notificationConfig.mode}\n`
  );

  logWorkersConfigShadowsOnce();

  // Lower scheduling priority so the daemon yields CPU to interactive sessions
  try { setPriority(process.pid, 10); } catch { /* non-fatal */ }

  configureEmbeddingModel(config.embeddingModel);

  // Connect the registry backend in the background — non-blocking, since it
  // may take a few retries under Postgres (waitForPostgres: true never
  // silently falls back to SQLite, matching the federation backend below).
  // Callers that need it before it resolves (status, observation IPC methods)
  // already tolerate an unready backend via their own try/catch.
  void createRegistryBackend(config, { waitForPostgres: true })
    .then((backend) => {
      setRegistryBackend(backend);
      process.stderr.write(`[pai-daemon] Registry backend: ${backend.backendType}\n`);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[pai-daemon] Fatal: Could not open registry: ${msg}\n`);
      process.exit(1);
    });

  // Start the IPC server immediately so `pai daemon status` answers even while
  // we are still waiting for the federation backend (e.g. Postgres coming up
  // after a reboot). The status handler tolerates a not-yet-ready backend.
  const server = await startIpcServer(config.socketPath);

  // Quiet mode: what runs, once per deferred kind, when quiet ends.
  for (const [kind, run] of Object.entries(quietRunners())) registerQuietRunner(kind as keyof ReturnType<typeof quietRunners>, run);
  registerQuietRunner("registry-scan", () => void triggerRegistryScan());
  registerQuietRunner("triple-extraction", async () => void (await backfillKgFromNotes()));
  registerQuietRunner("obsidian-sync", async () => void (await runObsidianSyncIfDue()));
  startObsidianSyncScheduler(config.obsidianSyncIntervalSecs);
  startQuietWatcher();

  // Registry scan scheduler only needs the registry DB — safe to start now.
  startRegistryScanScheduler();
  startOrphanCheck(() => registryBackend.countOrphanedChunks());

  // Worker supervision reads the workers ledger off disk and pushes events to
  // owning sessions — no backend dependency, so it starts with the IPC server.
  startWorkerSupervisor();
  // The one answer to "which local model is running" (sessions read it, never probe).
  startLocalStatusRefresh();
  // Every local model runtime, its models and users (`pai models`, cockpit LOCAL).
  startInventoryRefresh();

  // Cache keepalive spawns trivial workers on the workers config — also no
  // backend dependency (observations store opportunistically when Postgres
  // is up), so it starts with the IPC server too.
  startCacheKeepalive();

  // Interactive-session cache keepalive: also no backend dependency (reads
  // AIBroker + transcript files, writes the workers ledger + its own state
  // file), so it starts with the IPC server too.
  startSessionKeepalive();

  // Battery guard: pmset readings drive the local-work pause/stop (macOS only).
  startBatteryGuard();

  // Model router: restart it whenever its port stops answering (opt-in).
  startRouterSupervisor();

  // Cockpit jobs the previous daemon (or its router) was running died with it: say so, never resume.
  try {
    const cut = interruptStaleJobs(paiHomeDir(), Date.now());
    if (cut.length) process.stderr.write(`[pai-daemon] Cockpit jobs interrupted by the restart: ${cut.join(", ")}\n`);
  } catch (e) {
    process.stderr.write(`[pai-daemon] Cockpit job recovery failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Restart onto a new build when dist changes under us.
  startDistWatch();

  // Connect the federation backend in the background. When storageBackend is
  // "postgres" this retries forever (never silently falls back to SQLite), so
  // the boot race with Docker/Postgres resolves itself once Postgres is up.
  // Only then do we start the federation-dependent schedulers and work queue —
  // this also keeps the first index run from firing against an unready backend.
  void createStorageBackend(config, { waitForPostgres: true })
    .then((backend) => {
      setStorageBackend(backend);
      process.stderr.write(
        `[pai-daemon] Federation backend: ${backend.backendType}\n`
      );

      startIndexScheduler();

      void startMemoryStatus(config);

      if (backend.supportsPostgresFeatures) {
        startEmbedScheduler();

        // Repair fts_vector rows written under the old ('english') trigger.
        // Async, non-blocking: real tables hold millions of rows, and a
        // rebuild must never delay daemon startup. Idempotent — safe to
        // resume from scratch if interrupted (see fts-migration.ts).
        void migrateFtsConfig(backend).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[pai-daemon] FTS config migration failed: ${msg}\n`);
        });
      } else {
        process.stderr.write(
          "[pai-daemon] Embed scheduler: disabled (SQLite backend)\n"
        );
      }

      // Work queue — load persisted items and start worker loop
      loadQueue();
      startWorker();
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[pai-daemon] Fatal: Could not open federation storage: ${msg}\n`
      );
      process.exit(1);
    });

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[pai-daemon] ${signal} received. Stopping.\n`);

    setShutdownRequested(true);

    if (indexSchedulerTimer) clearInterval(indexSchedulerTimer);
    if (embedSchedulerTimer) clearInterval(embedSchedulerTimer);
    if (cacheKeepaliveTimer) clearInterval(cacheKeepaliveTimer);
    if (batteryGuardTimer) clearInterval(batteryGuardTimer);

    stopWorker();

    stopMemoryStatus();
    server.close();
    // Stop advertising the socket now: new clients get a refusal they can
    // retry against the next daemon, not a half-closed backend.
    try { unlinkSync(config.socketPath); } catch { /* already gone */ }

    const SHUTDOWN_TIMEOUT_MS = 10_000;
    const POLL_INTERVAL_MS = 100;
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;

    if (indexInProgress || embedInProgress || inflightRequests > 0) {
      process.stderr.write(
        `[pai-daemon] Waiting for in-progress operations to finish ` +
          `(index=${indexInProgress}, embed=${embedInProgress}, requests=${inflightRequests})...\n`
      );

      while ((indexInProgress || embedInProgress || inflightRequests > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (indexInProgress || embedInProgress || inflightRequests > 0) {
        process.stderr.write("[pai-daemon] Shutdown timeout reached — forcing exit.\n");
      } else {
        process.stderr.write("[pai-daemon] In-progress operations finished.\n");
      }
    }

    try {
      await storageBackend.close();
    } catch {
      // ignore
    }

    try {
      unlinkSync(config.socketPath);
    } catch {
      // ignore
    }

    removeDaemonPidfile();
    process.exit(0);
  };

  writeDaemonPidfile();
  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(0)); });

  // Keep process alive
  await new Promise(() => {});
}
