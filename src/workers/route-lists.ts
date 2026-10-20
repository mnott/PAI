/**
 * route-lists.ts — the routing table: per class an ordered list of models.
 *
 * Element 0 is what the class serves on; the rest is that class's fallback
 * order. One entry names a provider and optionally one of its models:
 * "gyro-m" (a local model, or a provider's default for the class), "glm/fast"
 * (a model alias), "glm/glm-5.3-flash" or "anthropic/opus" (a model id). The
 * list lives in the class map (`workers.classes`): a plain "<provider>[/alias]"
 * target is a list of one, the object form carries `models: [...]`. Pure
 * functions only; the I/O (validation against the providers, persistence,
 * state) is in route-table.ts.
 */

import type { ClassTarget } from "./config.js";

/** Rows of the routing table. `orchestrate` is the chat side (session profile), the rest are worker classes. */
export const ROUTE_CLASSES = ["orchestrate", "implement", "simple", "spotcheck", "research", "draft", "review", "complex", "plan"] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export const ROUTE_LABELS: Record<RouteClass, string> = {
  orchestrate: "Orchestrator",
  implement: "Implement",
  simple: "Simple",
  spotcheck: "Check",
  research: "Research",
  draft: "Draft",
  review: "Review",
  complex: "Complex",
  plan: "Plan",
};

/** The model-carrying classes the retired rank chains governed (plan always ran on its own target). */
const CHAIN_CLASSES = ROUTE_CLASSES.filter((c) => c !== "orchestrate" && c !== "plan");

export const MAX_ROUTE_MODELS = 12;

export function parseEntry(entry: string): { provider: string; model: string | null } {
  const i = entry.indexOf("/");
  return i < 0 ? { provider: entry, model: null } : { provider: entry.slice(0, i), model: entry.slice(i + 1) || null };
}

export const entryProvider = (entry: string): string => parseEntry(entry).provider;

/** The ordered entries of a class: its `models`, else its single provider[/alias] target, else []. */
export function classRoute(classes: Record<string, ClassTarget>, cls: string): string[] {
  const t = classes[cls];
  if (t === undefined) return [];
  if (typeof t === "string") return [t];
  if (t.models?.length) return [...t.models];
  return t.provider ? [t.provider] : [];
}

/** The class target that stores `entries`; other keys of an object target (mcp, cost tier, tags) are kept. */
export function targetForRoute(existing: ClassTarget | undefined, entries: string[]): ClassTarget | undefined {
  const obj = existing !== undefined && typeof existing === "object" ? existing : null;
  if (!entries.length) {
    if (!obj) return undefined;
    const { models: _m, provider: _p, ...rest } = obj;
    return rest;
  }
  const aliasForm = (e: string) => {
    const m = parseEntry(e).model;
    return m === null || /^[a-z][a-z0-9-]*$/.test(m);
  };
  if (!obj && entries.length === 1 && aliasForm(entries[0])) return entries[0];
  const { models: _m, ...rest } = obj ?? {};
  // `provider` mirrors element 0 for readers of the older single-target form
  return { ...rest, provider: entryProvider(entries[0]), ...(entries.length > 1 || parseEntry(entries[0]).model !== null ? { models: [...entries] } : {}) };
}

/** Flatten a retired rank chain (array, or {local, cloud, localFirst}) into the routing walk it stood for. */
export function flatLegacyChain(v: unknown): string[] {
  const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string" && !!n) : []);
  if (Array.isArray(v)) return [...new Set(names(v))];
  if (typeof v !== "object" || v === null) return [];
  const o = v as { local?: unknown; cloud?: unknown; localFirst?: unknown };
  return [...new Set(o.localFirst === false ? names(o.cloud) : [...names(o.local), ...names(o.cloud)])];
}

/**
 * One-time migration of the retired `workers.chains` into the class lists:
 * the workers chain becomes the list of every worker class (a provider the
 * class already served keeps its alias), the orchestrator chain the
 * `orchestrate` row. Mutates `classes`; returns whether anything changed.
 */
export function migrateLegacyChains(chains: unknown, classes: Record<string, ClassTarget>): boolean {
  if (typeof chains !== "object" || chains === null || Array.isArray(chains)) return false;
  const c = chains as { workers?: unknown; orchestrator?: unknown };
  let changed = false;
  const workers = flatLegacyChain(c.workers);
  if (workers.length) {
    for (const cls of CHAIN_CLASSES) {
      const current = classRoute(classes, cls).map(parseEntry);
      const list = workers.map((p) => {
        const had = current.find((e) => e.provider === p && e.model);
        return had ? `${p}/${had.model}` : p;
      });
      const t = targetForRoute(classes[cls], list);
      if (t !== undefined) classes[cls] = t;
      changed = true;
    }
  }
  const orch = flatLegacyChain(c.orchestrator);
  if (orch.length) {
    const t = targetForRoute(classes.orchestrate, orch);
    if (t !== undefined) classes.orchestrate = t;
    changed = true;
  }
  return changed;
}

/** The worker-class rows a policy mode rewrites. */
export const POLICY_CLASSES = ["implement", "simple", "spotcheck"] as const;

/**
 * The list a policy mode stands for: prefer-local / auto put the local
 * entries first, prefer-cloud puts them last, cloud-only drops them,
 * local-only keeps nothing else. `local` seeds the list when it names no local
 * entry yet (the configured `local:` provider moves to the front).
 */
export function listForPolicy(mode: string, entries: string[], isLocal: (provider: string) => boolean, local: string | null): string[] {
  const loc = entries.filter((e) => isLocal(entryProvider(e)));
  const cloud = entries.filter((e) => !isLocal(entryProvider(e)));
  const seeded = local && !loc.some((e) => entryProvider(e) === local) ? [local, ...loc] : local ? [...loc.filter((e) => entryProvider(e) === local), ...loc.filter((e) => entryProvider(e) !== local)] : loc;
  if (mode === "cloud-only") return cloud;
  if (mode === "local-only") return seeded.length ? seeded : entries;
  if (mode === "prefer-cloud") return [...cloud, ...seeded];
  return [...seeded, ...cloud];
}
