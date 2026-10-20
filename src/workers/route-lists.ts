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

/**
 * The three rows of the routing table: a ROLE owns classes. The role's list is
 * stored in `workers.classes` under the role's own name (ROUTE_ROLES); every
 * class resolves to its role's list through ROLE_OF_CLASS below, the one
 * mapping table. A class this table does not know (a new or custom one) is a
 * Worker. `orchestrate` is the chat side (session profile), the rest are worker classes.
 */
export const ROUTE_ROLES = ["orchestrator", "worker", "quick"] as const;
export type RouteRole = (typeof ROUTE_ROLES)[number];

export const ROUTE_LABELS: Record<RouteRole, string> = {
  orchestrator: "Orchestrator",
  worker: "Worker",
  quick: "Quick check",
};

/** The one mapping table: class -> role. Unlisted classes are Worker. */
export const ROLE_OF_CLASS: Record<string, RouteRole> = {
  orchestrate: "orchestrator",
  plan: "orchestrator",
  implement: "worker",
  research: "worker",
  draft: "worker",
  review: "worker",
  complex: "worker",
  simple: "quick",
  spotcheck: "quick",
};

/** The classes each role covers (display captions), in table order. */
export const CLASSES_OF_ROLE: Record<RouteRole, string[]> = {
  orchestrator: ["orchestrate", "plan"],
  worker: ["implement", "research", "draft", "review", "complex"],
  quick: ["simple", "spotcheck"],
};

export const isRouteRole = (r: string): r is RouteRole => (ROUTE_ROLES as readonly string[]).includes(r);

/** The role a role name or class name resolves to (unknown classes: worker). */
export const roleOf = (cls: string): RouteRole => (isRouteRole(cls) ? cls : (Object.hasOwn(ROLE_OF_CLASS, cls) ? ROLE_OF_CLASS[cls] : "worker"));

/** The class whose list was the role list before the three-role table (one-time migration). */
const MIGRATION_CLASS: Record<RouteRole, string> = { orchestrator: "orchestrate", worker: "implement", quick: "simple" };

export const MAX_ROUTE_MODELS = 12;

export function parseEntry(entry: string): { provider: string; model: string | null } {
  const i = entry.indexOf("/");
  return i < 0 ? { provider: entry, model: null } : { provider: entry.slice(0, i), model: entry.slice(i + 1) || null };
}

export const entryProvider = (entry: string): string => parseEntry(entry).provider;

/** The ordered entries of a class: its role's `models`, else its single provider[/alias] target, else []. */
export const classRoute = (classes: Record<string, ClassTarget>, cls: string): string[] => targetList(classes[roleOf(cls)]);

function targetList(t: ClassTarget | undefined): string[] {
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

/** The classes as one session sees them: its overridden role rows replace the global ones (other keys of a role target are kept). */
export function applyRouteOverrides(classes: Record<string, ClassTarget>, routes: Record<string, string[]> | undefined): Record<string, ClassTarget> {
  if (!routes) return classes;
  const out = { ...classes };
  for (const [key, models] of Object.entries(routes)) {
    const role = roleOf(key);
    const t = targetForRoute(out[role], models);
    if (t !== undefined) out[role] = t;
  }
  return out;
}

/** The reason note of a global row, if any. */
export const classNote = (classes: Record<string, ClassTarget>, cls: string): string | undefined => {
  const t = classes[roleOf(cls)];
  return typeof t === "object" && t.note ? t.note : undefined;
};

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
    for (const role of ["worker", "quick"] as const) {
      const current = classRoute(classes, role).map(parseEntry);
      const list = workers.map((p) => {
        const had = current.find((e) => e.provider === p && e.model);
        return had ? `${p}/${had.model}` : p;
      });
      const t = targetForRoute(classes[role], list);
      if (t !== undefined) classes[role] = t;
      changed = true;
    }
  }
  const orch = flatLegacyChain(c.orchestrator);
  if (orch.length) {
    const t = targetForRoute(classes.orchestrator, orch);
    if (t !== undefined) classes.orchestrator = t;
    changed = true;
  }
  return changed;
}

/** The rows a policy mode rewrites (the orchestrator's stays). */
export const POLICY_ROLES = ["worker", "quick"] as const;

/**
 * One-time migration of the nine per-class lists into the three role lists:
 * the list of the role's first class (orchestrate, implement, simple) becomes
 * the role list; every per-class list is dropped (other keys of a class target
 * stay). A role that already has a list is left alone. Mutates `classes`;
 * returns whether anything changed.
 */
export function migrateClassRoutes(classes: Record<string, ClassTarget>): boolean {
  let changed = false;
  for (const role of ROUTE_ROLES) {
    if (targetList(classes[role]).length) continue;
    // the role's first class decides; a config without it falls back to the role's next class that has a list
    const src = [MIGRATION_CLASS[role], ...CLASSES_OF_ROLE[role]].find((c) => targetList(classes[c]).length);
    if (src === undefined) continue;
    const from = classes[src];
    const list = targetList(from);
    const t = targetForRoute(classes[role], list);
    if (t !== undefined) classes[role] = typeof from === "object" && from.note ? { ...(typeof t === "object" ? t : { provider: t }), note: from.note } : t;
    changed = true;
  }
  for (const cls of Object.keys(ROLE_OF_CLASS)) {
    if (isRouteRole(cls) || !targetList(classes[cls]).length) continue;
    const t = targetForRoute(classes[cls], []);
    if (t === undefined || !Object.keys(t).length) delete classes[cls];
    else classes[cls] = t;
    changed = true;
  }
  return changed;
}

/** A session's per-class overrides as per-role ones (the role's first class wins); keys that are roles already stay. */
export function migrateSessionRoutes<T>(routes: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const role of ROUTE_ROLES) {
    const key = [role, MIGRATION_CLASS[role]].find((k) => k in routes);
    if (key !== undefined) out[role] = routes[key];
  }
  for (const [k, v] of Object.entries(routes)) {
    const role = roleOf(k);
    if (!(role in out) && !(k in ROLE_OF_CLASS) ) out[role] = v;
  }
  return out;
}

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
