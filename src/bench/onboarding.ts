/**
 * onboarding.ts — the rule summary `pai bench run` prints at the end of a series: firings per anti-pattern for
 * the provider's model in the run's time window (from the firing log), and a suggested `pai antipatterns set
 * ... --model <m>` line per behaviour pattern that fired at least `minFirings` times. The suggested stop_at is
 * the 90th percentile of the per-run counts (one run = one worker), never below the shipped default. Nothing is
 * applied here: the lines are suggestions for the operator.
 */

import { readFiringsResolved, type Firing } from "../hooks/ts/lib/antipattern-log.js";
import { activeAntipattern } from "../hooks/ts/lib/antipatterns.js";

export const MIN_FIRINGS = 5;

export interface OnboardRow {
  id: string;
  category: string;
  layer: string;
  count: number;
  /** The pattern's shipped stop_at / deny_at / max_repeats / streak, whichever its params carry. */
  shippedDefault: number | null;
  /** Observed 90th percentile of firings per worker run. */
  p90: number | null;
  /** True when a `pai antipatterns set --model` line is suggested for this pattern. */
  suggest: boolean;
}

export interface Onboarding {
  model: string;
  rows: OnboardRow[];
  /** Ready-to-run suggestion lines. */
  suggestions: string[];
}

/** The pattern's tunable stop threshold, from the shipped params (a user override of the global param does not move the suggestion's floor). */
export function shippedDefaultOf(id: string): number | null {
  let params: Record<string, unknown>;
  try {
    params = activeAntipattern(id).detector.params;
  } catch {
    return null;
  }
  for (const k of ["stop_at", "deny_at", "max_repeats", "streak"]) if (typeof params[k] === "number") return params[k] as number;
  return null;
}

/** The p-th percentile of counts (ceil-rank over the sorted list); null when empty. */
export function percentile(counts: number[], p: number): number | null {
  if (!counts.length) return null;
  const s = [...counts].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/** The model a provider label stands for: the model of that provider's firings in the window, else the label itself. */
export function resolveModel(firings: Firing[], provider: string): string {
  const models = [...new Set(firings.filter((f) => f.provider === provider).map((f) => f.model))].filter((m) => m && m !== "session");
  return models.length === 1 ? models[0] : models.sort()[0] ?? provider;
}

/** One row per pattern that fired in the window for this model; behaviour patterns with >= minFirings get a suggestion. */
export function onboardingSummary(firings: Firing[], model: string, opts: { minFirings?: number; now?: number } = {}): Onboarding {
  const min = opts.minFirings ?? MIN_FIRINGS;
  const hit = firings.filter((f) => f.model === model);
  const rows: OnboardRow[] = [];
  for (const id of [...new Set(hit.map((f) => f.id))].sort()) {
    const fs = hit.filter((f) => f.id === id);
    const perRun = new Map<string, number>();
    for (const f of fs) perRun.set(f.workerId ?? f.sessionId ?? f.ts, (perRun.get(f.workerId ?? f.sessionId ?? f.ts) ?? 0) + 1);
    const layer = fs[0].category === "shell" || fs[0].category === "paths" ? "baseline" : "behaviour";
    const def = shippedDefaultOf(id);
    const p90 = percentile([...perRun.values()], 90);
    const suggest = layer === "behaviour" && fs.length >= min;
    rows.push({ id, category: fs[0].category, layer, count: fs.length, shippedDefault: def, p90, suggest });
  }
  const suggestions = rows.filter((r) => r.suggest).map((r) => {
    const stop = Math.max(r.p90 ?? 0, r.shippedDefault ?? 0);
    const param = r.id === "growing-command" ? "max_repeats" : r.id === "repeated-failure" ? "deny_at" : r.id === "missing-path-streak" ? "streak" : "stop_at";
    return `pai antipatterns set ${r.id} ${param} ${stop} --model ${model} --reason 'bench: ${r.count} firings, p90 per run ${r.p90}'`;
  });
  return { model, rows, suggestions };
}

/** The firings of this model in [start, now] from the live firing log, then the summary. */
export function onboardingForRun(provider: string, start: number, opts: { minFirings?: number; now?: number } = {}): Onboarding {
  const now = opts.now ?? Date.now();
  const firings = readFiringsResolved().filter((f) => {
    const t = Date.parse(f.ts);
    return Number.isFinite(t) && t >= start && t <= now;
  });
  return onboardingSummary(firings, resolveModel(firings, provider), opts);
}

/** The lines to print after a series: one per pattern, then the suggestions (or a no-suggestion line). */
export function renderOnboarding(o: Onboarding): string[] {
  const out = [`rule summary for ${o.model} (this run):`];
  if (!o.rows.length) out.push("  no firings recorded for this model");
  for (const r of o.rows) out.push(`  ${r.id} (${r.layer}): ${r.count} firing${r.count === 1 ? "" : "s"}`);
  for (const s of o.suggestions) out.push(`suggest: ${s}`);
  if (o.rows.length && !o.suggestions.length) out.push("no suggestions (no behaviour pattern fired 5 or more times)");
  return out;
}
