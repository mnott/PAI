/**
 * UHP models: `GET /v1/models` (backends = engines) and
 * `GET /v1/harnesses/{id}/models`. `available` is computed: the provider's key
 * resolves, and a local endpoint answers its health probe.
 */

import { isLocalProvider, resolveProviderKey, type WorkerProvider } from "../workers/config.js";
import { probeEndpointUrl } from "../workers/endpoint-health.js";
import type { HarnessEntry } from "./harnesses.js";

export interface UhpModel {
  id: string;
  label: string;
  backend: string;
  available: boolean;
  default: boolean;
}

export type Probe = (url: string) => Promise<boolean>;

export async function providerAvailable(p: WorkerProvider, probe: Probe = probeEndpointUrl): Promise<boolean> {
  if (p.native) return true;
  if (isLocalProvider(p.baseUrl)) return probe(p.baseUrl);
  try {
    return resolveProviderKey(p) !== null;
  } catch {
    return false;
  }
}

export async function modelsOf(e: HarnessEntry, probe?: Probe): Promise<{ default: string; models: UhpModel[] }> {
  const available = await providerAvailable(e.workerProvider, probe);
  const def = e.harness.defaultModel;
  const ids = [...new Set(Object.values(e.workerProvider.models).filter((m): m is string => typeof m === "string"))];
  if (!ids.includes(def)) ids.unshift(def);
  return {
    default: def,
    models: ids.map((id) => ({ id, label: id, backend: e.engine, available, default: id === def })),
  };
}

export function harnessModels(e: HarnessEntry, m: { default: string; models: UhpModel[] }) {
  return { harness_id: e.harness.id, backend: e.engine, default: m.default, fallback: m.default, models: m.models };
}

export async function modelCatalog(entries: HarnessEntry[], probe?: Probe) {
  const backends: Record<string, { default: string; models: UhpModel[] }> = {};
  for (const e of entries) {
    const m = await modelsOf(e, probe);
    const b = (backends[e.engine] ??= { default: m.default, models: [] });
    for (const model of m.models) {
      const have = b.models.find((x) => x.id === model.id);
      if (!have) b.models.push({ ...model, default: model.id === b.default });
      else have.available = have.available || model.available;
    }
  }
  return { backends };
}
