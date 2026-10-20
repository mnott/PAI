/**
 * chains.ts — the model ranks per role (cockpit Cloud section).
 *
 * Every model (cloud provider or local model) has a rank per role: t0 (first
 * choice) … t3, or off. The ranks of a role form its chain, the order PAI uses
 * when nothing is specified. One source of truth: `workers.chains` in the main
 * config. When it is empty the chain is derived from the legacy keys
 * (routing.priority / order for workers, the chat provider for the
 * orchestrator); when it is written, the legacy keys are derived from it.
 */

import { DEFAULT_BUDGET_PRIORITY, isLocalProvider, readWorkersSection, writeWorkersSection, type WorkersConfig } from "./config.js";

export const CHAIN_ROLES = ["workers", "orchestrator"] as const;
export type ChainRole = (typeof CHAIN_ROLES)[number];
export const MAX_RANKS = 4;
export type Rank = number | "off";
export type Chains = Record<ChainRole, string[]>;

/** Parse "off" or "t0".."t3" (also 0..3). */
export function parseRank(v: unknown): Rank | null {
  if (v === "off") return "off";
  const m = typeof v === "number" ? [String(v), String(v)] : /^t?([0-3])$/.exec(String(v));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n < MAX_RANKS ? n : null;
}

/** The provider the orchestrator side runs on per the session profile ("" = built-in anthropic). */
export function chatProviderOf(raw: Record<string, unknown>, workers: WorkersConfig): string {
  const p = (raw as { session?: { profile?: { chat?: { provider?: unknown } } } }).session?.profile?.chat?.provider;
  if (typeof p === "string" && p) return p;
  return workers.active && workers.active !== "auto" ? workers.active : "anthropic";
}

/** The effective chains: workers.chains when set, else derived from the legacy keys. */
export function deriveChains(workers: WorkersConfig, chatProvider: string): Chains {
  const r = workers.routing;
  const legacyWorkers = r.priority.length ? r.priority : r.order.length ? r.order : [...DEFAULT_BUDGET_PRIORITY];
  return {
    workers: (workers.chains.workers.length ? workers.chains.workers : legacyWorkers).slice(0, MAX_RANKS),
    orchestrator: (workers.chains.orchestrator.length ? workers.chains.orchestrator : [chatProvider || "anthropic"]).slice(0, MAX_RANKS),
  };
}

/** Place `model` at `rank` in `chain` (others shift, no duplicates, no gaps); "off" removes it. */
export function applyRank(chain: string[], model: string, rank: Rank): string[] {
  const rest = chain.filter((m) => m !== model);
  if (rank === "off") return rest;
  rest.splice(Math.min(rank, rest.length), 0, model);
  return rest.slice(0, MAX_RANKS);
}

/** Rank of a model in a chain, or "off". */
export function rankOf(chain: string[], model: string): Rank {
  const i = chain.indexOf(model);
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
 * Set one model's rank in one role and persist through the existing config
 * writers (`path` overrides the main config, tests). Derives the legacy keys:
 * routing.priority = the cloud members of the workers chain, and the session
 * profile's chat provider = the orchestrator chain's t0.
 */
export function setModelRank(role: ChainRole, model: string, rank: Rank, path?: string): RankChange {
  const { raw, workers } = readWorkersSection(path);
  const known = rankableModels(workers).map((m) => m.name);
  if (!known.includes(model)) throw new Error(`no model named "${model}"`);
  const chains = deriveChains(workers, chatProviderOf(raw, workers));
  chains[role] = applyRank(chains[role], model, rank);
  workers.chains = { ...chains };
  const local = new Set(rankableModels(workers).filter((m) => m.local).map((m) => m.name));
  workers.routing.priority = chains.workers.filter((m) => !local.has(m));
  const session = (raw.session ?? {}) as Record<string, unknown>;
  const profile = (session.profile ?? {}) as Record<string, unknown>;
  const chat = (profile.chat ?? {}) as Record<string, unknown>;
  if (chains.orchestrator.length) {
    chat.provider = chains.orchestrator[0];
    profile.chat = chat;
    session.profile = profile;
    raw.session = session;
  }
  writeWorkersSection(raw, workers, path);
  return { chains, text: `${role} ${model}=${rank === "off" ? "off" : "t" + rank} chain=${chains[role].join(">") || "-"}` };
}

/** "Workers: a → b · Orchestrator: c → d" */
export function chainSummary(chains: Chains): string {
  const j = (c: string[]) => (c.length ? c.join(" → ") : "—");
  return `Workers: ${j(chains.workers)} · Orchestrator: ${j(chains.orchestrator)}`;
}
