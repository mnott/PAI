/**
 * config.ts — `builds.slots` and `builds.testSlots` of the main PAI config:
 * how many builds (default 1) and how many simulator/device test runs
 * (default 2) run at once machine-wide. PAI_BUILD_SLOTS / PAI_TEST_SLOTS
 * override them for one process.
 */

import { readMainConfigRaw } from "../daemon/config.js";

export const DEFAULT_BUILD_SLOTS = 1;
export const DEFAULT_TEST_SLOTS = 2;

const ok = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

function slotsOf(key: "slots" | "testSlots", envVar: string, dflt: number, env: NodeJS.ProcessEnv, read: () => Record<string, unknown>): number {
  const fromEnv = ok(env[envVar]);
  if (fromEnv) return fromEnv;
  try {
    const b = read().builds as Record<string, unknown> | undefined;
    return ok(b?.[key]) ?? dflt;
  } catch {
    return dflt;
  }
}

export function buildSlots(env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): number {
  return slotsOf("slots", "PAI_BUILD_SLOTS", DEFAULT_BUILD_SLOTS, env, read);
}

export function testSlots(env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): number {
  return slotsOf("testSlots", "PAI_TEST_SLOTS", DEFAULT_TEST_SLOTS, env, read);
}

/** Slots of one pool. */
export function slotsFor(kind: "build" | "test", env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): number {
  return kind === "test" ? testSlots(env, read) : buildSlots(env, read);
}

export function poolSlots(env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): { build: number; test: number } {
  return { build: buildSlots(env, read), test: testSlots(env, read) };
}

export const DEFAULT_STALL_MINUTES = 5;

/** Minutes a running job's output may stand still before it is flagged STALLED (`builds.stallMinutes`, default 5). */
export function stallMinutes(env: NodeJS.ProcessEnv = process.env, read: () => Record<string, unknown> = readMainConfigRaw): number {
  const n = Number(env.PAI_BUILD_STALL_MINUTES);
  if (n > 0) return n;
  try {
    const v = Number((read().builds as Record<string, unknown> | undefined)?.stallMinutes);
    return v > 0 ? v : DEFAULT_STALL_MINUTES;
  } catch {
    return DEFAULT_STALL_MINUTES;
  }
}
