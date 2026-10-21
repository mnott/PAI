/**
 * Which providers --local may consider. Pure config logic, kept out of
 * local-provider.ts so hook bundles and other light callers can use it
 * without pulling that module's import graph (setups, embeddings, onnx).
 */

import type { WorkerProvider } from "./config.js";
import { readLocalConfig } from "./local-tiers.js";
import { workersYamlPath } from "./workers-config.js";
import { isLoopbackHostname } from "../utils/loopback.js";

/**
 * Providers a `local:` tier launches. `pai worker local <tier>` and the cockpit
 * start those without touching `enabled:`, so a running tier server is a
 * candidate for --local even when its provider entry is switched off.
 */
export function tierProviderNames(yamlPath: string = workersYamlPath()): string[] {
  try {
    return Object.values(readLocalConfig(yamlPath).tiers).map((t) => t.provider);
  } catch {
    return [];
  }
}

function isLoopbackBaseUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A loopback provider --local may run on: enabled, or launched by a tier. */
export function isLocalCandidate(p: WorkerProvider, name: string, tierProviders: string[]): boolean {
  return (p.enabled || tierProviders.includes(name)) && isLoopbackBaseUrl(p.baseUrl);
}
