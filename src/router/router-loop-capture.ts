/**
 * router-loop-capture.ts — the last forwarded requests of a local worker, kept for the loop guard.
 *
 * Local (signal-2) workers point ANTHROPIC_BASE_URL at the router, which forwards
 * /v1/messages to the Strata instances (8044/8045); the standalone proxy never sees
 * those requests, so the router keeps the last few turns per run here instead.
 * The body is recorded exactly as forwarded (after the router's transformations)
 * and the upstream instance that served it is noted. Runs are keyed by the worker
 * id the router can see: x-pai-worker (set by the run's settings), falling back to
 * metadata.user_id (the session id Claude Code carries).
 *
 * The same ring, capture file (~/.pai/logs/workers/loop-captures/<id>.json, mode
 * 600, secrets stripped) and LOOP-CAPTURE ledger line as the proxy path: the hook
 * that stops a worker calls captureOnLoopStop, and the router flushes on its next
 * request when a loop-stop marker exists (maybeFlushLoopCapture).
 */

import { headerValue } from "./usage.js";
import {
  captureLogDir,
  defaultLoopCaptureRing,
  maybeFlushLoopCapture,
  type LoopCaptureRing,
} from "../workers/proxy/loop-capture.js";
export { defaultLoopCaptureRing };
import { isLocalProvider } from "../workers/config.js";

/** The run id a request belongs to: the worker header first, else the session id in the body. */
export function captureRunId(headers: Record<string, unknown>, body: Record<string, unknown> | null): string | null {
  const w = headerValue(headers["x-pai-worker"] as string | string[] | undefined, 80);
  if (w) return w;
  const meta = body?.metadata as { user_id?: unknown } | undefined;
  return typeof meta?.user_id === "string" && meta.user_id ? meta.user_id : null;
}

/**
 * The router calls this once per routed request, before forwarding: flush any
 * pending loop-stop for this run (local targets only). Returns the capture path
 * when one was written.
 */
export function routerFlushLoopCapture(
  logDir: string,
  runId: string | null,
  baseUrl: string,
  ring: LoopCaptureRing = defaultLoopCaptureRing
): string | null {
  if (!runId || !isLocalProvider(baseUrl)) return null;
  return maybeFlushLoopCapture(logDir, runId, baseUrl, ring);
}

/**
 * The router calls this when a local turn completes: keep the forwarded body, the
 * upstream response and the instance port that served it.
 */
export function routerRecordTurn(
  runId: string | null,
  forwarded: unknown,
  response: string,
  upstreamPort: number | undefined,
  ring: LoopCaptureRing = defaultLoopCaptureRing
): void {
  if (!runId) return;
  ring.record(runId, forwarded, response, Date.now(), upstreamPort);
}

/** The log dir the router capture functions default to. */
export function routerCaptureLogDir(): string {
  return captureLogDir();
}
