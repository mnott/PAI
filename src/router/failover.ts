/**
 * Cloud -> local failover of the router (router.failover): classification of a
 * cloud failure, the sticky per-session state, and the local target. The wiring
 * (retrying the same request on the local provider) lives in router.ts.
 */

import http from "node:http";
import https from "node:https";

export type FailoverReason = "usage-limit" | "offline";

/** Network failures that mean "no cloud reachable" (before any response byte). */
const OFFLINE_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ESOCKETTIMEDOUT",
]);

export const isOfflineError = (code: string | undefined): boolean => !!code && OFFLINE_CODES.has(code);

const EXHAUSTED = /usage limit|limit reached|out of (extra )?usage|subscription|quota|credit balance|plan limit|billing/i;
/** A 429 asking for a wait this long is an exhausted allowance, not a rate-limit blip. */
const LONG_RETRY_AFTER_SECS = 300;

/** True for a cloud answer that says the subscription/usage allowance is spent (never an ordinary rate limit). */
export function isUsageExhaustion(status: number, headers: http.IncomingHttpHeaders, body: string): boolean {
  if (status !== 429 && status !== 402) return false;
  let type = "";
  let message = "";
  try {
    const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
    type = String(j.error?.type ?? "");
    message = String(j.error?.message ?? "");
  } catch {
    message = body;
  }
  if (/usage_limit|billing|subscription|quota/i.test(type)) return true;
  if (EXHAUSTED.test(message)) return true;
  const ra = Number(Array.isArray(headers["retry-after"]) ? headers["retry-after"][0] : headers["retry-after"]);
  return Number.isFinite(ra) && ra >= LONG_RETRY_AFTER_SECS;
}

export interface StickyEntry {
  until: number;
  reason: FailoverReason;
}

/** Sessions currently pinned to the local model. */
export class FailoverState {
  private readonly map = new Map<string, StickyEntry>();
  constructor(private readonly now: () => number = Date.now) {}
  get(key: string): StickyEntry | undefined {
    return this.map.get(key);
  }
  /** Pin; returns true when the session was not pinned before (the notice goes out once). */
  pin(key: string, reason: FailoverReason, stickyMin: number): boolean {
    const fresh = !this.map.has(key);
    this.map.set(key, { until: this.now() + stickyMin * 60_000, reason });
    return fresh;
  }
  release(key: string): void {
    this.map.delete(key);
  }
}

/** A one-token cloud call: true when the cloud answers 2xx again. Never throws. */
export function probeCloud(
  base: string,
  headers: Record<string, string>,
  model: string,
  timeoutMs = 5000
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "." }] }));
    const h: Record<string, string> = { ...headers, "content-type": "application/json", "content-length": String(body.length) };
    delete h["accept-encoding"];
    let url: URL;
    try {
      url = new URL(base.replace(/\/+$/, "") + "/v1/messages");
    } catch {
      return resolve(false);
    }
    const q = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: h, timeout: timeoutMs }, (r) => {
      r.resume();
      resolve((r.statusCode ?? 500) >= 200 && (r.statusCode ?? 500) < 300);
    });
    q.on("timeout", () => q.destroy());
    q.on("error", () => resolve(false));
    q.end(body);
  });
}

/** The model id a local provider serves (its default). */
export function localModelOf(p: { models: Record<string, string | undefined> }): string | undefined {
  return p.models.default ?? Object.values(p.models).find((m): m is string => !!m);
}

export const failoverNotice = (reason: FailoverReason): string =>
  `cloud unavailable (${reason}), this session now runs on the local model`;
