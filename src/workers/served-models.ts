/**
 * served-models.ts — the one GET /v1/models probe. Workers (`pai setups`,
 * `--local`) and the cockpit's local gauges ask the same question — is a local
 * model server up, and does it serve this provider's model — through this one
 * helper, so the two cannot drift.
 */

/** The answer of one /v1/models probe. */
export interface ServedProbe {
  /** the server answered HTTP at all (any status); a timeout counts, a refused or silent connection does not */
  alive: boolean;
  /** the model ids it lists, when the body carried them */
  ids?: string[];
}

/**
 * One GET /v1/models against host:port. `alive` = answered HTTP at all; `ids` =
 * the listed models, when the body has them. A busy server may time out
 * without a list; one that resets or closes the connection is not serving.
 *
 * fetch is the seam the workers use (tests stub it): a bare TCP connect
 * reported ports as running that no model server answered, so only a 2xx JSON
 * body counts as a list and a non-2xx answer is not running. The cockpit's
 * localLimits reads the same `ids`/`serves` through its own node-http poll,
 * where any status (or a timeout) counts as alive.
 */
export async function probeServedModels(host: string, port: number, timeoutMs: number): Promise<ServedProbe> {
  try {
    const h = host.includes(":") ? `[${host}]` : host;
    const res = await fetch(`http://${h}:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { alive: false };
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> } | null;
    const ids = (body?.data ?? []).map((m) => m.id).filter((i): i is string => typeof i === "string");
    return { alive: true, ...(ids.length ? { ids } : {}) };
  } catch {
    return { alive: false };
  }
}

/**
 * Several providers can share one endpoint: the provider is up only if its
 * model is the one served. An unknown list (no ids) = the endpoint decides;
 * likewise a provider with no configured models (empty list) — nothing to
 * match against, so the answer alone decides.
 */
export function serves(ids: string[] | undefined, models: string[]): boolean {
  if (!ids || !models.length) return true;
  return models.some((m) => ids.includes(m));
}
