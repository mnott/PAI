/**
 * Embed-pass policy: time budget, yield rules and the record of the last pass.
 *
 * An embed pass over a multi-million chunk backlog is hours of CPU. It runs
 * under a wall-clock budget (embedMaxMinutes), at low priority, and steps aside
 * while a local-model worker holds the machine or the load average is high.
 */

import { loadavg } from "node:os";
import { isLocalProvider, readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { loadStatuses, isLive } from "../workers/status.js";

export const DEFAULT_EMBED_MAX_MINUTES = 60;
export const DEFAULT_EMBED_MAX_LOAD = 8;
/** Modest batch: small enough that a budget or yield check lands within seconds. */
export const EMBED_PASS_BATCH_SIZE = 25;

export type EmbedPassOutcome = "done" | "budget" | "yielded";

export interface EmbedPassRecord {
  /** Epoch ms the pass ended. */
  at: number;
  outcome: EmbedPassOutcome;
  embedded: number;
  /** Why it yielded (outcome "yielded" only). */
  reason?: string;
}

/** True when a running or queued worker uses a provider on this machine. */
export function localWorkerBusy(
  logDir: string,
  providers: Record<string, { baseUrl: string }>,
): boolean {
  try {
    return loadStatuses(logDir).some((s) => {
      const p = providers[s.provider];
      return s.state === "running" && !!p && isLocalProvider(p.baseUrl) && isLive(s);
    });
  } catch {
    return false;
  }
}

/** Reason to hold the pass back right now, or null to go ahead. */
export function embedYieldReason(o: {
  load: number;
  maxLoad: number;
  localBusy: boolean;
}): string | null {
  if (o.localBusy) return "local-model worker running";
  if (o.load > o.maxLoad) return `load average ${o.load.toFixed(1)} above ${o.maxLoad}`;
  return null;
}

/** The live yield check for a pass: reads the load average and the worker statuses. */
export function liveYieldCheck(maxLoad: number): () => string | null {
  return () => {
    let logDir = "";
    let providers: Record<string, { baseUrl: string }> = {};
    try {
      const { workers } = readWorkersSection();
      logDir = workersLogDir(workers);
      providers = workers.providers ?? {};
    } catch { /* no workers config: nothing local to yield to */ }
    return embedYieldReason({
      load: loadavg()[0],
      maxLoad,
      localBusy: logDir ? localWorkerBusy(logDir, providers) : false,
    });
  };
}

const OUTCOME_TEXT: Record<EmbedPassOutcome, string> = {
  done: "done",
  budget: "budget hit",
  yielded: "yielded",
};

/** The `pai daemon status` lines for the embed backlog and the last pass. */
export function formatEmbedStatus(s: {
  embedBacklog?: number | null;
  lastEmbedPass?: { at: string; outcome: EmbedPassOutcome; embedded: number; reason?: string } | null;
}): string[] {
  const lines: string[] = [];
  if (typeof s.embedBacklog === "number") {
    lines.push(`Embed:       ${s.embedBacklog} chunks without vectors`);
  }
  const p = s.lastEmbedPass;
  if (p) {
    lines.push(
      `Last embed:  ${OUTCOME_TEXT[p.outcome]}, ${p.embedded} chunks at ${p.at}${p.reason ? ` (${p.reason})` : ""}`,
    );
  }
  return lines;
}
