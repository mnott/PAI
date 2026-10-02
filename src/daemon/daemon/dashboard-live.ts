/**
 * Wires the status dashboard to the daemon's live state (state.ts, scheduler
 * bookkeeping) and the configured embedding backend.
 */

import { readFileSync } from "node:fs";
import { resolveFromModule } from "../../module-paths.js";
import { getConfiguredBackend } from "../../memory/backends/index.js";
import { liveSource, startDashboard, type DashboardHandle, type PassSnapshot } from "../dashboard.js";
import type { PaiDaemonConfig } from "../config.js";
import {
  daemonConfig,
  embedInProgress,
  indexInProgress,
  lastEmbedTime,
  lastIndexTime,
  lastVaultIndexTime,
  passFailures,
  startTime,
  vaultIndexInProgress,
  storageBackend,
} from "./state.js";
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

/** Start the dashboard when enabled; a failure to bind is logged, never fatal for the daemon. */
export async function startLiveDashboard(config: PaiDaemonConfig): Promise<DashboardHandle | null> {
  if (!config.dashboard.enabled) return null;
  try {
    const handle = await startDashboard(
      config.dashboard,
      liveSource({
        storage: storageBackend,
        backend: () => getConfiguredBackend(config),
        ollamaBaseUrl: config.embedding?.ollama?.baseUrl ?? "http://127.0.0.1:11434",
        daemon: () => ({ pid: process.pid, startTime, version: packageVersion() }),
        passes: livePasses,
      }),
    );
    process.stderr.write(`[pai-daemon] Dashboard: ${handle.url}\n`);
    return handle;
  } catch (e) {
    process.stderr.write(`[pai-daemon] Dashboard not started: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}
