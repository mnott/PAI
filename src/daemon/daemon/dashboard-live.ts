/**
 * Wires the status dashboard to the daemon's live state (state.ts, scheduler
 * bookkeeping) and the configured embedding backend.
 */

import { readFileSync } from "node:fs";
import { resolveFromModule } from "../../module-paths.js";
import { getConfiguredBackend } from "../../memory/backends/index.js";
import { liveSource, startDashboardState, type DashboardState, type PassSnapshot } from "../dashboard.js";
import { defaults, type PaiDaemonConfig } from "../config.js";
import {
  daemonConfig,
  embedInProgress,
  indexInProgress,
  lastEmbedTime,
  lastEmbedPass,
  lastIndexPass,
  lastIndexTime,
  lastVaultIndexTime,
  passFailures,
  startTime,
  vaultIndexInProgress,
  storageBackend,
} from "./state.js";
import { Snapshot } from "../memory-snapshot.js";
import type { StorageBackend } from "../../storage/interface.js";
import { PASS_RETRY_DELAYS_MS, msUntilNextAnchor } from "./scheduler.js";

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(resolveFromModule(import.meta.url, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The index/embed/vault passes as the dashboard shows them, from the existing daemon state. */
export function livePasses(now = Date.now()): PassSnapshot[] {
  const cfg = daemonConfig;
  const next = (last: number, intervalSecs: number): number =>
    cfg.maintenanceHour !== undefined
      ? now + msUntilNextAnchor(cfg.maintenanceHour, intervalSecs * 1000)
      : (last || now) + intervalSecs * 1000;
  const snap = (name: string, running: boolean, lastEnd: number, nextAt: number | null): PassSnapshot => {
    const f = passFailures.get(name);
    const delay = f ? PASS_RETRY_DELAYS_MS[f.attempts - 1] : undefined;
    return {
      name,
      running,
      lastEnd,
      failure: f ? { ...f, retryAt: f.gaveUp || delay === undefined ? null : f.at + delay } : null,
      nextAt,
    };
  };
  return [
    snap("index", indexInProgress, lastIndexTime, next(lastIndexTime, cfg.indexIntervalSecs)),
    snap("embed", embedInProgress, lastEmbedTime, next(lastEmbedTime, cfg.embedIntervalSecs)),
    // The vault pass runs inside the index cycle, so it has no schedule of its own.
    snap("vault", vaultIndexInProgress, lastVaultIndexTime, null),
  ];
}

let live: { state: DashboardState; stop(): void } | null = null;

/** Start sampling the memory status for the cockpit; a failure is logged, never fatal for the daemon. */
export async function startMemoryStatus(config: PaiDaemonConfig): Promise<void> {
  try {
    live = await startDashboardState(
      liveSource({
        storage: storageBackend,
        backend: () => getConfiguredBackend(config),
        ollamaBaseUrl: config.embedding?.ollama?.baseUrl ?? defaults().embedding.ollama.baseUrl,
        daemon: () => ({ pid: process.pid, startTime, version: packageVersion() }),
        passes: livePasses,
      }),
    );
  } catch (e) {
    process.stderr.write(`[pai-daemon] Memory status not started: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export function stopMemoryStatus(): void {
  live?.stop();
  live = null;
}

const BACKLOG_TTL_MS = 60_000;
let backlogSnap: { storage: StorageBackend; snap: Snapshot<number> } | null = null;

/**
 * The unembedded-chunk backlog for the cockpit: one COUNT(*) per TTL shared by every request
 * (single-flight), the last good value when it fails. Per-request counts over pai_chunks
 * held the whole Postgres pool under several polling tabs.
 */
export async function memoryBacklog(storage: StorageBackend | null | undefined): Promise<number | null> {
  if (!storage) return null;
  if (!backlogSnap || backlogSnap.storage !== storage) {
    backlogSnap = { storage, snap: new Snapshot(() => storage.countUnembeddedChunks(), BACKLOG_TTL_MS) };
  }
  return backlogSnap.snap.get();
}

/** The IPC `memory_dashboard` answer: the sampled status plus the pass records the cockpit's Memory section shows. */
export function memoryDashboard(backlog: number | null): Record<string, unknown> {
  return {
    status: live ? live.state.status() : null,
    embedBacklog: backlog,
    maintenanceHour: daemonConfig.maintenanceHour ?? null,
    indexIntervalSecs: daemonConfig.indexIntervalSecs,
    embedIntervalSecs: daemonConfig.embedIntervalSecs,
    embedMaxMinutes: daemonConfig.embedMaxMinutes ?? null,
    lastIndexPass,
    lastEmbedPass,
  };
}
