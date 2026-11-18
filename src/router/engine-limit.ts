/**
 * Per-engine limits for the router's upstream calls: a cap on requests in flight to one origin (the rest wait
 * in line here), a bounded keep-alive agent, and the backoff for engine resets seen before any response byte.
 */
import http from "node:http";

export const ENGINE_MAX_INFLIGHT = (): number => {
  const n = Number(process.env.PAI_ENGINE_MAX_INFLIGHT);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

/** Backoff before retry 1..4 (ms). */
export const RESET_BACKOFF_MS = [500, 1000, 2000, 4000];
const RESETTABLE = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE"]);

export function isResetError(e: NodeJS.ErrnoException): boolean {
  return RESETTABLE.has(String(e.code)) || /socket hang up/i.test(e.message ?? "");
}

const inflight = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

/** Resolves with a one-shot `done` once fewer than the cap are in flight to the origin. */
export function acquireEngine(origin: string, cap: number = ENGINE_MAX_INFLIGHT()): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      inflight.set(origin, (inflight.get(origin) ?? 0) + 1);
      let used = false;
      resolve(() => {
        if (used) return;
        used = true;
        inflight.set(origin, (inflight.get(origin) ?? 1) - 1);
        const next = waiting.get(origin)?.shift();
        if (next) next();
      });
    };
    if ((inflight.get(origin) ?? 0) < cap) grant();
    else {
      const q = waiting.get(origin) ?? [];
      q.push(grant);
      waiting.set(origin, q);
    }
  });
}

export function engineInflight(origin: string): number {
  return inflight.get(origin) ?? 0;
}

const agents = new Map<string, http.Agent>();
/** Keep-alive agent bounded to the engine's accepted concurrency. */
export function engineAgent(origin: string, cap: number = ENGINE_MAX_INFLIGHT()): http.Agent {
  let a = agents.get(origin);
  if (!a) agents.set(origin, (a = new http.Agent({ keepAlive: process.env.PAI_ENGINE_KEEPALIVE !== "0", maxSockets: cap + 1, maxFreeSockets: cap })));
  return a;
}
