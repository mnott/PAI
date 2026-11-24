/**
 * loop-capture.ts — the last translated requests of a local worker, kept for the loop guard.
 *
 * Local (loopback) workers fall into identical-call loops and the offline replay
 * could not reproduce them, so the proxy keeps the last few translated request
 * bodies and raw responses per worker run in memory. When the loop guard stops
 * a worker, those pairs are written to ~/.pai/logs/workers/loop-captures/<id>.json
 * (mode 600, auth headers and api keys stripped) and one ledger line is appended.
 *
 * The proxy process and the hook that stops the worker are different processes,
 * so the capture is keyed by the worker id the proxy already knows (the request's
 * metadata.user_id, which Claude Code sets to the session id) and written by
 * whichever process sees the stop first: the proxy on its next request, or the
 * hook through writeLoopCapture.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { isLocalProvider } from "../config.js";
import { appendLedger } from "../ledger.js";
import { ledgerPath, workersLogDir } from "../paths.js";
import { readWorkersSection } from "../config.js";

/** How many request/response pairs a run keeps, and the per-run byte budget. */
export const LOOP_CAPTURE_KEEP = 3;
export const LOOP_CAPTURE_MAX_BYTES = 5 * 1024 * 1024;

export interface CapturedTurn {
  ts: string;
  request: unknown;
  response: string;
}

/** The in-memory ring of recent turns, per worker id, bounded by count and bytes. */
export class LoopCaptureRing {
  private turns = new Map<string, CapturedTurn[]>();
  constructor(private keep = LOOP_CAPTURE_KEEP, private maxBytes = LOOP_CAPTURE_MAX_BYTES) {}

  /** Record one translated request and its raw response for a run. */
  record(id: string, request: unknown, response: string, now = Date.now()): void {
    const list = this.turns.get(id) ?? [];
    list.push({ ts: new Date(now).toISOString(), request, response });
    while (list.length > this.keep) list.shift();
    let bytes = 0;
    for (const t of list) bytes += Buffer.byteLength(JSON.stringify(t));
    while (bytes > this.maxBytes && list.length > 1) {
      bytes -= Buffer.byteLength(JSON.stringify(list.shift()));
    }
    this.turns.set(id, list);
  }

  /** The kept turns of a run, oldest first; empty when nothing was recorded. */
  get(id: string): CapturedTurn[] {
    return this.turns.get(id) ?? [];
  }

  /** Drop a run's turns (after a capture is written). */
  clear(id: string): void {
    this.turns.delete(id);
  }

  get size(): number {
    return this.turns.size;
  }
}

/** The shared ring of the running proxy process. */
export const defaultLoopCaptureRing = new LoopCaptureRing();

/** Where a run's capture file lives. */
export function loopCapturePath(logDir: string, id: string): string {
  return join(logDir, "loop-captures", `${id}.json`);
}

/** Headers whose values must never reach disk. */
const SECRET_HEADER = /^(authorization|x-api-key|proxy-authorization|cookie)$/i;
/** Keys whose values must never reach disk. */
const SECRET_KEY = /^(api[_-]?key|apikey|authorization|token|secret)$/i;

/** Deep-strip auth headers and api-key-shaped keys from a captured body. */
export function stripSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_HEADER.test(k) || SECRET_KEY.test(k)) continue;
    out[k] = stripSecrets(val);
  }
  return out;
}

/**
 * Write a run's kept turns to the capture file (mode 600) and append the ledger
 * line. Returns the file path, or null when there is nothing to write.
 * Never throws: a capture must never break the caller that stops a worker.
 */
export function writeLoopCapture(
  logDir: string,
  id: string,
  turns: CapturedTurn[],
  reason: string,
  now = new Date()
): string | null {
  if (!turns.length) return null;
  try {
    const dir = join(logDir, "loop-captures");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = loopCapturePath(logDir, id);
    const payload = {
      id,
      reason,
      capturedAt: now.toISOString(),
      turns: turns.map((t) => ({ ts: t.ts, request: stripSecrets(t.request), response: stripSecrets(t.response) })),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
    appendLedger(ledgerPath(logDir), "LOOP-CAPTURE", { id, path }, now);
    return path;
  } catch {
    return null;
  }
}

/**
 * The capture hook calls this when the loop guard stops a worker: write whatever
 * the proxy process still holds for that id (nothing, if the hook runs in a
 * different process — the proxy writes on its next request instead).
 */
export function captureOnLoopStop(logDir: string, id: string, reason: string, ring: LoopCaptureRing = defaultLoopCaptureRing): string | null {
  const turns = ring.get(id);
  const path = writeLoopCapture(logDir, id, turns, reason);
  if (path) ring.clear(id);
  return path;
}

/**
 * The proxy calls this on every translated request: if a loop-stop marker exists
 * for this run and the provider is local, flush the kept turns to disk.
 * Returns the capture path when one was written.
 */
export function maybeFlushLoopCapture(
  logDir: string,
  id: string,
  providerBaseUrl: string,
  ring: LoopCaptureRing = defaultLoopCaptureRing
): string | null {
  if (!isLocalProvider(providerBaseUrl)) return null;
  const markerPath = join(logDir, `${id}.loop-stop`);
  if (!existsSync(markerPath)) return null;
  let reason = "loop guard";
  try {
    const m = JSON.parse(readFileSync(markerPath, "utf8")) as { reason?: string };
    if (m.reason) reason = m.reason;
  } catch {
    // keep the default reason
  }
  const turns = ring.get(id);
  const path = writeLoopCapture(logDir, id, turns, reason);
  if (path) ring.clear(id);
  return path;
}

/** The log dir the capture functions default to. */
export function captureLogDir(): string {
  return workersLogDir(readWorkersSection().workers);
}
