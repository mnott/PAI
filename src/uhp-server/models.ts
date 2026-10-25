/**
 * models.ts — GET /v1/models and /v1/harnesses/{id}/models. `available` is
 * computed: a credential resolves (or the provider is local) AND, for a local
 * endpoint, it answers a probe. Never asserted.
 */

import { isLocalProvider, resolveProviderKey, type WorkerProvider } from "../workers/config.js";
import { type PaiHarness } from "./harnesses.js";

export type EndpointProbe = (baseUrl: string) => Promise<boolean>;

export async function providerAvailable(p: WorkerProvider, probe: EndpointProbe): Promise<boolean> {
  if (!p.enabled) return false;
  if (p.native) return true;
  if (isLocalProvider(p.baseUrl)) return probe(p.baseUrl);
  return resolveProviderKey(p) !== null;
}

/** Distinct model ids a provider carries, default first. */
export function providerModels(p: WorkerProvider): string[] {
  const ids = [p.models.default, ...Object.values(p.models)].filter((m): m is string => typeof m === "string" && m !== "");
  return [...new Set(ids)];
}

export async function modelEntries(backend: string, p: WorkerProvider, probe: EndpointProbe): Promise<Array<Record<string, unknown>>> {
  const available = await providerAvailable(p, probe);
  return providerModels(p).map((id) => ({ id, label: id, backend, available, default: id === p.models.default }));
}

export async function modelCatalog(providers: Record<string, WorkerProvider>, harnesses: PaiHarness[], probe: EndpointProbe): Promise<Record<string, unknown>> {
  const backends: Record<string, { default: string; models: Array<Record<string, unknown>> }> = {};
  const seen = new Set<string>();
  for (const h of harnesses) {
    if (seen.has(h.provider)) continue;
    seen.add(h.provider);
    const p = providers[h.provider]!;
    const b = (backends[h.engine] ??= { default: p.models.default, models: [] });
    const have = new Set(b.models.map((m) => m.id));
    for (const m of await modelEntries(h.engine, p, probe)) if (!have.has(m.id)) b.models.push(m);
  }
  return { backends };
}

export async function harnessModels(h: PaiHarness, p: WorkerProvider, probe: EndpointProbe): Promise<Record<string, unknown>> {
  return { harness_id: h.id, backend: h.engine, default: h.model, fallback: h.model, models: await modelEntries(h.engine, p, probe) };
}
