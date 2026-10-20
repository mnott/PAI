/**
 * chains.ts — the model ranks per role (cockpit Cloud section).
 *
 * Every role has two groups, always in this order: LOCAL, then CLOUD. A model
 * has a rank per role within its group: t0 (first choice) … t3, or off. Routing:
 * the highest-ranked local model that is running serves (a lower-ranked one that
 * is not loaded is skipped, not started); with none running, or on fall-through,
 * the cloud group in its order. A role can switch the local group off (cloud
 * only) — the only way to put cloud before local. One source of truth:
 * `workers.chains` in the main config. When it is empty the cloud group is
 * derived from the legacy keys (routing.priority / order for workers, the chat
 * provider for the orchestrator); when it is written, the legacy keys are
 * derived from it.
 */

import type { PolicyMode } from "./policy.js";
import { explicitWorkersChain, findLocal, readPolicy, routeRun, runningRankedLocal } from "./policy.js";
import { workersLogDir } from "./paths.js";
import { readLocalPreference } from "./local-provider.js";
import {
  DEFAULT_BUDGET_PRIORITY,
  emptyRoleChain,
  flatChain,
  isLocalProvider,
  readWorkersSection,
  roleChainSet,
  splitFlatChain,
  writeWorkersSection,
  type RoleChain,
  type WorkersConfig,
} from "./config.js";

export const CHAIN_ROLES = ["workers", "orchestrator"] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];
export const MAX_RANKS = 4;
export type Rank = number | "off";
export type Chains = Record<ChainRole, RoleChain>;
/** A role's chain as displayed: the groups plus the local model that serves right now (null = none running). */
export type RoleView = RoleChain & { running: string | null };
export type ChainViews = Record<ChainRole, RoleView>;

/** Parse "off" or "t0".."t3" (also 0..3). */
export function parseRank(v: unknown): Rank | null {
  if (v === "off") return "off";
  const m = typeof v === "number" ? [String(v), String(v)] : /^t?([0-3])$/.exec(String(v));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n < MAX_RANKS ? n : null;
}

const isLocalIn = (workers: WorkersConfig) => (m: string) => isLocalProvider(workers.providers[m]?.baseUrl ?? "");

/** The provider the orchestrator side runs on per the session profile ("" = built-in anthropic). */
export function chatProviderOf(raw: Record<string, unknown>, workers: WorkersConfig): string {
  const p = (raw as { session?: { profile?: { chat?: { provider?: unknown } } } }).session?.profile?.chat?.provider;
  if (roleChainSet(workers.chains.orchestrator)) return flatChain(workers.chains.orchestrator)[0] ?? "anthropic";
  if (typeof p === "string" && p) return p;
  return workers.active && workers.active !== "auto" ? workers.active : "anthropic";
}

/** The effective chains: workers.chains when set, else derived from the legacy keys. */
export function deriveChains(workers: WorkersConfig, chatProvider: string): Chains {
  const r = workers.routing;
  const legacyWorkers = r.priority.length ? r.priority : r.order.length ? r.order : [...DEFAULT_BUDGET_PRIORITY];
  const cap = (rc: RoleChain): RoleChain => ({ ...rc, local: rc.local.slice(0, MAX_RANKS), cloud: rc.cloud.slice(0, MAX_RANKS) });
  const isLocal = isLocalIn(workers);
  return {
    workers: cap(roleChainSet(workers.chains.workers) ? workers.chains.workers : splitFlatChain(legacyWorkers, isLocal)),
    orchestrator: cap(roleChainSet(workers.chains.orchestrator) ? workers.chains.orchestrator : splitFlatChain([chatProvider || "anthropic"], isLocal)),
  };
}

/**
 * The chains routing really follows, with the local model that serves now.
 * An explicit workers chain is routed by routeRun's chain walk and shown with
 * the same runningRankedLocal. Without one, a routing policy decides: the local
 * provider is the local group (off under cloud-only / prefer-cloud, alone under
 * local-only). `active` is not a chain member: it only pins plain runs (no
 * class, no policy, no session) and feeds the orchestrator chain through
 * chatProviderOf when no session profile names a chat provider.
 */
