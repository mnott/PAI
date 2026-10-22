/**
 * route-lists.ts — the routing table: per delegation tier an ordered list of models.
 *
 * Element 0 is what the tier serves on when available; the rest is its
 * fallback order. One entry names a provider and optionally one of its models:
 * "gyro-m" (a local model, or a provider's default for the class), "glm/fast"
 * (a model alias), "glm/glm-5.3-flash" or "anthropic/opus" (a model id). The
 * list lives in the `tiers:` list of workers.yaml, one `models: [...]` per tier. Pure functions only; the I/O (validation against the
 * providers, persistence, state) is in route-table.ts.
 */

import type { ClassTarget } from "./config.js";

/**
 * A delegation tier (workers.yaml `tiers:`), not a fallback rank. The tier set,
 * its names, descriptions, ordered model lists, the class -> tier mapping, the
 * default tier for unknown classes and the session-start flag are all config;
 * nothing here names a tier. Typically t0 is the interactive session (PAI
 * starts a session on its first available model), t1 an orchestrator that
 * plans and reviews, t2 the workers that implement and run quick checks.
 */
export interface TierDef {
  id: string;
  name: string;
  description?: string;
  /** Ordered entries: the first available one serves, the rest is the fallback order. */
  models: string[];
  /** The classes this tier serves (the class -> tier mapping). */
  classes?: string[];
  /** Serves every class no tier lists. */
  default?: boolean;
  /** PAI starts sessions on this tier (`pai launch`, session-start defaults). */
  session?: boolean;
  /** Reason note (tooltip). */
  note?: string;
  /** Escalation triggers / thresholds: carried through, read by whoever evaluates them. */
  escalation?: Record<string, unknown>;
}

/**
 * Resolve the `local` placeholder entry — the shipped defaults' way of naming
 * "the running local tier, whatever it is called" without hard-coding a model
 * name: the `local:` preference (workers.yaml's `local:` key) when set, else
 * the first enabled local provider. Returns null when no local provider is
 * configured, so the entry drops out of the list.
 */
export function resolveLocalEntry(
  entry: string,
  local: string | null
): string | null {
  if (entry !== "local") return entry;
  return local;
}

