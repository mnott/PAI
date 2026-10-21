/**
 * route-table.ts — the routing table (cockpit "routing" section, `pai worker route`).
 *
 * One row per delegation tier, as configured in workers.yaml `tiers:`
 * (route-lists.ts TierDef): each an ordered list of models, the first
 * available one serves, the rest is the fallback order. Every class resolves
 * to its tier through the config's class -> tier mapping. Local models are
 * entries like any other; a local entry whose server is not running is skipped
 * at routing time (policy.ts listRoute), never started. Routing (routeRun /
 * resolveTarget) and this display read the same lists; `route set` writes
 * through setRoute, so there is one code path.
 */

import {
  ANTHROPIC_NATIVE,
  getProviderOrNative,
  isLocalProvider,
  nativeAnthropicProvider,
  readWorkersSection,
  resolveModelCapability,
  writeWorkersSection,
  type ClassTarget,
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { budgetFull, type BudgetMap } from "./budget.js";
import type { LocalInstance } from "./local-instances.js";
import { readLocalPreference } from "./local-provider.js";
import { isLocalCandidate, tierProviderNames } from "./local-candidate.js";
import { cooldownRemaining, quotaExceeded, readRoutingState } from "./routing.js";
import { detectSessionName } from "./session-name.js";
import { readProfiles, updateProfile, type Profiles, type SessionProfile } from "./session-profile-store.js";
import { pingLocal, type PolicyMode } from "./policy.js";
import {
  MAX_ROUTE_MODELS,
  applyRouteOverrides,
  entryProvider,
  findTier,
  parseEntry,
  sessionTier,
  listForPolicy,
  type TierDef,
} from "./route-lists.js";

/** Window percent above which a chip turns amber (budget tight). */
export const TIGHT_PERCENT = 80;

export type ChipState = "available" | "tight" | "idle" | "unavailable";

export interface RouteChip {
  /** The stored entry ("gyro-m", "glm/fast", "anthropic/opus"). */
  entry: string;
  /** Shown text: "local gyro-m" or "provider/model". */
  label: string;
  provider: string;
  local: boolean;
  state: ChipState;
  /** Why the chip is not green. */
  why: string;
}

/** One session's override of a row. */
export interface SessionRouteRow {
  session: string;
  chips: RouteChip[];
  note?: string;
}

export interface RouteRow {
  /** The tier id ("t0", "t1", ...). */
  id: string;
  /** "t1 Orchestrator". */
  label: string;
  /** What the tier is for (config). */
  description?: string;
  /** PAI starts sessions on this tier. */
  session?: boolean;
  /** The classes this row covers (grey caption). */
  classes: string[];
  chips: RouteChip[];
  /** Reason note (tooltip). */
  note?: string;
  /** This row is the session's own override (a per-session view). */
  overridden?: boolean;
  /** The sessions that override this row (the global view). */
  sessions?: SessionRouteRow[];
}

export interface RouteChoice {
  entry: string;
  label: string;
  local: boolean;
}


/** A routing entry that names a set of endpoints instead of one provider. */
export type Selector =
  | { kind: "local" }
  | { kind: "model"; name: string }
  | { kind: "tag"; name: string }
  | { kind: "class"; name: string };

/** `local`, `model:<name>`, `tag:<t>`, `class:<c>`; null for a provider entry ("gyro-m", "glm/fast"), which stays valid. */
export function parseSelector(entry: string): Selector | null {
  const e = entry.trim();
  if (e === "local") return { kind: "local" };
  const m = /^(model|tag|class):(.*)$/.exec(e);
  if (!m) return null;
  const name = m[2].trim();
  if (!name || /\s/.test(name)) throw new Error(`selector "${e}" needs a name after "${m[1]}:"`);
  return { kind: m[1] as "model" | "tag" | "class", name };
}

const loopbackUrl = (url: string): boolean => {
  try {
    return isLocalProvider(url);
  } catch {
    return false;
  }
};

/** The healthy instances a selector matches right now; the caller's pickInstance chooses among them. Provider entries match the instances of that provider. */
export function resolveSelector(selector: string, instances: LocalInstance[]): LocalInstance[] {
  const ready = instances.filter((i) => i.state === "ready");
  const sel = parseSelector(selector);
  if (!sel) return ready.filter((i) => i.provider === parseEntry(selector).provider);
  switch (sel.kind) {
    case "local":
      return ready.filter((i) => i.origin === "managed" || loopbackUrl(i.url));
    case "model":
      return ready.filter((i) => i.model === sel.name);
    case "tag":
      return ready.filter((i) => i.characteristics?.tags?.includes(sel.name));
    case "class":
      return ready.filter((i) => i.characteristics?.classes?.includes(sel.name));
  }
}

const providerOf = (workers: WorkersConfig, name: string): WorkerProvider | undefined =>
  name === ANTHROPIC_NATIVE ? nativeAnthropicProvider(workers.nativeModels) : getProviderOrNative(workers, name);

const isLocalName = (workers: WorkersConfig, name: string): boolean => isLocalProvider(workers.providers[name]?.baseUrl ?? "");

/** The models a cloud provider offers: each distinct model of its table (the image model excluded), the built-in tiers for anthropic. */
function cloudModels(name: string, p: WorkerProvider): string[] {
  const own = Object.entries(p.models).filter(([k]) => k !== "image").map(([, v]) => v).filter((v): v is string => !!v);
  return [...new Set(name === ANTHROPIC_NATIVE ? ["opus", "sonnet", "haiku", ...own] : own)];
}

/** Every model a row can take: each enabled cloud provider's models, each enabled local model. */
export function routeChoices(workers: WorkersConfig, tiers: string[] = tierProviderNames()): RouteChoice[] {
  const out: RouteChoice[] = [];
  const names = [ANTHROPIC_NATIVE, ...Object.keys(workers.providers).filter((n) => n !== ANTHROPIC_NATIVE)];
  for (const name of names) {
    const p = providerOf(workers, name);
    if (!p || p.engine === "image" || !(p.enabled || (isLocalProvider(p.baseUrl) && isLocalCandidate(p, name, tiers)))) continue;
    if (isLocalProvider(p.baseUrl)) out.push({ entry: name, label: `local ${name}`, local: true });
    else for (const m of cloudModels(name, p)) out.push({ entry: `${name}/${m}`, label: `${name}/${m}`, local: false });
  }
  return out;
}

/** Validate and normalise the entries of a row (trimmed, no duplicates); throws a readable message. */
export function validateRoute(workers: WorkersConfig, row: string, models: unknown): string[] {
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) throw new Error("models must be a list of provider/model entries");
  const entries = [...new Set((models as string[]).map((m) => m.trim()).filter(Boolean))];
  if (!entries.length) throw new Error(`${row} needs at least one model`);
  if (entries.length > MAX_ROUTE_MODELS) throw new Error(`at most ${MAX_ROUTE_MODELS} models per row`);
  for (const e of entries) {
    if (parseSelector(e)) continue;
    const { provider, model } = parseEntry(e);
    const p = providerOf(workers, provider);
    if (!p || p.engine === "image") throw new Error(`no provider named "${provider}" in "${e}"`);
    if (isLocalProvider(p.baseUrl)) {
      if (model) throw new Error(`"${e}": a local model is named by its provider (${provider})`);
    } else if (model && !Object.keys(p.models).includes(model) && !cloudModels(provider, p).includes(model)) {
      throw new Error(`provider "${provider}" has no model "${model}" (${cloudModels(provider, p).join(", ")})`);
    }
  }
  return entries;
}

