/**
 * route-table.ts — the routing table (cockpit "routing" section, `pai worker route`).
 *
 * One row per class, each an ordered list of models (route-lists.ts): element 0
 * serves, the rest is the fallback order. Local models are entries like any
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
  type WorkerProvider,
  type WorkersConfig,
} from "./config.js";
import { budgetFull, type BudgetMap } from "./budget.js";
import { readLocalPreference } from "./local-provider.js";
import { cooldownRemaining, quotaExceeded, readRoutingState } from "./routing.js";
import { pingLocal, type PolicyMode } from "./policy.js";
import {
  MAX_ROUTE_MODELS,
  POLICY_CLASSES,
  ROUTE_CLASSES,
  ROUTE_LABELS,
  classRoute,
  entryProvider,
  listForPolicy,
  parseEntry,
  targetForRoute,
  type RouteClass,
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

export interface RouteRow {
  cls: RouteClass;
  label: string;
  chips: RouteChip[];
}

export interface RouteChoice {
  entry: string;
  label: string;
  local: boolean;
}

export const isRouteClass = (c: string): c is RouteClass => (ROUTE_CLASSES as readonly string[]).includes(c);

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
export function validateRoute(workers: WorkersConfig, cls: string, models: unknown): string[] {
  if (!isRouteClass(cls)) throw new Error(`no class "${cls}" in the routing table (${ROUTE_CLASSES.join(", ")})`);
  if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) throw new Error("models must be a list of provider/model entries");
  const entries = [...new Set((models as string[]).map((m) => m.trim()).filter(Boolean))];
  if (!entries.length) throw new Error(`class "${cls}" needs at least one model`);
  if (entries.length > MAX_ROUTE_MODELS) throw new Error(`at most ${MAX_ROUTE_MODELS} models per class`);
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
  cls: RouteClass;
  entries: string[];
  /** Ledger text of the change. */
  text: string;
}

/** Set one row and persist it through the config writers (`path` overrides the main config, tests). */
export function setRoute(cls: string, models: unknown, path?: string): RouteChange {
  const { raw, workers } = readWorkersSection(path);
  const entries = validateRoute(workers, cls, models);
  const target = targetForRoute(workers.classes[cls], entries);
  if (target !== undefined) workers.classes[cls] = target;
  if (cls === "orchestrate") {
    // the chat side runs on the first model's provider (session profile), as the active provider always did
    const session = (raw.session ?? {}) as Record<string, unknown>;
    const profile = (session.profile ?? {}) as Record<string, unknown>;
    profile.chat = { ...((profile.chat ?? {}) as Record<string, unknown>), provider: entryProvider(entries[0]) };
    session.profile = profile;
    raw.session = session;
  }
  writeWorkersSection(raw, workers, path);
  return { cls: cls as RouteClass, entries, text: `${cls}=${entries.join(">")}` };
}

/** The enabled local provider `local:` names, else the first enabled one. */
export function configuredLocal(workers: WorkersConfig): string | null {
  const locals = Object.entries(workers.providers).filter(([, p]) => p.enabled && p.engine !== "image" && isLocalProvider(p.baseUrl)).map(([n]) => n);
  const pref = readLocalPreference();
  return pref && locals.includes(pref) ? pref : (locals[0] ?? null);
}

/** A policy mode rewrites the lists of implement / simple / spotcheck (prefer-local: the `local:` provider to the front). */
export function applyPolicyToRoutes(mode: PolicyMode, path?: string): string {
  const { raw, workers } = readWorkersSection(path);
  const local = configuredLocal(workers);
  const done: string[] = [];
  for (const cls of POLICY_CLASSES) {
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
  const shown = model ? (p.models[model] ?? model) : resolveModelCapability(p, classModelCapability(cls === "orchestrate" ? undefined : cls));
  return `${provider}/${shown}`;
}

export interface ViewDeps {
  /** Is this local provider's server answering? Default: one models request. */
  running?: (name: string, p: WorkerProvider) => Promise<boolean>;
  budgets?: BudgetMap;
  logDir: string;
  now?: Date;
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
  for (const cls of ROUTE_CLASSES) {
    let entries = classRoute(workers.classes, cls);
    if (cls === "orchestrate" && !entries.length) entries = [ANTHROPIC_NATIVE];
    if (!entries.length) continue;
    rows.push({ cls, label: ROUTE_LABELS[cls], chips: await Promise.all(entries.map((e) => chipOf(workers, cls, e, deps, state))) });
  }
  return rows;
}

/** `pai worker route`: one line per class, "label  a → b → c", with the reason after a chip that is not available. */
export function routeText(rows: RouteRow[]): string {
  return rows
    .map((r) => `  ${r.cls.padEnd(12)} ${r.chips.map((c) => `${c.label}${c.state === "available" ? "" : ` (${c.why || c.state})`}`).join(" → ")}`)
    .join("\n");
}
