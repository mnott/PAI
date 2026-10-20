/**
 * route-table.ts — the routing table (cockpit "routing" section, `pai worker route`).
 *
 * Three rows, one per role (Orchestrator / Worker / Quick check), each an
 * ordered list of models (route-lists.ts): element 0 serves, the rest is the
 * fallback order. Every class resolves to its role's row (ROLE_OF_CLASS). Local models are entries like any
 * other; a local entry whose server is not running is skipped at routing time
 * (policy.ts listRoute), never started. Routing (routeRun / resolveTarget) and
 * this display read the same lists from `workers.classes`; the cockpit and the
 * CLI write through setRoute, so there is one code path.
 */

import {
  ANTHROPIC_NATIVE,
  classModelCapability,
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
import { readLocalPreference } from "./local-provider.js";
import { cooldownRemaining, quotaExceeded, readRoutingState } from "./routing.js";
import { detectSessionName } from "./session-name.js";
import { readProfiles, updateProfile, type Profiles, type SessionProfile } from "./session-profile-store.js";
import { pingLocal, type PolicyMode } from "./policy.js";
import {
  MAX_ROUTE_MODELS,
  CLASSES_OF_ROLE,
  POLICY_ROLES,
  ROUTE_LABELS,
  ROUTE_ROLES,
  classNote,
  classRoute,
  entryProvider,
  listForPolicy,
  parseEntry,
  roleOf,
  targetForRoute,
  type RouteRole,
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
  /** The role key ("orchestrator" | "worker" | "quick"). */
  cls: RouteRole;
  label: string;
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


const providerOf = (workers: WorkersConfig, name: string): WorkerProvider | undefined =>
  name === ANTHROPIC_NATIVE ? nativeAnthropicProvider(workers.nativeModels) : getProviderOrNative(workers, name);

const isLocalName = (workers: WorkersConfig, name: string): boolean => isLocalProvider(workers.providers[name]?.baseUrl ?? "");

/** The models a cloud provider offers: each distinct model of its table (the image model excluded), the built-in tiers for anthropic. */
function cloudModels(name: string, p: WorkerProvider): string[] {
  const own = Object.entries(p.models).filter(([k]) => k !== "image").map(([, v]) => v).filter((v): v is string => !!v);
  return [...new Set(name === ANTHROPIC_NATIVE ? ["opus", "sonnet", "haiku", ...own] : own)];
}

/** Every model a row can take: each enabled cloud provider's models, each enabled local model. */
export function routeChoices(workers: WorkersConfig): RouteChoice[] {
  const out: RouteChoice[] = [];
  const names = [ANTHROPIC_NATIVE, ...Object.keys(workers.providers).filter((n) => n !== ANTHROPIC_NATIVE)];
  for (const name of names) {
    const p = providerOf(workers, name);
    if (!p || !p.enabled || p.engine === "image") continue;
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
  cls: RouteRole;
  entries: string[];
  /** Ledger text of the change. */
  text: string;
}

/** Set one row (a role, or a class: it sets its role's row) and persist it through the config writers (`path` overrides the main config, tests). */
export function setRoute(name: string, models: unknown, path?: string, note?: string): RouteChange {
  const cls = roleOf(name);
  const { raw, workers } = readWorkersSection(path);
  const entries = validateRoute(workers, cls, models);
  const target = targetForRoute(workers.classes[cls], entries);
  if (target !== undefined) workers.classes[cls] = target;
  if (note !== undefined) {
    const { note: _old, ...rest } = typeof workers.classes[cls] === "object" ? (workers.classes[cls] as Exclude<ClassTarget, string>) : {};
    workers.classes[cls] = note.trim()
      ? { ...rest, provider: entryProvider(entries[0]), models: [...entries], note: note.trim() }
      : (targetForRoute(rest, entries) ?? rest);
  }
  if (cls === "orchestrator") {
    // the chat side runs on the first model's provider (session profile), as the active provider always did
    const session = (raw.session ?? {}) as Record<string, unknown>;
    const profile = (session.profile ?? {}) as Record<string, unknown>;
    profile.chat = { ...((profile.chat ?? {}) as Record<string, unknown>), provider: entryProvider(entries[0]) };
    session.profile = profile;
    raw.session = session;
  }
  writeWorkersSection(raw, workers, path);
  return { cls, entries, text: `${cls}=${entries.join(">")}` };
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
  const cls = roleOf(name);
  const { workers } = readWorkersSection(opts.path);
  const entries = validateRoute(workers, cls, models);
  const cur = readProfiles(opts.profilesPath)[session] ?? {};
  const notes = { ...(cur.route_notes ?? {}) };
  if (opts.note !== undefined) {
    if (opts.note.trim()) notes[cls] = opts.note.trim();
    else delete notes[cls];
  }
  updateProfile(session, { routes: { ...(cur.routes ?? {}), [cls]: entries }, route_notes: Object.keys(notes).length ? notes : null }, opts.profilesPath);
  return { cls, entries, text: `${session}: ${cls}=${entries.join(">")}` };
}

/** Drop one override (or all of a session's); the global row applies again. */
export function clearSessionRoute(session: string, name?: string, profilesPath?: string): string {
  const cls = name ? roleOf(name) : undefined;
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
  const locals = Object.entries(workers.providers).filter(([, p]) => p.enabled && p.engine !== "image" && isLocalProvider(p.baseUrl)).map(([n]) => n);
  const pref = readLocalPreference();
  return pref && locals.includes(pref) ? pref : (locals[0] ?? null);
}

/** A policy mode rewrites the Worker and Quick check rows (prefer-local: the `local:` provider to the front). */
export function applyPolicyToRoutes(mode: PolicyMode, path?: string): string {
  const { raw, workers } = readWorkersSection(path);
  const local = configuredLocal(workers);
  const done: string[] = [];
  for (const cls of POLICY_ROLES) {
    const current = classRoute(workers.classes, cls);
    if (!current.length) continue;
    const next = listForPolicy(mode, current, (n) => isLocalName(workers, n), local);
    const target = targetForRoute(workers.classes[cls], next);
    if (target !== undefined) workers.classes[cls] = target;
    done.push(`${cls}=${next.join(">")}`);
  }
  if (done.length) writeWorkersSection(raw, workers, path);
  return done.join(" ");
}

/** "local gyro-m" or "glm/glm-5.3-flash": the model an entry resolves to for its class. */
export function entryLabel(workers: WorkersConfig, cls: string, entry: string): string {
  const { provider, model } = parseEntry(entry);
  const p = providerOf(workers, provider);
  if (p && isLocalProvider(p.baseUrl)) return `local ${provider}`;
  if (!p) return entry;
  const shown = model ? (p.models[model] ?? model) : resolveModelCapability(p, classModelCapability(cls === "orchestrator" ? undefined : cls === "quick" ? "simple" : "implement"));
  return `${provider}/${shown}`;
}

export interface ViewDeps {
  /** Is this local provider's server answering? Default: one models request. */
  running?: (name: string, p: WorkerProvider) => Promise<boolean>;
  budgets?: BudgetMap;
  logDir: string;
  now?: Date;
  /** The effective table of this session: its overridden rows replace the global ones (marked `overridden`). */
  session?: SessionProfile | null;
  /** All profiles: the global view lists under each row the sessions overriding it. */
  profiles?: Profiles;
}

async function chipOf(workers: WorkersConfig, cls: string, entry: string, deps: ViewDeps, state: ReturnType<typeof readRoutingState>): Promise<RouteChip> {
  const { provider } = parseEntry(entry);
  const p = providerOf(workers, provider);
  const base = { entry, label: entryLabel(workers, cls, entry), provider };
  if (!p) return { ...base, local: false, state: "unavailable", why: "not configured" };
  if (isLocalProvider(p.baseUrl)) {
    if (!p.enabled) return { ...base, local: true, state: "idle", why: "disabled" };
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
  for (const cls of ROUTE_ROLES) {
    const own = deps.session?.routes?.[cls];
    let entries = own ?? classRoute(workers.classes, cls);
    if (cls === "orchestrator" && !entries.length) entries = [ANTHROPIC_NATIVE];
    if (!entries.length) continue;
    const note = (own ? deps.session?.route_notes?.[cls] : undefined) ?? classNote(workers.classes, cls);
    const row: RouteRow = { cls, label: ROUTE_LABELS[cls], classes: CLASSES_OF_ROLE[cls], chips: await Promise.all(entries.map((e) => chipOf(workers, cls, e, deps, state))), ...(note ? { note } : {}), ...(own ? { overridden: true } : {}) };
    const sessions = Object.entries(deps.profiles ?? {}).filter(([, p]) => p.routes?.[cls]);
    if (sessions.length) {
      row.sessions = await Promise.all(
        sessions.map(async ([session, p]) => ({
          session,
          chips: await Promise.all(p.routes![cls].map((e) => chipOf(workers, cls, e, deps, state))),
          ...(p.route_notes?.[cls] ? { note: p.route_notes[cls] } : {}),
        }))
      );
    }
    rows.push(row);
  }
  return rows;
}

/** `pai worker route`: one line per role, "label  a → b → c [classes]", with the reason after a chip that is not available. */
export function routeText(rows: RouteRow[]): string {
  const grey = (t: string) => (process.stdout.isTTY ? `\x1b[90m${t}\x1b[0m` : t);
  const chips = (cs: RouteChip[]) => cs.map((c) => `${c.label}${c.state === "available" ? "" : ` (${c.why || c.state})`}`).join(" → ");
  return rows
    .flatMap((r) => [
      `  ${r.label.padEnd(12)} ${chips(r.chips)}  ${grey(`[${r.classes.join(", ")}]`)}${r.overridden ? "  [session override]" : ""}${r.note ? `  # ${r.note}` : ""}`,
      ...(r.sessions ?? []).map((s) => `    ${s.session}: ${chips(s.chips)}${s.note ? `  # ${s.note}` : ""}`),
    ])
    .join("\n");
}
