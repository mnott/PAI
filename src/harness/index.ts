/**
 * index.ts — the adapter registry and the enabled set. Implementations are
 * listed here; which of them run is config (`harness.adapters` in the main
 * config, default ["claude-code"]), never a hardcoded enable list.
 */

import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import type { HarnessAdapter } from "./types.js";

/** Every implementation PAI knows, in display order. */
export const ADAPTERS: HarnessAdapter[] = [claudeCodeAdapter, codexAdapter];

/** Names enabled by config: `harness.adapters`, default ["claude-code"]. */
export function enabledHarnessNames(path: string = paiConfigFilePath()): string[] {
  const h = effectiveMainConfig(path).harness as { adapters?: unknown } | undefined;
  const list = h?.adapters;
  if (!Array.isArray(list)) return ["claude-code"];
  return list.filter((n): n is string => typeof n === "string");
}

/** Adapters whose store exists on this machine, restricted to `names` (default: the config-enabled set). */
export function harnessAdapters(names?: string[]): HarnessAdapter[] {
  const wanted = names ?? enabledHarnessNames();
  return ADAPTERS.filter((a) => wanted.includes(a.name) && a.detect());
}