export interface RouteChange {
  /** The tier id. */
  id: string;
  entries: string[];
  /** Ledger text of the change. */
  text: string;
}

const tierFor = (workers: WorkersConfig, name: string): TierDef => {
  const t = findTier(workers.tiers, name);
  if (!t) throw new Error(`no tier or class "${name}" (tiers: ${workers.tiers.map((x) => x.id).join(", ") || "none configured"})`);
  return t;
};

/** Set one row (a tier id, or a class: it sets its tier's row) and persist it through the config writers (`path` overrides the main config, tests). */
export function setRoute(name: string, models: unknown, path?: string, note?: string): RouteChange {
  const { raw, workers } = readWorkersSection(path);
  const tier = tierFor(workers, name);
  const entries = validateRoute(workers, tier.id, models);
  tier.models = entries;
  if (note !== undefined) {
    if (note.trim()) tier.note = note.trim();
    else delete tier.note;
  }
  if (tier.session) {
    // the chat side runs on the session tier's first model (session profile), as the active provider always did
    const session = (raw.session ?? {}) as Record<string, unknown>;
    const profile = (session.profile ?? {}) as Record<string, unknown>;
    profile.chat = { ...((profile.chat ?? {}) as Record<string, unknown>), provider: entryProvider(entries[0]) };
    session.profile = profile;
    raw.session = session;
  }
  writeWorkersSection(raw, workers, path);
  return { id: tier.id, entries, text: `${tier.id}=${entries.join(">")}` };
}