export async function effectiveChains(
  raw: Record<string, unknown>,
  workers: WorkersConfig,
  deps: { ping?: (url: string) => Promise<boolean>; battery?: () => boolean; logDir?: string } = {}
): Promise<ChainViews> {
  const base = deriveChains(workers, chatProviderOf(raw, workers));
  const logDir = deps.logDir ?? workersLogDir(workers);
  const view = async (rc: RoleChain): Promise<RoleView> => ({
    ...rc,
    running: (await runningRankedLocal(workers, logDir, rc, deps.ping)).name,
  });
  const orchestrator = await view(base.orchestrator);
  const policy = readPolicy(logDir);
  if (explicitWorkersChain(workers).length || !policy) return { workers: await view(base.workers), orchestrator };
  const found = policy.mode === "cloud-only" ? { name: null } : await findLocal(workers, logDir, deps.ping);
  const cloud = base.workers.cloud;
  const rc: RoleChain = {
    local: found.name ? [found.name] : [],
    cloud: policy.mode === "local-only" ? [] : cloud,
    localFirst: policy.mode !== "cloud-only" && policy.mode !== "prefer-cloud",
  };
  return { workers: { ...rc, running: found.name }, orchestrator };
}

/** The local provider seeding a local group: workers.yaml `local:` when it names an enabled local provider, else the first enabled one. */
export function configuredLocal(workers: WorkersConfig): string | null {
  const locals = rankableModels(workers).filter((m) => m.local && workers.providers[m.name]?.enabled).map((m) => m.name);
  const pref = readLocalPreference();
  return pref && locals.includes(pref) ? pref : (locals[0] ?? null);
}

/**
 * The Workers chain a policy mode stands for: local group on (prefer-local,
 * auto), off (cloud-only, prefer-cloud), or alone (local-only, no cloud). The
 * local group keeps its ranks and is seeded with `local` only when empty; the
 * cloud order is the current chain's (`cloudDefault` when it is empty).
 */
export function chainForPolicy(mode: PolicyMode, current: RoleChain, local: string | null, cloudDefault: string[] = []): RoleChain {
  const seeded = current.local.length ? current.local : local ? [local] : [];
  const cloud = current.cloud.length ? current.cloud : cloudDefault;
  if (mode === "local-only" && seeded.length) return { local: seeded, cloud: [], localFirst: true };
  if (mode === "cloud-only" || mode === "prefer-cloud" || !seeded.length) return { local: current.local, cloud, localFirst: false };
  return { local: seeded, cloud, localFirst: true };
}

export type ChainGroup = "local" | "cloud";

/** Set one group of a role (a non-empty local list switches the group on) and persist it (legacy keys derived as in setModelRank). */
export function setChain(role: ChainRole, group: ChainGroup, models: string[], path?: string): RankChange {
  const { raw, workers } = readWorkersSection(path);
  const known = rankableModels(workers);
  for (const m of models) {
    const k = known.find((x) => x.name === m);
    if (!k) throw new Error(`no model named "${m}"`);
    if (k.local !== (group === "local")) throw new Error(`"${m}" is a ${k.local ? "local" : "cloud"} model, not for the ${group} group`);
  }
  const chains = deriveChains(workers, chatProviderOf(raw, workers));
  chains[role][group] = [...new Set(models)].slice(0, MAX_RANKS);
  if (group === "local" && models.length) chains[role].localFirst = true;
  return persistChains(raw, workers, chains, `${role} ${group}=${chains[role][group].join(">") || "-"}`, path);
}

/** Switch a role's local group on or off (off = cloud only) and persist it. */
export function setLocalFirst(role: ChainRole, on: boolean, path?: string): RankChange {
  const { raw, workers } = readWorkersSection(path);
  const chains = deriveChains(workers, chatProviderOf(raw, workers));
  chains[role].localFirst = on;
  return persistChains(raw, workers, chains, `${role} local ${on ? "on" : "off"}`, path);
}

/** Persist a whole workers chain (policy modes). */
export function setRoleChain(role: ChainRole, rc: RoleChain, text: string, path?: string): RankChange {
  const { raw, workers } = readWorkersSection(path);
  const chains = deriveChains(workers, chatProviderOf(raw, workers));
  chains[role] = { local: rc.local.slice(0, MAX_RANKS), cloud: rc.cloud.slice(0, MAX_RANKS), localFirst: rc.localFirst };
  return persistChains(raw, workers, chains, text, path);
}