/** Parse a `tiers` value (JSON or YAML); throws a readable message naming the field. */
export function parseTiersValue(
  v: unknown,
  path = "tiers",
  local: string | null = null
): TierDef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${path}: must be a list of tiers`);
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const at = `${path}[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${at}: must be a mapping`);
    const o = raw as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      if (o[k] === undefined || o[k] === null) return undefined;
      if (typeof o[k] !== "string") throw new Error(`${at}.${k}: must be a string`);
      return (o[k] as string).trim() || undefined;
    };
    const list = (k: string): string[] | undefined => {
      if (o[k] === undefined || o[k] === null) return undefined;
      if (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => typeof x !== "string")) throw new Error(`${at}.${k}: must be a list of strings`);
      return [...new Set((o[k] as string[]).map((x) => x.trim()).filter(Boolean))];
    };
    const id = str("id");
    if (!id) throw new Error(`${at}.id: is required`);
    if (seen.has(id)) throw new Error(`${at}.id: duplicate tier "${id}"`);
    seen.add(id);
    // a `local` placeholder entry resolves to the configured local provider
    // (null: none configured — the entry drops out of the list)
    const models = (list("models") ?? [])
      .map((e) => resolveLocalEntry(e, local))
      .filter((e): e is string => e !== null);
    if (!models.length) throw new Error(`${at}.models: tier "${id}" needs at least one model`);
    const esc = o.escalation;
    if (esc !== undefined && (typeof esc !== "object" || esc === null || Array.isArray(esc))) throw new Error(`${at}.escalation: must be a mapping`);
    const classes = list("classes");
    return {
      id,
      name: str("name") ?? id,
      ...(str("description") ? { description: str("description") } : {}),
      models,
      ...(classes?.length ? { classes } : {}),
      ...(o.default === true ? { default: true } : {}),
      ...(o.session === true ? { session: true } : {}),
      ...(str("note") ? { note: str("note") } : {}),
      ...(esc ? { escalation: esc as Record<string, unknown> } : {}),
    };
  });
}

/** The tier a tier id or class name resolves to: the id itself, the tier listing the class, else the default tier. */
export function findTier(tiers: TierDef[], name: string): TierDef | undefined {
  return tiers.find((t) => t.id === name) ?? tiers.find((t) => t.classes?.includes(name)) ?? tiers.find((t) => t.default);
}

/** The ordered entries serving a class (its tier's models); [] when no tier covers it. */
export const classRoute = (tiers: TierDef[], cls: string): string[] => [...(findTier(tiers, cls)?.models ?? [])];

/** The tier PAI starts sessions on. */
export const sessionTier = (tiers: TierDef[]): TierDef | undefined => tiers.find((t) => t.session);

/** The tiers as one session sees them: its overridden tiers replace the global model lists. */
export function applyRouteOverrides(tiers: TierDef[], routes: Record<string, string[]> | undefined): TierDef[] {
  if (!routes) return tiers;
  return tiers.map((t) => (routes[t.id]?.length ? { ...t, models: [...routes[t.id]] } : t));
}

/** The retired three-role table's keys, stored in `workers.classes` before tiers: orchestrator -> t1, worker and quick -> t2. */
const LEGACY_ROLES = ["orchestrator", "worker", "quick"] as const;
type LegacyRole = (typeof LEGACY_ROLES)[number];
const LEGACY_ROLE_CLASSES: Record<LegacyRole, string[]> = {
  orchestrator: ["orchestrate", "plan"],
  worker: ["implement", "research", "draft", "review", "complex"],
  quick: ["simple", "spotcheck"],
};
/** The class whose list was the role list before the three-role table. */
const MIGRATION_CLASS: Record<LegacyRole, string> = { orchestrator: "orchestrate", worker: "implement", quick: "simple" };

export const MAX_ROUTE_MODELS = 12;

export function parseEntry(entry: string): { provider: string; model: string | null } {
  const i = entry.indexOf("/");
  return i < 0 ? { provider: entry, model: null } : { provider: entry.slice(0, i), model: entry.slice(i + 1) || null };
}

export const entryProvider = (entry: string): string => parseEntry(entry).provider;

/** The routing list a class target stores (a plain target is a list of one). */
export function targetList(t: ClassTarget | undefined): string[] {
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
    for (const role of ["worker", "quick"] as const) {
      const current = targetList(classes[role]).map(parseEntry);
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

/**
 * One-time migration of the nine per-class lists into the retired three role
 * lists (orchestrator / worker / quick, step one of the migration to tiers):
 * the list of the role's first class becomes the role list; every per-class
 * list is dropped (other keys of a class target stay). A role that already has
 * a list is left alone. Mutates `classes`; returns whether anything changed.
 */
export function migrateClassRoutes(classes: Record<string, ClassTarget>): boolean {
  let changed = false;
  for (const role of LEGACY_ROLES) {
    if (targetList(classes[role]).length) continue;
    // the role's first class decides; a config without it falls back to the role's next class that has a list
    const src = [MIGRATION_CLASS[role], ...LEGACY_ROLE_CLASSES[role]].find((c) => targetList(classes[c]).length);
    if (src === undefined) continue;
    const from = classes[src];
    const list = targetList(from);
    const t = targetForRoute(classes[role], list);
    if (t !== undefined) classes[role] = typeof from === "object" && from.note ? { ...(typeof t === "object" ? t : { provider: t }), note: from.note } : t;
    changed = true;
  }
  for (const cls of LEGACY_ROLES.flatMap((r) => LEGACY_ROLE_CLASSES[r])) {
    if (!targetList(classes[cls]).length) continue;
    const t = targetForRoute(classes[cls], []);
    if (t === undefined || !Object.keys(t).length) delete classes[cls];
    else classes[cls] = t;
    changed = true;
  }
  return changed;
}

/**
 * One-time migration of the three role lists (`workers.classes` keys
 * orchestrator / worker / quick) into `tiers`, the config the code reads from
 * then on. Output, not code constants: t0 Session (anthropic/opus, then
 * glm/glm-5.3[1m]; PAI starts sessions on it), t1 Orchestrator (anthropic/sonnet,
 * glm/glm-5.3-flash, then the old orchestrator list), t2 Worker (the old worker
 * list, the default tier; the Quick check classes fold into it, and a Quick
 * check order that differed is kept in the tier description). The role keys are
 * dropped from `classes`. Does nothing when `tiers` exist or no role list does.
 * Mutates both; returns whether anything changed.
 */
export function migrateToTiers(config: { classes: Record<string, ClassTarget>; tiers: TierDef[] }): boolean {
  const { classes } = config;
  if (config.tiers.length) return false;
  const list = (r: LegacyRole) => targetList(classes[r]);
  const note = (r: LegacyRole) => (typeof classes[r] === "object" ? (classes[r] as Exclude<ClassTarget, string>).note : undefined);
  const present = LEGACY_ROLES.filter((r) => list(r).length);
  if (!present.length) return false;
  const tiers: TierDef[] = [
    { id: "t0", name: "Session", description: "The interactive session itself; PAI starts sessions on it.", models: ["anthropic/opus", "glm/glm-5.3[1m]"], session: true, note: "context width, reasoning" },
  ];
  const orch = [...new Set(["anthropic/sonnet", "glm/glm-5.3-flash", ...list("orchestrator")])];
  tiers.push({ id: "t1", name: "Orchestrator", description: "Splits a job, plans and reviews; its workers implement the parts.", models: orch, classes: ["orchestrate", "plan"], note: note("orchestrator") ?? "planning, reasoning" });
  const workers = list("worker").length ? list("worker") : list("quick");
  const quickDiffers = list("quick").length > 0 && list("quick").join(">") !== workers.join(">");
  tiers.push({
    id: "t2",
    name: "Worker",
    description: `Implements the parts and runs quick checks.${quickDiffers ? ` Folded from Quick check, whose order was ${list("quick").join(" > ")}.` : ""}`,
    models: workers,
    classes: [...LEGACY_ROLE_CLASSES.worker, ...LEGACY_ROLE_CLASSES.quick],
    default: true,
    ...(note("worker") ? { note: note("worker") } : {}),
  });
  config.tiers = tiers;
  for (const r of LEGACY_ROLES) delete classes[r];
  return true;
}

/**
 * One-time migration of legacy per-class pins (`workers.classes` entries that
 * name a route — a plain target, or an object with `provider`/`models`) into
 * the tier lists, so the tier list is the only routing source for every class:
 * the pin becomes its tier's first entry (an entry the tier already lists is
 * left in place, not duplicated), the class key is dropped from `classes`; a
 * class target carrying only constraints (mcp, cost tier, tags, order) stays.
 * A class no tier lists keeps its pin — it is that class's own routing list,
 * not a legacy leak. Mutates both; returns the migrated `class=target`
 * descriptions (empty when nothing moved). No-op when no tier covers the pin.
 */
export function migrateClassPins(classes: Record<string, ClassTarget>, tiers: TierDef[]): string[] {
  if (!tiers.length) return [];
  const moved: string[] = [];
  for (const cls of Object.keys(classes)) {
    // only a class a tier explicitly serves leaks: the default tier standing in
    // for an unlisted class must not swallow a custom class's own list
    const tier = tiers.find((t) => t.id === cls || t.classes?.includes(cls));
    if (!tier) continue;
    const t = classes[cls];
    const list = targetList(t);
    if (!list.length) continue;
    if (!list.every((e) => tier.models.includes(e))) tier.models = [...list, ...tier.models.filter((e) => !list.includes(e))];
    const rest = targetForRoute(t, []);
    if (rest === undefined || !Object.keys(rest).length) delete classes[cls];
    else classes[cls] = rest;
    moved.push(`${cls}=${list.join(">")}`);
  }
  return moved;
}

/**
 * The retired three-role table's keys (workers.classes keys orchestrator /
 * worker / quick) folded into the class -> tier mapping: a tier's `classes`
 * gain the role's classes when the tier serves any of them. The role keys
 * themselves are dropped by migrateToTiers when it builds the tiers; a config
 * that already has tiers (so migrateToTiers no-ops) is covered here. Mutates
 * `classes` and the tiers; returns whether anything changed.
 */
export function foldLegacyRoles(classes: Record<string, ClassTarget>, tiers: TierDef[]): string[] {
  const folded: string[] = [];
  for (const role of LEGACY_ROLES) {
    if (!(role in classes)) continue;
    const list = targetList(classes[role]);
    delete classes[role];
    for (const tier of tiers) {
      if (!tier.classes?.some((c) => LEGACY_ROLE_CLASSES[role].includes(c))) continue;
      if (list.length && !list.every((e) => tier.models.includes(e))) tier.models = [...list, ...tier.models.filter((e) => !list.includes(e))];
      const added = LEGACY_ROLE_CLASSES[role].filter((c) => !tier.classes!.includes(c));
      if (added.length) tier.classes = [...tier.classes, ...added];
    }
    folded.push(`${role}=${list.join(">") || "(no list)"}`);
  }
  return folded;
}

/** A session's overrides keyed by the retired role or class names as tier-keyed ones (first of a tier's keys wins); keys of no retired name stay. */
export function migrateSessionRoutes<T>(routes: Record<string, T>): Record<string, T> {
  const tierOfLegacy = (k: string): string | undefined => {
    if (k === "orchestrator" || LEGACY_ROLE_CLASSES.orchestrator.includes(k)) return "t1";
    if (k === "worker" || k === "quick" || [...LEGACY_ROLE_CLASSES.worker, ...LEGACY_ROLE_CLASSES.quick].includes(k)) return "t2";
    return undefined;
  };
  const out: Record<string, T> = {};
  const rank = (k: string) => (["worker", "orchestrator", "implement", "orchestrate"].includes(k) ? 0 : k === "quick" ? 1 : 2);
  for (const [k, v] of Object.entries(routes).sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const id = tierOfLegacy(k) ?? k;
    if (!(id in out)) out[id] = v;
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