/** Resolve a session argument: a name, or "self" / empty for this session. */
export async function resolveSessionArg(session: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const s = session?.trim();
  const name = !s || s === "self" ? await detectSessionName(env) : s;
  if (!name) throw new Error("this session has no name; pass its persistent name");
  return name;
}

/** Override one routing row for a session (stored in its profile, the global table is untouched). */
export function setSessionRoute(session: string, name: string, models: unknown, opts: { note?: string; path?: string; profilesPath?: string } = {}): RouteChange {
  const { workers } = readWorkersSection(opts.path);
  const cls = tierFor(workers, name).id;
  const entries = validateRoute(workers, cls, models);
  const cur = readProfiles(opts.profilesPath)[session] ?? {};
  const notes = { ...(cur.route_notes ?? {}) };
  if (opts.note !== undefined) {
    if (opts.note.trim()) notes[cls] = opts.note.trim();
    else delete notes[cls];
  }
  updateProfile(session, { routes: { ...(cur.routes ?? {}), [cls]: entries }, route_notes: Object.keys(notes).length ? notes : null }, opts.profilesPath);
  return { id: cls, entries, text: `${session}: ${cls}=${entries.join(">")}` };
}

/** Drop one override (or all of a session's); the global row applies again. */
export function clearSessionRoute(session: string, name?: string, profilesPath?: string, path?: string): string {
  const cls = name ? tierFor(readWorkersSection(path).workers, name).id : undefined;
  const cur = readProfiles(profilesPath)[session];
  if (!cur?.routes || (cls && !cur.routes[cls])) return cls ? `${session}: no override for ${cls}` : `${session}: no overrides`;
  const routes = { ...cur.routes };
  const notes = { ...(cur.route_notes ?? {}) };
  for (const c of cls ? [cls] : Object.keys(routes)) {
    delete routes[c];
    delete notes[c];
  }
  updateProfile(session, { routes: Object.keys(routes).length ? routes : null, route_notes: Object.keys(notes).length ? notes : null }, profilesPath);
  return `${session}: ${cls ? `${cls} override cleared` : "overrides cleared"}`;
}

/** The enabled local provider `local:` names, else the first enabled one. */
export function configuredLocal(workers: WorkersConfig): string | null {
  const tiers = tierProviderNames();
  const locals = Object.entries(workers.providers).filter(([n, p]) => p.engine !== "image" && isLocalProvider(p.baseUrl) && isLocalCandidate(p, n, tiers)).map(([n]) => n);
  const pref = readLocalPreference();
  return pref && locals.includes(pref) ? pref : (locals[0] ?? null);
}