/** Place `model` at `rank` in `chain` (others shift, no duplicates, no gaps); "off" removes it. */
export function applyRank(chain: string[], model: string, rank: Rank): string[] {
  const rest = chain.filter((m) => m !== model);
  if (rank === "off") return rest;
  rest.splice(Math.min(rank, rest.length), 0, model);
  return rest.slice(0, MAX_RANKS);
}

/** Rank of a model within a group, or "off". */
export function rankOf(group: string[], model: string): Rank {
  const i = group.indexOf(model);
  return i < 0 ? "off" : i;
}

/** Every rankable model: the built-in anthropic, each enabled provider (cloud and local). */
export function rankableModels(workers: WorkersConfig): { name: string; local: boolean }[] {
  const out = [{ name: "anthropic", local: false }];
  for (const [name, p] of Object.entries(workers.providers)) {
    if (name === "anthropic" || p.engine === "image") continue;
    out.push({ name, local: isLocalProvider(p.baseUrl) });
  }
  return out;
}

export interface RankChange {
  chains: Chains;
  /** Ledger text of the change. */
  text: string;
}

/**
 * Set one model's rank within its group (local or cloud) in one role and
 * persist through the existing config writers (`path` overrides the main
 * config, tests). Derives the legacy keys: routing.priority = the workers
 * cloud group, and the session profile's chat provider = the orchestrator
 * chain's first model.
 */
export function setModelRank(role: ChainRole, model: string, rank: Rank, path?: string): RankChange {
  const { raw, workers } = readWorkersSection(path);
  const known = rankableModels(workers).find((m) => m.name === model);
  if (!known) throw new Error(`no model named "${model}"`);
  const group: ChainGroup = known.local ? "local" : "cloud";
  const chains = deriveChains(workers, chatProviderOf(raw, workers));
  chains[role][group] = applyRank(chains[role][group], model, rank);
  return persistChains(raw, workers, chains, `${role} ${model}=${rank === "off" ? "off" : "t" + rank} ${group}=${chains[role][group].join(">") || "-"}`, path);
}

function persistChains(raw: Record<string, unknown>, workers: WorkersConfig, chains: Chains, text: string, path?: string): RankChange {
  workers.chains = { workers: { ...chains.workers }, orchestrator: { ...chains.orchestrator } };
  workers.routing.priority = [...chains.workers.cloud];
  const session = (raw.session ?? {}) as Record<string, unknown>;
  const profile = (session.profile ?? {}) as Record<string, unknown>;
  const chat = (profile.chat ?? {}) as Record<string, unknown>;
  const orchestrator = flatChain(chains.orchestrator);
  if (orchestrator.length) {
    chat.provider = orchestrator[0];
    profile.chat = chat;
    session.profile = profile;
    raw.session = session;
  }
  writeWorkersSection(raw, workers, path);
  return { chains, text };
}

/** "local gyro-m (running) → iq3s, coder (not loaded) · then cloud anthropic → glm"; "cloud a → b · local off" while the local group is off. */
export function roleSummary(v: RoleView): string {
  const cloud = v.cloud.length ? `cloud ${v.cloud.join(" → ")}` : "";
  if (!v.local.length) return cloud || "—";
  const run = v.running && v.local.includes(v.running) ? v.running : null;
  const idle = v.local.filter((m) => m !== run);
  const local = [run ? `${run} (running)` : "", idle.length ? `${idle.join(", ")} (not loaded)` : ""].filter(Boolean).join(" → ");
  if (!v.localFirst) return `${cloud || "—"} · local off (${v.local.join(", ")})`;
  return cloud ? `local ${local} · then ${cloud}` : `local ${local}`;
}

/** "Workers: local gyro-m (running) → … · then cloud … · Orchestrator: cloud anthropic" */
export function chainSummary(views: ChainViews): string {
  return `Workers: ${roleSummary(views.workers)} · Orchestrator: ${roleSummary(views.orchestrator)}`;
}
