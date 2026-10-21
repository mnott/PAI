/**
 * endpoint-health.ts — cached health of registered endpoints.
 *
 * A registered endpoint has no pid, so liveness is a probe: GET <url>/v1/models
 * (the same question served-models.ts asks of a local port). One probe per
 * endpoint per interval; the answer is cached and `isHealthy` reads the cache
 * synchronously, so the resolver can take it as a predicate. An endpoint that
 * has not been probed yet counts as healthy (optimistic, like its `ready`
 * state); a down one is excluded until a later probe sees it answer again.
 * Managed instances are healthy when their state is `ready`.
 */

import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";
import type { LocalInstance } from "./local-instances.js";

export const ENDPOINT_PROBE_INTERVAL_MS = 15_000;

/** True when the endpoint at `url` answers GET /v1/models with 2xx. */
export async function probeEndpointUrl(url: string, timeoutMs = LOCAL_PROBE_TIMEOUT_MS): Promise<boolean> {
  const base = url.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface EndpointHealth {
  /** probe every registered endpoint whose cached answer is older than the interval; resolves when done */
  refresh(instances: LocalInstance[]): Promise<void>;
  /** sync predicate for the resolver */
  isHealthy(i: LocalInstance): boolean;
}

export function createEndpointHealth(deps: {
  probe?: (url: string) => Promise<boolean>;
  intervalMs?: number;
  now?: () => number;
} = {}): EndpointHealth {
  const probe = deps.probe ?? probeEndpointUrl;
  const interval = deps.intervalMs ?? ENDPOINT_PROBE_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { ok: boolean; at: number }>();
  const inflight = new Map<string, Promise<void>>();

  const refreshOne = (i: LocalInstance): Promise<void> => {
    const hit = cache.get(i.id);
    if (hit && now() - hit.at < interval) return Promise.resolve();
    const running = inflight.get(i.id);
    if (running) return running;
    const p = probe(i.url)
      .catch(() => false)
      .then((ok) => { cache.set(i.id, { ok, at: now() }); })
      .finally(() => { inflight.delete(i.id); });
    inflight.set(i.id, p);
    return p;
  };

  return {
    async refresh(instances) {
      await Promise.all(instances.filter((i) => i.origin === "registered").map(refreshOne));
    },
    isHealthy(i) {
      if (i.origin === "managed") return i.state === "ready";
      return cache.get(i.id)?.ok ?? true;
    },
  };
}
