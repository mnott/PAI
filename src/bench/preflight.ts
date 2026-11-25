/**
 * Preflight of a bench series: resolve the provider exactly like a worker start does.
 * `pai bench run` spawns `pai worker run --provider <p>` per rep; that resolution is
 * routing.resolveTarget(flagProvider) + assertLocalProviderAlive (gate.ts). A disabled or
 * unknown local provider refuses every worker start with rc 2 while the set scripts still
 * exit 0 — a series of empty errors and "done rc=0" lines (incident 2026-11-24 23:19,
 * gyro-s2-v2b). Resolve once before the first rep; a refusal aborts the series with its
 * message and a non-zero exit.
 */

import { readWorkersSection } from "../workers/config.js";
import { resolveTarget } from "../workers/routing.js";
import { assertLocalProviderAlive } from "../workers/run/gate.js";
import { type PortCheck } from "../cli/lib/setups.js";

export interface PreflightDeps {
  /** Live config loader seam (tests inject). */
  load?: () => ReturnType<typeof readWorkersSection>;
  /** Port probe seam for the local-alive check (tests inject; default httpModelsCheck). */
  check?: PortCheck;
}

/**
 * Resolve `provider` exactly as a worker start does and return its name. Throws with the
 * refusal text ("no worker provider named …", "provider "x" is disabled …", "… is a local
 * (loopback) provider and is disabled — …") when the start would be refused.
 */
export async function preflightProvider(provider: string, deps: PreflightDeps = {}): Promise<string> {
  const load = deps.load ?? (() => readWorkersSection());
  const { workers } = load();
  const target = resolveTarget(workers, "", { flagProvider: provider });
  await assertLocalProviderAlive(workers, "", target.providerName, target.provider, { _localCheck: deps.check });
  return target.providerName;
}
