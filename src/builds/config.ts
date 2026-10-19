/**
 * config.ts — `builds.slots` of the main PAI config: how many builds run at
 * once machine-wide (default 1). PAI_BUILD_SLOTS overrides it for one process.
 */

import { readMainConfigRaw } from "../daemon/config.js";

export const DEFAULT_BUILD_SLOTS = 1;

export function buildSlots(env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): number {
  const ok = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const fromEnv = ok(env.PAI_BUILD_SLOTS);
  if (fromEnv) return fromEnv;
  try {
    const b = read().builds as { slots?: unknown } | undefined;
    return ok(b?.slots) ?? DEFAULT_BUILD_SLOTS;
  } catch {
    return DEFAULT_BUILD_SLOTS;
  }
}
