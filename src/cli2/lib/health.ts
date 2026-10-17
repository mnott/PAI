/** Is a provider usable right now, and if not, the plain-words reason. */

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
