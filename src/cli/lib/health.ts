/** Is a provider usable right now, and if not, the plain-words reason. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../../config/pai-home.js";
import { ANTHROPIC_NATIVE, type WorkersConfig } from "../../workers/config.js";
import { budgetExceeded, budgetSkipReason, budgetWall, type BudgetReading } from "../../workers/budget.js";

export interface Health {
  state: "ok" | "limit" | "off";
  reason: string;
}

export function providerHealth(
  name: string,
  cfg: Pick<WorkersConfig, "providers" | "routing">,
  budget: Record<string, BudgetReading | undefined>,
  now = new Date()
): Health {
  if (name !== ANTHROPIC_NATIVE) {
    const p = cfg.providers[name];
    if (!p) return { state: "off", reason: `${name}: not configured` };
    if (!p.enabled) return { state: "off", reason: `${name}: disabled` };
  }
  const r = budget[name];
  if (r && budgetExceeded(r, budgetWall(cfg.routing, name))) {
    return { state: "limit", reason: `${budgetSkipReason(name, r, now).replace(" ", ": at limit, ")}` };
  }
  return { state: "ok", reason: r?.percent != null ? `${Math.round(r.percent)}% used` : "ok" };
}

import { budgetCache } from "../../workers/budget.js";

/** Live budget readings, cached for 5 minutes by the worker engine; never waits longer than `ms`. */
export async function readBudget(workers: WorkersConfig, ms = 1500): Promise<Record<string, BudgetReading | undefined>> {
  try {
    return await Promise.race([
      budgetCache.warm(workers),
      new Promise<Record<string, BudgetReading>>((res) => setTimeout(() => res({}), ms).unref()),
    ]);
  } catch {
    return {};
  }
}

const SNAPSHOT_MAX_AGE_MS = 6 * 3600_000;

/**
 * Last budget readings a full lookup saved, for a first paint that must not
 * wait on provider usage endpoints. Stale-by-design: callers refresh after.
 */
export function readBudgetSnapshot(now = Date.now()): Record<string, BudgetReading | undefined> {
  try {
    const raw = JSON.parse(readFileSync(paiHomePath("budget-snapshot.json"), "utf8")) as { at?: number; map?: Record<string, BudgetReading> };
    if (typeof raw.at === "number" && now - raw.at < SNAPSHOT_MAX_AGE_MS && raw.map) return raw.map;
  } catch {
    /* none yet */
  }
  return {};
}

export function saveBudgetSnapshot(map: Record<string, BudgetReading | undefined>, now = Date.now()): void {
  try {
    mkdirSync(paiHomePath(), { recursive: true });
    const target = paiHomePath("budget-snapshot.json");
    writeFileSync(target + ".tmp", JSON.stringify({ at: now, map }));
    renameSync(target + ".tmp", target);
  } catch {
    /* the next run just has no snapshot */
  }
}