/** A policy mode rewrites the default tier's row (prefer-local: the `local:` provider to the front); the session and orchestrator tiers stay. */
export function applyPolicyToRoutes(mode: PolicyMode, path?: string): string {
  const { raw, workers } = readWorkersSection(path);
  const local = configuredLocal(workers);
  const done: string[] = [];
  for (const tier of workers.tiers.filter((t) => t.default)) {
    tier.models = listForPolicy(mode, tier.models, (n) => isLocalName(workers, n), local);
    done.push(`${tier.id}=${tier.models.join(">")}`);
  }
  if (done.length) writeWorkersSection(raw, workers, path);
  return done.join(" ");
}

/** "local gyro-m" or "glm/glm-5.3-flash": the model an entry resolves to for its class. */
export function entryLabel(workers: WorkersConfig, tier: TierDef, entry: string): string {
  if (parseSelector(entry)) return entry;
  const { provider, model } = parseEntry(entry);
  const p = providerOf(workers, provider);
  if (p && isLocalProvider(p.baseUrl)) return `local ${provider}`;
  if (!p) return entry;
  // an unnamed entry serves the provider's default model; a cheap model for a
  // class is a tier entry (`glm/fast`), never a class rule
  const shown = model ? (p.models[model] ?? model) : resolveModelCapability(p, "default");
  return `${provider}/${shown}`;
}

export interface ViewDeps {
  /** Is this local provider's server answering? Default: one models request. */
  running?: (name: string, p: WorkerProvider) => Promise<boolean>;
  budgets?: BudgetMap;
  /** The registry (managed + registered endpoints); selector chips resolve against it. */
  instances?: LocalInstance[];
  logDir: string;
  now?: Date;
  /** The effective table of this session: its overridden rows replace the global ones (marked `overridden`). */
  session?: SessionProfile | null;
  /** All profiles: the global view lists under each row the sessions overriding it. */
  profiles?: Profiles;
  /** Providers a local tier launches (default: read from workers.yaml). */
  tiers?: string[];
}

async function chipOf(workers: WorkersConfig, tier: TierDef, entry: string, deps: ViewDeps, state: ReturnType<typeof readRoutingState>): Promise<RouteChip> {
  if (parseSelector(entry)) {
    const n = resolveSelector(entry, deps.instances ?? []).length;
    return { entry, label: entry, provider: entry, local: entry === "local" || /^model:/.test(entry), state: n ? "available" : "idle", why: n ? "" : "no matching instance" };
  }
  const { provider } = parseEntry(entry);
  const p = providerOf(workers, provider);
  const base = { entry, label: entryLabel(workers, tier, entry), provider };
  if (!p) return { ...base, local: false, state: "unavailable", why: "not configured" };
  if (isLocalProvider(p.baseUrl)) {
    if (!p.enabled && !isLocalCandidate(p, provider, deps.tiers ?? tierProviderNames())) return { ...base, local: true, state: "idle", why: "disabled" };
    const up = await (deps.running ?? ((_n, q) => pingLocal(q.baseUrl, 1500)))(provider, p).catch(() => false);
    return { ...base, local: true, state: up ? "available" : "idle", why: up ? "" : "not running" };
  }
  const bad = (why: string): RouteChip => ({ ...base, local: false, state: "unavailable", why });
  if (!p.enabled) return bad("disabled");
  const cool = cooldownRemaining(state, provider, deps.now);
  if (cool > 0) return bad(`cooldown ${Math.ceil(cool / 60000)} min`);
  if (quotaExceeded(p)) return bad("quota");
  const r = deps.budgets?.[provider];
  const hit = budgetFull(workers.routing, provider, r);
  if (hit) return bad(`budget ${Math.round(hit.percent)}%`);
  const top = Math.max(r?.percent ?? 0, ...(r?.windows ?? []).map((w) => w.percent));
  if (top > TIGHT_PERCENT) return { ...base, local: false, state: "tight", why: `budget ${Math.round(top)}%` };
  return { ...base, local: false, state: "available", why: "" };
}

