/**
 * Start gate: runs starting together on one provider all prefill the same
 * prefix (system prompt, tool definitions, shared spec text) at once, so none
 * hits another's cache fill. A run waits for its immediate predecessor on the
 * same provider to receive its first model response (status.turns >= 1) or
 * for a limit learned from that provider's recent first-response times, then
 * starts. Queued runs release one at a time: run k waits for run k-1 only.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, isLive, loadStatuses, type WorkerStatus } from "./status.js";

export interface StaggerConfig {
  enabled: boolean;
  /** Limit without history, per provider kind (seconds). */
  localDefaultSec: number;
  remoteDefaultSec: number;
  /** Clamp of the learned limit (seconds). */
  minSec: number;
  maxSec: number;
}

export const WARMUP_WINDOW = 20;
const POLL_STEPS_MS = [250, 500, 1000, 2000];

/** Poll interval after `n` checks: 250, 500, 1000, 2000, then 2000 ms. */
export function backoffMs(n: number): number {
  return POLL_STEPS_MS[Math.min(n, POLL_STEPS_MS.length - 1)];
}

// --- per-provider first-response history (spawn → first assistant message) ---

const historyPath = (logDir: string) => join(logDir, "warmup-history.json");

export function loadWarmupHistory(logDir: string): Record<string, number[]> {
  try {
    const raw = JSON.parse(readFileSync(historyPath(logDir), "utf8")) as Record<string, unknown>;
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v.filter((n): n is number => typeof n === "number" && n >= 0);
    }
    return out;
  } catch {
    return {};
  }
}

/** Append one first-response time (seconds), keeping the last WARMUP_WINDOW. */
export function recordWarmup(logDir: string, provider: string, secs: number): void {
  try {
    const all = loadWarmupHistory(logDir);
    all[provider] = [...(all[provider] ?? []), Math.round(secs * 10) / 10].slice(-WARMUP_WINDOW);
    const tmp = `${historyPath(logDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all));
    renameSync(tmp, historyPath(logDir));
  } catch {
    /* history is advisory */
  }
}

/** clamp(p75 of recent first-response times x 1.5, min, max); the per-kind default without history. */
export function warmupLimitSec(history: number[] | undefined, local: boolean, cfg: StaggerConfig): number {
  if (!history || history.length === 0) return local ? cfg.localDefaultSec : cfg.remoteDefaultSec;
  const sorted = [...history].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)];
  return Math.min(cfg.maxSec, Math.max(cfg.minSec, p75 * 1.5));
}

// --- the gate ---

const isActive = (s: WorkerStatus) => isLive(s, (w) => alive(w.pid));

/**
 * The immediate predecessor: the latest-started live run on this provider
 * before `self`, if it has no model response yet and started within the limit.
 * (A predecessor that already answered, or is gone, means no wait.)
 */
export function findPredecessor(
  statuses: WorkerStatus[],
  self: { id: string; provider: string },
  limitSec: number,
  now: number = Date.now(),
): WorkerStatus | null {
  let prev: WorkerStatus | null = null;
  for (const s of statuses) {
    if (s.id >= self.id || s.provider !== self.provider || s.origin === "chat" || !isActive(s)) continue;
    if (!prev || s.id > prev.id) prev = s;
  }
  if (!prev || prev.turns > 0) return null;
  const started = Date.parse(prev.started.replace(" ", "T"));
  if (Number.isFinite(started) && now - started > limitSec * 1000) return null;
  return prev;
}

export type StaggerRelease = "answered" | "limit" | "predecessor-ended";

export interface WaitInfo {
  predecessor: string;
  provider: string;
  elapsedSec: number;
  limitSec: number;
  line: string;
}

export interface StaggerOpts {
  logDir: string;
  self: { id: string; provider: string };
  local: boolean;
  config: StaggerConfig;
  disabled?: boolean;
  /** One-off lines: the wait notice and the release summary. */
  log?: (line: string) => void;
  /** Called at the start and after every poll while waiting; null when released. */
  onWait?: (info: WaitInfo | null) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  load?: (logDir: string) => WorkerStatus[];
  history?: number[];
}

export interface StaggerResult {
  predecessor: string;
  waitedSec: number;
  limitSec: number;
  release: StaggerRelease;
}

const RELEASE_TEXT: Record<StaggerRelease, string> = {
  answered: "predecessor answered",
  limit: "limit reached",
  "predecessor-ended": "predecessor ended without a response",
};

/** Resolves once the predecessor has answered, ended, or the limit expired; null when there was nothing to wait for. */
export async function staggerGate(o: StaggerOpts): Promise<StaggerResult | null> {
  if (o.disabled || !o.config.enabled) return null;
  const load = o.load ?? loadStatuses;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const history = o.history ?? loadWarmupHistory(o.logDir)[o.self.provider];
  const limitSec = warmupLimitSec(history, o.local, o.config);
  if (limitSec <= 0) return null;
  const pred = findPredecessor(load(o.logDir), o.self, limitSec, now());
  if (!pred) return null;
  const limitLabel = Math.round(limitSec);
  o.log?.(`waiting for ${pred.id} to warm the ${o.self.provider} cache (max ${limitLabel}s)`);
  const t0 = now();
  const info = (): WaitInfo => {
    const elapsedSec = Math.floor((now() - t0) / 1000);
    return {
      predecessor: pred.id,
      provider: o.self.provider,
      elapsedSec,
      limitSec: limitLabel,
      line: `waiting ${elapsedSec}s/${limitLabel}s for ${pred.id} to warm ${o.self.provider} cache`,
    };
  };
  o.onWait?.(info());
  let release: StaggerRelease = "limit";
  for (let n = 0; now() - t0 < limitSec * 1000; n++) {
    await sleep(backoffMs(n));
    const cur = load(o.logDir).find((s) => s.id === pred.id);
    if (cur && cur.turns > 0) {
      release = "answered";
      break;
    }
    if (!cur || !isActive(cur)) {
      release = "predecessor-ended";
      break;
    }
    o.onWait?.(info());
  }
  const waitedSec = Math.round((now() - t0) / 100) / 10;
  o.onWait?.(null);
  o.log?.(`waited ${waitedSec}s for ${pred.id} (${RELEASE_TEXT[release]})`);
  return { predecessor: pred.id, waitedSec, limitSec: limitLabel, release };
}

