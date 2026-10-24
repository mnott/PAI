/**
 * Embed-pass policy: time budget, yield rules and the record of the last pass.
 *
 * An embed pass over a multi-million chunk backlog is hours of CPU. It runs
 * under a wall-clock budget (embedMaxMinutes), at low priority, and steps aside
 * while a local-model worker holds the machine or the load average is high.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../config/atomic-file.js";
import { loadavg } from "node:os";
import { paiHomePath } from "../config/pai-home.js";
import { isLocalProvider, readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { loadStatuses, isLive } from "../workers/status.js";

export const DEFAULT_EMBED_MAX_MINUTES = 60;
export const DEFAULT_EMBED_MAX_LOAD = 8;
/** Modest batch: small enough that a budget or yield check lands within seconds. */
export const EMBED_PASS_BATCH_SIZE = 25;

export type EmbedPassOutcome = "done" | "budget" | "yielded" | "failed";

export interface EmbedPassRecord {
  /** Epoch ms the pass ended. */
  at: number;
  outcome: EmbedPassOutcome;
  embedded: number;
  /** How long the pass ran (ms); absent on records from before this was kept. */
  durationMs?: number;
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
  failed: "failed",
};

/** The `pai daemon status` lines for the embed backlog and the last pass. */
export function formatEmbedStatus(s: {
  embedBacklog?: number | null;
  lastEmbedPass?: { at: string; outcome: EmbedPassOutcome; embedded: number; reason?: string } | null;
  /** From the persisted pass log, so it survives a daemon restart. */
  recordedPass?: EmbedPassLogEntry | null;
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
  const r = s.recordedPass;
  if (r) {
    const mins = Math.round((r.end - r.start) / 60_000);
    lines.push(
      `Embed pass:  ${new Date(r.end).toISOString()} ${r.embedded} embedded in ${mins} min, ` +
        `${r.backlogLeft ?? "?"} left, stopped: ${r.stopReason}${r.detail ? ` (${r.detail})` : ""}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Nightly cycle: keep embedding until the backlog is gone or the window closes
// ---------------------------------------------------------------------------

/** Total wall-clock window of one anchored cycle's embed phase. A single pass
 *  (embedMaxMinutes) is only a slice of it: at ~5 chunks/s a 60 minute pass
 *  clears ~18k chunks, less than a busy day adds, so one pass per night
 *  never caught up. */
export const DEFAULT_EMBED_CYCLE_MAX_MINUTES = 300;
/** How long to wait before retrying after a pass yielded to load or a local worker. */
export const DEFAULT_EMBED_RESUME_MINUTES = 10;

export type EmbedStopReason =
  | "done"          // backlog empty
  | "pass-budget"   // one pass hit embedMaxMinutes (the cycle continues)
  | "cycle-budget"  // embedCycleMaxMinutes spent, backlog remains
  | "yielded"       // load / local worker (the cycle waits and retries)
  | "no-progress"   // a pass embedded nothing and did not yield: stop, do not spin
  | "error"
  | "shutdown";

/** One embed pass as persisted for `pai daemon status` and the cockpit. */
export interface EmbedPassLogEntry {
  start: number;
  end: number;
  embedded: number;
  /** Chunks still without vectors after the pass; null when the count failed. */
  backlogLeft: number | null;
  stopReason: EmbedStopReason;
  /** Detail for yielded / error. */
  detail?: string;
}

const MAX_LOGGED_PASSES = 200;

/** Small state file under the PAI home holding the most recent passes, oldest first. */
export function embedPassLogPath(): string {
  return paiHomePath("embed-passes.json");
}

export function recordEmbedPass(entry: EmbedPassLogEntry, path = embedPassLogPath()): void {
  try {
    const all = readEmbedPasses(path);
    all.push(entry);
    writeFileAtomic(path, JSON.stringify(all.slice(-MAX_LOGGED_PASSES)) + "\n");
  } catch { /* the record is informational; never fail a pass over it */ }
}

/** Recorded passes, oldest first. For the cockpit Memory section and `pai daemon status`. */
export function readEmbedPasses(path = embedPassLogPath()): EmbedPassLogEntry[] {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(v) ? (v as EmbedPassLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** The most recent recorded pass, or null. */
export function lastRecordedEmbedPass(path = embedPassLogPath()): EmbedPassLogEntry | null {
  const all = readEmbedPasses(path);
  return all.length ? all[all.length - 1] : null;
}

export interface EmbedCycleDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Run one pass; it records itself. Returns null when it did not run. */
  runPass: () => Promise<EmbedPassLogEntry | null>;
  cycleMaxMinutes: number;
  resumeMinutes: number;
  shutdown?: () => boolean;
}

/**
 * Drive embed passes until the backlog is empty or the cycle window closes.
 * A pass budget stop continues immediately; a yield waits resumeMinutes and
 * resumes (the backlog is the cursor, so resuming is just running again).
 */
export async function runEmbedCycle(d: EmbedCycleDeps): Promise<{ passes: number; embedded: number; stopReason: EmbedStopReason }> {
  const deadline = d.now() + d.cycleMaxMinutes * 60_000;
  let passes = 0;
  let embedded = 0;
  for (;;) {
    if (d.shutdown?.()) return { passes, embedded, stopReason: "shutdown" };
    if (d.now() >= deadline) return { passes, embedded, stopReason: "cycle-budget" };
    const r = await d.runPass();
    if (!r) return { passes, embedded, stopReason: passes ? "no-progress" : "error" };
    passes++;
    embedded += r.embedded;
    if (r.stopReason === "done" || r.backlogLeft === 0) return { passes, embedded, stopReason: "done" };
    if (r.stopReason === "error") return { passes, embedded, stopReason: "error" };
    if (r.stopReason === "yielded") {
      const wait = d.resumeMinutes * 60_000;
      if (d.now() + wait >= deadline) return { passes, embedded, stopReason: "cycle-budget" };
      await d.sleep(wait);
      continue;
    }
    if (r.embedded === 0) return { passes, embedded, stopReason: "no-progress" };
  }
}