/** The table as displayed: the rows of the lists routing reads, each chip with its live state. */
export async function routeRows(workers: WorkersConfig, deps: ViewDeps): Promise<RouteRow[]> {
  const state = readRoutingState(deps.logDir);
  const rows: RouteRow[] = [];
  for (const tier of workers.tiers) {
    const own = deps.session?.routes?.[tier.id];
    const entries = own ?? tier.models;
    if (!entries.length) continue;
    const note = (own ? deps.session?.route_notes?.[tier.id] : undefined) ?? tier.note;
    const row: RouteRow = {
      id: tier.id,
      label: `${tier.id} ${tier.name}`,
      ...(tier.description ? { description: tier.description } : {}),
      ...(tier.session ? { session: true } : {}),
      classes: tier.classes ?? (tier.default ? ["(any other class)"] : []),
      chips: await Promise.all(entries.map((e) => chipOf(workers, tier, e, deps, state))),
      ...(note ? { note } : {}),
      ...(own ? { overridden: true } : {}),
    };
    const sessions = Object.entries(deps.profiles ?? {}).filter(([, p]) => p.routes?.[tier.id]);
    if (sessions.length) {
      row.sessions = await Promise.all(
        sessions.map(async ([session, p]) => ({
          session,
          chips: await Promise.all(p.routes![tier.id].map((e) => chipOf(workers, tier, e, deps, state))),
          ...(p.route_notes?.[tier.id] ? { note: p.route_notes[tier.id] } : {}),
        }))
      );
    }
    rows.push(row);
  }
  return rows;
}

/** The chip serving a row right now: the first one that is not unavailable / down. "Anthropic out" (budget, cooldown, quota) skips to the next entry. */
export const servingChip = (chips: RouteChip[]): RouteChip | undefined => chips.find((c) => c.state === "available" || c.state === "tight");

/** The flow line steps: each tier in config order with what it resolves to now (null: nothing available). */
export function tierFlow(rows: RouteRow[]): { id: string; label: string; resolved: string | null }[] {
  const short = (l: string) => l.replace(/^anthropic\//, "");
  return rows.map((r) => ({ id: r.id, label: r.label, resolved: ((c) => (c ? short(c.label) : null))(servingChip(r.chips)) }));
}

/** "t0 Session: opus → t1 Orchestrator: sonnet → t2 Worker: local gyro-m". */
export const flowText = (rows: RouteRow[]): string => tierFlow(rows).map((f) => `${f.label}: ${f.resolved ?? "none available"}`).join(" → ");

/** Where PAI starts a session: the session tier's first available entry (running sessions are not touched). */
export async function sessionStartTarget(workers: WorkersConfig, deps: ViewDeps): Promise<{ entry: string; provider: string; model: string | null; tier: string } | null> {
  const tier = sessionTier(workers.tiers);
  if (!tier) return null;
  const chip = servingChip((await routeRows({ ...workers, tiers: [tier] }, { ...deps, session: null, profiles: undefined }))[0]?.chips ?? []);
  if (!chip) return null;
  const { provider, model } = parseEntry(chip.entry);
  return { entry: chip.entry, provider, model, tier: tier.id };
}

/** `pai worker route`: the flow line, then one line per tier, "label  a → b → c [classes]", with the reason after a chip that is not available. */
export function routeText(rows: RouteRow[]): string {
  const grey = (t: string) => (process.stdout.isTTY ? `\x1b[90m${t}\x1b[0m` : t);
  const chips = (cs: RouteChip[]) => cs.map((c) => `${c.label}${c.state === "available" ? "" : ` (${c.why || c.state})`}`).join(" → ");
  const width = Math.max(0, ...rows.map((r) => r.label.length));
  return [
    `  ${flowText(rows)}`,
    ...rows.flatMap((r) => [
      `  ${r.label.padEnd(width)}  ${chips(r.chips)}${r.classes.length ? `  ${grey(`[${r.classes.join(", ")}]`)}` : ""}${r.session ? "  (session start)" : ""}${r.overridden ? "  [session override]" : ""}${r.note ? `  # ${r.note}` : ""}`,
      ...(r.sessions ?? []).map((x) => `    ${x.session}: ${chips(x.chips)}${x.note ? `  # ${x.note}` : ""}`),
    ]),
  ].join("\n");
}
