/**
 * config.ts — the `workers` section of the PAI config file (CONFIG_FILE,
 * see src/daemon/config.ts's paiConfigFilePath — ~/.pai/config.yaml
 * today, config.json until `pai config yaml` runs).
 *
 * Everything that knows about worker providers reads this module: the CLI
 * (`pai worker …`), the MCP tools (worker_*), and the Agent-routing hook.
 * Keep it free of CLI/MCP imports so all three layers stay thin over it.
 *
 * Keys are never stored here — only paths to 0600 files. A provider without a
 * keyFile is a local server and gets the placeholder token "local".
 *
 * `protocol: "openai"` providers run through the PAI proxy (src/workers/proxy):
 * `upstreamUrl` is their Chat Completions base, and `run` points
 * ANTHROPIC_BASE_URL at the local proxy with the provider name in the path.
 * `engine: "codex"` providers run through the Codex CLI instead of Claude
 * Code.
 */

import { DEFAULT_ESCALATE, parseEscalate, type EscalateConfig } from "./escalation.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, expandHome, paiConfigFilePath, readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { paiHomePath } from "../config/pai-home.js";
import { effectiveMainConfig, shippedMainDefaults, shippedWorkersDefaults } from "../config/shipped-defaults.js";
import { contextWindowFromModelId, DEFAULT_CONTEXT_WINDOW } from "../utils/model-window.js";
import { foldLegacyRoles, migrateClassPins, migrateClassRoutes, migrateLegacyChains, migrateToTiers, parseTiersValue, type TierDef } from "./route-lists.js";
import {
  effectiveWorkersYamlData,
  readWorkersYaml,
  workersYamlPath,
  writeWorkersYaml,
  type WorkersYamlData,
} from "./workers-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wire protocol a provider speaks: "anthropic" natively, "openai" through the
 * PAI proxy (which translates the Anthropic Messages API to Chat Completions).
 */
export type WorkerProtocol = "anthropic" | "openai";

/**
 * Runner executable behind a provider: Claude Code, the Codex CLI, or the
 * "image" engine (src/workers/engines/image.ts — an OpenAI-compatible
 * images API, not a claude/codex spawn).
 */
export type WorkerEngine = "claude" | "codex" | "image";

/** One quota window the statusline renders for a provider (e.g. "5h", "7d"). */
export interface UsageWindow {
  /** Window label shown in the statusline, e.g. "5h". */
  name: string;
  /** jq expression against the usage response yielding a percent 0–100. */
  percent: string;
  /** jq expression against the usage response yielding the reset time. */
  resetAt?: string;
  /** How resetAt is interpreted: epoch ms (default), epoch s, or ISO string. */
  resetUnit?: "ms" | "s" | "iso";
}

/**
 * How the statusline fetches and renders a provider's plan quota. The block
 * names a JSON GET endpoint plus per-window jq expressions, so a new provider
 * is config, not code in statusline-command.sh.
 */
export interface ProviderUsage {
  /** GET endpoint returning the usage JSON. */
  url: string;
  /**
   * Auth header template, default "Authorization: Bearer"; the key from
   * keyFile is appended after a space. A value without a space (e.g.
   * "x-api-key") is sent as "<authHeader>: <key>".
   */
  authHeader?: string;
  /** Display label for the usage segments, default = provider name. */
  label?: string;
  windows: UsageWindow[];
  /** Statusline cache TTL in seconds, default 60. */
  ttlSeconds?: number;
}

export interface WorkerProvider {
  enabled: boolean;
  /** Wire protocol the baseUrl speaks. */
  protocol: WorkerProtocol;
  /** Anthropic-compatible Messages API base. */
  baseUrl: string;
  /** 0600 file holding the auth token; null for local servers ("local"). */
  keyFile: string | null;
  /**
   * The auth token itself, inline in workers.yaml. Wins over keyFile when
   * both are set (`pai worker config check` notices this). Keeping the key
   * out of a separate file is the operator's explicit call — the file this
   * lives in must be 0600 (writeWorkersYamlText enforces that) and is never
   * committed. See resolveProviderKey for the one place this is read.
   */
  key?: string;
  /** Model id per capability; see MODEL_CAPABILITIES. Only default is required. */
  models: { default: string } & Partial<Record<ModelCapability, string>>;
  /**
   * Model id → tier alias, overriding the built-in mapping (models.fast →
   * haiku tier, models.default → sonnet tier). Lets a provider pin an extra
   * model id to a tier, e.g. a heavyweight default to the opus tier.
   */
  modelTiers?: Record<string, ModelTier>;
  /**
   * Model a worker gets on this provider when the request names none:
   * "default" (the default, unset) or "fast". Set "fast" on an expensive
   * provider. An explicit model (`--model`, a `provider/role` class target,
   * where/model) still wins. workers.yaml `worker_model`.
   */
  workerModel?: "default" | "fast";
  /** Extra environment variables for runs through this provider (string values). */
  env: Record<string, string>;
  note?: string;
  /**
   * `false` keeps a loopback provider on its direct URL; unset routes it
   * through the local router (shared prefix-cache fixes, usage accounting).
   */
  router?: boolean;
  /** Contract addendum file for this provider; default <PAI_HOME>/contracts/<name>.md. */
  contract?: string;
  /**
   * OpenAI Chat Completions base (e.g. "https://api.openai.com/v1"). Required
   * for protocol "openai"; read by the PAI proxy, never by the runner.
   */
  upstreamUrl?: string;
  /** Runner for this provider; "codex" goes through the Codex CLI. */
  engine?: WorkerEngine;
  /** Optional shell command printing 0–100 (percent of quota used). */
  quotaProbe?: string;
  /** Auto-routing skips the provider at or above this percentage. Unset falls
   *  back to workers.quotaSkipAt in the shipped defaults file. */
  quotaSkipAt?: number;
  /**
   * Context window of the provider's model, for the context meter. No
   * default: the meter only shows a window the init event announced (or
   * this explicit value, for engines without one, e.g. codex).
   */
  contextWindow?: number;
  /**
   * Extended thinking for runs through this provider. Unset = off for a
   * non-native provider: the worker settings then carry
   * CLAUDE_CODE_DISABLE_THINKING and an unset effort level, so the request has
   * neither `thinking` nor `output_config` (a local server's own reasoning
   * default then applies). `true` leaves Claude Code's defaults alone.
   */
  thinking?: boolean;
  /** Most runs this provider serves at once; more queue (capacity.ts). Default 3 on loopback, unlimited otherwise. */
  maxConcurrent?: number;
  /**
   * Conversation-cache slots of the engine behind this provider (Strata
   * --conversation-cache-slots). Admitted workers stay below it (one slot spare):
   * more makes conversations evict each other every turn. Default: maxConcurrent.
   */
  conversationSlots?: number;
  /** Cost tier 1 (cheapest) … 5 (most expensive); classes cap it via maxCostTier.
   *  Unset falls back to workers.costTier in the shipped defaults file. */
  costTier?: number;
  /** Capability tags; classes filter auto-routing via requireTags. */
  tags?: ProviderTag[];
  /** Statusline plan-quota block; see ProviderUsage. Absent = "usage n/a". */
  usage?: ProviderUsage;
  /**
   * True only for the synthetic built-in "anthropic" provider (see
   * ANTHROPIC_NATIVE): plain Claude Code, on its own OAuth/Max-plan login —
   * no baseUrl, no key file, no config entry. Never set by parseProvider.
   */
  native?: boolean;
}

/**
 * Reserved provider name for plain Anthropic: Claude Code's own OAuth/Max-plan
 * login, no base URL override and no API key. It never needs (or accepts) a
 * `providers.anthropic` config entry — resolveTarget/mustExist synthesize it
 * on demand via `nativeAnthropicProvider()`.
 */
export const ANTHROPIC_NATIVE = "anthropic";

/**
 * Models the built-in provider runs on — read from the shipped defaults file
 * (`providers.anthropic.models` in defaults/workers.yaml). This is the only
 * place a model id is named for it: run.ts resolves the class capability
 * against this table like it does for any configured provider and passes
 * `--model` explicitly.
 *
 * Workers exist to parallelise and to save cost, so they must never inherit
 * the orchestrator's model. A bare headless `claude` takes the interactive
 * session default, and one probe came up on the most expensive tier because
 * the chat session had been switched to it. Sonnet is the working tier;
 * haiku serves the fast classes (spotcheck, simple). These are the Claude
 * Code CLI's own tier aliases, not pinned ids: the CLI resolves each to its
 * newest model on every run, so the tier tracks a release without a config
 * change here (adoptInitModel in run.ts swaps the alias for the init event's
 * resolved id once the run announces one).
 */
export function nativeAnthropicModels(): WorkerProvider["models"] {
  const d = shippedWorkersDefaults();
  const providers = d.providers as Record<string, unknown> | undefined;
  const anthropic = providers?.anthropic as Record<string, unknown> | undefined;
  const models = anthropic?.models as Record<string, unknown> | undefined;
  const def = typeof models?.default === "string" ? models.default : "sonnet";
  const out: WorkerProvider["models"] = { default: def };
  if (typeof models?.fast === "string") out.fast = models.fast;
  if (typeof models?.image === "string") out.image = models.image;
  return out;
}

/**
 * The synthetic provider object for ANTHROPIC_NATIVE. `baseUrl` is empty and
 * there is no key file, so buildRunEnv strips every provider env override;
 * the models come from the shipped defaults (nativeAnthropicModels) so a run
 * always names its model on the command line.
 */
export function nativeAnthropicProvider(
  models: WorkerProvider["models"] = nativeAnthropicModels()
): WorkerProvider {
  return {
    enabled: true,
    protocol: "anthropic",
    baseUrl: "",
    keyFile: null,
    models: { ...models },
    env: {},
    native: true,
  };
}

/**
 * Provider by name, synthesizing ANTHROPIC_NATIVE when it is asked for. Reads
 * `config.nativeModels` (workers.yaml's documented `providers.anthropic.models`
 * override, if any) so a config that pins a different default/fast id for the
 * built-in provider is honored everywhere a provider is resolved.
 */
export function getProviderOrNative(
  config: { providers: Record<string, WorkerProvider>; nativeModels?: WorkerProvider["models"] },
  name: string
): WorkerProvider | undefined {
  if (name === ANTHROPIC_NATIVE) return nativeAnthropicProvider(config.nativeModels);
  return config.providers[name];
}

export interface WorkersPaneConfig {
  enabled: boolean;
  /** Font size (points) of the follow-pane profile's font. */
  fontSize: number;
  /** Seconds a pane lingers after its worker goes quiet. */
  autoExitSecs: number;
}

export interface WorkersRoutingConfig {
  /** Provider names in preference order; first usable one wins. */
  order: string[];
  /** Minutes a provider sits in cooldown after a quota/rate failure. */
  cooldownMinutes: number;
  /** Reroute a failed-before-first-tool run to the next provider. */
  retryOnQuota: boolean;
  /**
   * Auto-routing policy: "budget" (default) walks the priority list but skips
   * every provider whose live budget probe reads at or above its wall
   * (routing.budgetWalls) — a run waits a full provider out on the next one
   * with room, and the full one re-enters when its window resets. "order"
   * walks routing.order verbatim, quota probes aside.
   */
  policy: "budget" | "order";
  /**
   * Provider names in operator preference order for policy "budget". Empty
   * falls back to routing.order, else DEFAULT_BUDGET_PRIORITY.
   */
  priority: string[];
  /**
   * Per-provider usage percent at or above which budget routing treats the
   * provider as full. From the provider's `usage` block (anthropic: the OAuth
   * usage endpoint). A number applies to every window; a map by window name
   * ({"5h": 95, "7d": 70}) walls each window on its own, a window with no
   * entry using the provider's number (map form has none), then the shipped
   * routing.budgetPercent, then routing.budgetWall. A provider is full when
   * ANY window it reports is at or above that window's wall.
   */
  budgetWalls: Record<string, number | Record<string, number>>;
  /**
   * Shipped budget-routing preference order (defaults/workers.yaml
   * `routing.budgetPriority`): walked when neither priority nor order is set.
   */
  budgetPriority: string[];
  /** Shipped per-provider budget walls (defaults/workers.yaml `routing.budgetPercent`). */
  budgetPercent: Record<string, number>;
  /** Budget wall for a provider neither budgetWalls nor budgetPercent names. */
  budgetWall: number;
}

/** Start gate for same-provider runs (workers.stagger); values in defaults/workers.yaml. */
export interface StaggerConfig {
  enabled: boolean;
  /** Limit without history, per provider kind (seconds). */
  localDefaultSec: number;
  remoteDefaultSec: number;
  /** Clamp of the learned limit (seconds). */
  minSec: number;
  maxSec: number;
}

/** Per-provider concurrency cap (workers.capacity); see capacity.ts. The policy
 *  values live in the shipped defaults file (defaults/workers.yaml). */
export interface CapacityConfig {
  enabled: boolean;
  /** Loopback default cap (`workers.capacity.localDefaultCap`): one local engine serves one request at a time. */
  localDefaultCap: number;
  /** Cap for a provider with no cap at all (cloud, unset), used by queue/plan runners (`workers.capacity.uncappedQueueCap`). */
  uncappedQueueCap: number;
  /** Max total wait before the queue alarm fires (`workers.capacity.maxTotalWaitMs`). */
  maxTotalWaitMs: number;
  /** Longest silence of the log while queued (`workers.capacity.heartbeatMs`). */
  heartbeatMs: number;
  /** Aging bound: a ticket waiting longer jumps ahead of newer tickets of any session (`workers.capacity.agingMs`). */
  agingMs: number;
}

/** Local-model idle watcher (workers.localIdle); see local-idle.ts. */
export interface LocalIdleConfig {
  enabled: boolean;
  /** GPU busy percent under which local models count as idle. */
  gpuBelowPct: number;
  /** Minutes idle before the watcher fires. */
  minutes: number;
  /** Minutes between repeat notices. */
  backoffMinutes: number;
}

/** Loop guard (workers.loopGuard): how much of its last output a denied repeated read gets back. */
export interface LoopGuardConfig {
  /** Lines of the last output echoed in the denial. */
  echoLines: number;
  /** Characters of the last output echoed in the denial. */
  echoChars: number;
  /** Lines from the end of a repeated runner command's last output echoed in the denial. */
  echoRunnerLines: number;
}

/** workers.supervision: pointer = type "N worker alerts pending" lines into session panes; default off. */
export interface WorkersSupervisionConfig {
  pointer: boolean;
  /**
   * Which alerts reach the orchestrating session. "harness" (default): harness-class
   * tool errors, loop detections and stalls; the rest is recorded and summarised once
   * when the unit ends. "all": every first-occurrence tool error, thrashing and sleeping too.
   */
  push: "harness" | "all";
  /** Minutes without a tool call before a running unit counts as stalled (default 10). */
  stallMinutes: number;
}

/** Sub-worker caps: how deep the worker tree may grow, how wide per parent. */
export interface WorkersTreeConfig {
  /** Maximum nesting depth of sub-workers (top-level = 0). */
  maxDepth: number;
  /** Maximum concurrently running children per parent. */
  maxChildren: number;
}

/**
 * The worker session pool (workers.pool): long-lived headless claude slots
 * that successive small runs talk to instead of each spawning a fresh
 * claude, so the provider prompt cache carries over between tasks
 * (src/workers/pool.ts). Default OFF — the operator turns it on with
 * `pai worker pool on`.
 */
export interface WorkersPoolConfig {
  /** Pool routing on: eligible runs go through the pool host. */
  enabled: boolean;
  /** Maximum slot processes the host keeps, across all (provider, model) keys. */
  maxSlots: number;
  /** Idle seconds before a slot is killed (0 = never). */
  idleSecs: number;
  /** Loopback port the pool host listens on. */
  port: number;
  /** Native anthropic (Claude Code's own login) runs may use pooled slots; worktree runs never do. */
  native: boolean;
  /** Spares per (repo, provider) key: pre-started task-less workers, one task each (0 = off). */
  spares?: number;
  /** Idle seconds before an unclaimed spare is retired (0 = never). */
  idleKillSec?: number;
  /** The old multi-task continuation path (one warm conversation serving many tasks); default off. */
  continuation?: boolean;
}

/** The tier aliases the CLI and daemon tables understand — class proxies, not
 *  Anthropic model names: any provider's model maps onto one of these. */
export type ModelTier = "haiku" | "sonnet" | "opus";

const MODEL_TIERS: readonly ModelTier[] = ["haiku", "sonnet", "opus"];

export const DEFAULT_COST_TIER = 3;

/** Tags a provider may carry; classes filter auto-routing on them. */
export const PROVIDER_TAGS = [
  "code",
  "vision",
  "image-gen",
  "long-context",
  "fast",
  "reasoning",
] as const;

export type ProviderTag = (typeof PROVIDER_TAGS)[number];

/** The standard task classes; `workers.classes` maps each to a target. */
export const WORKER_CLASSES = [
  "draft",
  "plan",
  "implement",
  "review",
  "research",
  "spotcheck",
  "simple",
  "complex",
  "image",
] as const;

export type WorkerClassName = (typeof WORKER_CLASSES)[number];

/**
 * The well-known model capabilities — documented, and what the starter
 * workers.yaml and `pai worker model`'s listing show by name. The set is
 * open, though: a provider's `models` block may carry any capability name
 * matching CAPABILITY_NAME_RE (see isModelCapability), e.g. "vision" or
 * "longcontext" for a provider that serves them. "default" is the required
 * catch-all; the others name what a model is *for* — "fast" the cheap tier
 * (spotcheck, haiku-tier spawns), "image" the image class/capability.
 * Everything resolves through resolveModelCapability, falling back to
 * default; cross-provider preference for a capability is `capabilities:` in
 * workers.yaml (see resolveCapability).
 */
export const MODEL_CAPABILITIES = ["default", "fast", "image"] as const;

export type ModelCapability = string;

export const CAPABILITY_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Is this string a syntactically valid capability name (open set)? */
export function isModelCapability(v: string): v is ModelCapability {
  return CAPABILITY_NAME_RE.test(v);
}

/**
 * The image class runs on a provider's image model; every other class runs on
 * the model its routing list's entry names (route-lists.ts), else the
 * provider's worker_model. There is no per-class fast-model rule: the cheap
 * classes (spotcheck, simple) get a cheap model only when their tier's list
 * says so (a `glm/fast` entry, or a tier `fast` class option naming the tier
 * entry's fast alias). A provider without a fast model falls back to its
 * default (resolveModelCapability).
 */
export function classModelCapability(className?: string): ModelCapability {
  return className === "image" ? "image" : "default";
}

/**
 * A class target: "<provider>", "<provider>/<modelAlias>", or an object. The
 * object either pins a `provider` (plus optional `mcp` allowlist) or only
 * constrains auto-routing (`maxCostTier`, `requireTags`, per-class `order`).
 */
export type ClassTarget =
  | string
  | {
      provider?: string;
      mcp?: string[];
      /** Auto-routing may only use providers at or below this cost tier. */
      maxCostTier?: number;
      /** Auto-routing may only use providers carrying all these tags. */
      requireTags?: string[];
      /** Provider order for this class; defaults to routing.order. */
      order?: string[];
      /** The class's routing list (route-lists.ts): element 0 serves, the rest is the fallback order. */
      models?: string[];
      /** Why the row is ordered this way (shown as a tooltip). */
      note?: string;
    };

/**
 * State of the machine-wide Claude Code fallback (`pai worker fallback on`):
 * every new Claude Code process runs on `provider` until `fallback off`.
 * `saved` holds what ~/.claude/settings.json carried before the switch so
 * `off` can restore it exactly.
 */
export interface WorkersFallback {
  /** Provider every new Claude Code process is pointed at. */
  provider: string;
  /**
   * settings.json before the switch. `env` records the previous value of
   * every env key fallback touched (null = the key was absent), `model` the
   * previous top-level model pin (null = none), `envExisted` whether an env
   * block existed at all.
   */
  saved: {
    env: Record<string, string | null>;
    model: string | null;
    envExisted: boolean;
  };
  /** ISO stamp of the switch (shown by `fallback status`). */
  on: string;
}

export interface WorkersConfig {
  enabled: boolean;
  /** Provider name, or "auto" for routing.order resolution. */
  active: string | null;
  providers: Record<string, WorkerProvider>;
  /** Class → target; see ClassTarget. (Reads the legacy `roles` key.) */
  classes: Record<string, ClassTarget>;
  /** Delegation tiers (route-lists.ts TierDef): names, ordered model lists, class -> tier mapping, session-start flag. Config only. */
  tiers: TierDef[];
  /** MCP set name → server names; `--mcp <set>` and class `mcp` expand these. */
  mcpSets: Record<string, string[]>;
  /**
   * Capability → provider names in preference order (workers.yaml
   * `capabilities:`), e.g. `{ image: ["pictures", "glm"] }`. Cross-provider,
   * unlike a provider's own `models` table: this is what lets `--capability
   * image` find the one provider configured to serve it. See resolveCapability.
   */
  capabilities: Record<string, string[]>;
  pane: WorkersPaneConfig;
  logDir: string;
  routing: WorkersRoutingConfig;
    /** Sub-worker caps (workers.tree). */
  tree: WorkersTreeConfig;
  /** Worker supervision options (workers.supervision). */
  supervision: WorkersSupervisionConfig;
  /** Worker session pool (workers.pool); default off. */
  pool: WorkersPoolConfig;
  /**
   * Daemon cache-keepalive cadence in seconds: how often a trivial
   * single-turn heartbeat worker re-arms the provider prompt cache
   * (src/workers/keepalive.ts). 0 = off.
   */
  cacheKeepaliveSecs: number;
  /** Default time limit of every run in minutes (workers.defaultMaxMinutes); 0 = none. */
  defaultMaxMinutes: number;
  /** Minutes a run may queue for a slot before the owner is told (workers.waitAlarmMinutes); default 120. */
  waitAlarmMinutes: number;
  /** Start gate for same-provider runs (workers.stagger); see stagger.ts. */
  stagger: StaggerConfig;
  /** Per-provider concurrency cap (workers.capacity); see capacity.ts. */
  capacity: CapacityConfig;
  /** Local-model idle watcher (workers.localIdle); see local-idle.ts. */
  localIdle: LocalIdleConfig;
  /** Escalation one tier up (workers.escalate); see escalation.ts. */
  escalate: EscalateConfig;
  /** Loop guard echo size (workers.loopGuard); see hooks/ts/lib/loop-guard.ts. */
  loopGuard: LoopGuardConfig;
  /** Runs strip browser tools unless --browser is passed (workers.noBrowserByDefault). */
  noBrowserByDefault: boolean;
  /** Hourly gc archives finished workers' worktrees older than this many hours (workers.gcOlderThanHours). */
  gcOlderThanHours: number;
  /** Size cap in GB of the worktrees dir; over it, gc archives the oldest finished ones (workers.worktreesMaxGb). */
  worktreesMaxGb: number;
  /** Daemon reaper for orphaned worker processes (workers.reaper, default on). */
  reaper: boolean;
  /**
   * Run native-Anthropic workers through `caveman claude` (workers.caveman).
   * Off pins them to api.anthropic.com even when the user settings route
   * every claude through a proxy; see claudeCommand in run-env.ts.
   */
  caveman: boolean;
  /** Machine-wide Claude Code fallback; null = off. */
  fallback: WorkersFallback | null;
  /**
   * Model ids for the built-in `anthropic` provider, when workers.yaml
   * documents an override under `providers.anthropic.models`. Defaults to the
   * shipped defaults file's table (nativeAnthropicModels).
   */
  nativeModels: WorkerProvider["models"];
  /** Cost tier used when a provider names none (workers.costTier). */
  costTier: number;
  /** Budget-routing skip percentage used when a provider names none (workers.quotaSkipAt). */
  quotaSkipAt: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The workers defaults live in the shipped defaults file
 * (src/config/defaults/workers.yaml, copied into dist by the build) and are
 * deep-merged UNDER the user's config — see src/config/shipped-defaults.ts.
 * defaultWorkersConfig() reads that file; the code keeps only the types and
 * the loader.
 */
export function defaultWorkersConfig(): WorkersConfig {
  const d = shippedWorkersDefaults();
  const w = (d.workers ?? {}) as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const num = (v: unknown, dflt: number): number => (typeof v === "number" ? v : dflt);
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  const pane = obj(w.pane);
  const routing = obj(w.routing);
  const tree = obj(w.tree);
  const supervision = obj(w.supervision);
  const pool = obj(w.pool);
  const stagger = obj(w.stagger);
  const capacity = obj(w.capacity);
  const localIdle = obj(w.localIdle);
  const escalate = parseEscalate(w.escalate, (path, msg) => {
    throw new WorkersConfigError(`defaults workers.yaml ${path}: ${msg}`);
  });
  const loopGuard = obj(w.loopGuard);
  return {
    enabled: bool(w.enabled, false),
    active: null,
    providers: {},
    classes: {},
    tiers: [],
    mcpSets: obj(d.mcp_sets) as Record<string, string[]>,
    capabilities: {},
    pane: {
      enabled: bool(pane.enabled, true),
      fontSize: num(pane.fontSize, 13),
      autoExitSecs: num(pane.autoExitSecs, 5),
    },
    logDir: typeof w.logDir === "string" ? w.logDir : "~/.claude/logs/workers",
    routing: {
      order: strArr(routing.order),
      cooldownMinutes: num(routing.cooldownMinutes, 30),
      retryOnQuota: bool(routing.retryOnQuota, true),
      policy: routing.policy === "order" ? "order" : "budget",
      priority: strArr(routing.priority),
      budgetWalls: obj(routing.budgetWalls) as WorkersRoutingConfig["budgetWalls"],
      budgetPriority: strArr(routing.budgetPriority),
      budgetPercent: obj(routing.budgetPercent) as Record<string, number>,
      budgetWall: num(routing.budgetWall, 95),
    },
    tree: { maxDepth: num(tree.maxDepth, 2), maxChildren: num(tree.maxChildren, 4) },
    supervision: {
      pointer: bool(supervision.pointer, false),
      push: supervision.push === "all" ? "all" : "harness",
      stallMinutes: num(supervision.stallMinutes, 10),
    },
    pool: {
      enabled: bool(pool.enabled, false),
      maxSlots: num(pool.maxSlots, 3),
      idleSecs: num(pool.idleSecs, 900),
      port: num(pool.port, 8798),
      native: bool(pool.native, true),
      spares: num(pool.spares, 1),
      idleKillSec: num(pool.idleKillSec, 1800),
      continuation: bool(pool.continuation, false),
    },
    cacheKeepaliveSecs: num(w.cacheKeepaliveSecs, 0),
    defaultMaxMinutes: num(w.defaultMaxMinutes, 60),
    waitAlarmMinutes: num(w.waitAlarmMinutes, 120),
    stagger: {
      enabled: bool(stagger.enabled, true),
      localDefaultSec: num(stagger.localDefaultSec, 20),
      remoteDefaultSec: num(stagger.remoteDefaultSec, 8),
      minSec: num(stagger.minSec, 3),
      maxSec: num(stagger.maxSec, 120),
    },
    capacity: {
      enabled: bool(capacity.enabled, true),
      localDefaultCap: num(capacity.localDefaultCap, 1),
      uncappedQueueCap: num(capacity.uncappedQueueCap, 3),
      maxTotalWaitMs: num(capacity.maxTotalWaitMs, 2 * 3_600_000),
      heartbeatMs: num(capacity.heartbeatMs, 60_000),
      agingMs: num(capacity.agingMs, 15 * 60_000),
    },
    localIdle: {
      enabled: bool(localIdle.enabled, true),
      gpuBelowPct: num(localIdle.gpuBelowPct, 10),
      minutes: num(localIdle.minutes, 2),
      backoffMinutes: num(localIdle.backoffMinutes, 10),
    },
    escalate,
    loopGuard: { echoLines: num(loopGuard.echoLines, 40), echoChars: num(loopGuard.echoChars, 3000), echoRunnerLines: num(loopGuard.echoRunnerLines, 40) },
    noBrowserByDefault: bool(w.noBrowserByDefault, false),
    gcOlderThanHours: num(w.gcOlderThanHours, 6),
    worktreesMaxGb: num(w.worktreesMaxGb, 20),
    reaper: bool(w.reaper, true),
    caveman: bool(w.caveman, false),
    fallback: null,
    nativeModels: nativeAnthropicModels(),
    costTier: num(w.costTier, 3),
    quotaSkipAt: num(w.quotaSkipAt, 95),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class WorkersConfigError extends Error {}

/** Does this provider's endpoint live on this machine? */
export function isLocalProvider(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function bad(path: string, why: string): never {
  throw new WorkersConfigError(`workers${path}: ${why}`);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse a `models` block (capability → model id, "default" required). Shared
 * by parseProvider and the YAML loader's builtin-anthropic override, which
 * has no other provider fields to validate.
 */
export function parseModelsBlock(pathPrefix: string, modelsRaw: unknown): WorkerProvider["models"] {
  const raw = modelsRaw === undefined ? {} : modelsRaw;
  if (typeof raw !== "object" || raw === null) bad(pathPrefix, "must be an object");
  const m = raw as Record<string, unknown>;
  const defaultModel = str(m.default);
  if (!defaultModel) bad(`${pathPrefix}.default`, "is required");
  const models: WorkerProvider["models"] = { default: defaultModel };
  for (const key of Object.keys(m)) {
    if (key === "default") continue;
    if (!isModelCapability(key)) {
      bad(
        `${pathPrefix}.${key}`,
        `"${key}" is not a valid capability name (must match ^[a-z][a-z0-9-]*$; well-known: ${MODEL_CAPABILITIES.join(", ")}, but any name in that shape is accepted)`
      );
    }
    const id = str(m[key]);
    if (!id) bad(`${pathPrefix}.${key}`, "must be a non-empty model id");
    models[key] = id;
  }
  return models;
}

/** Parse and validate one provider entry (shared by JSON and YAML loading). */
export function parseProvider(name: string, raw: unknown): WorkerProvider {
  if (name === ANTHROPIC_NATIVE) {
    bad(
      `.providers.${name}`,
      `"${ANTHROPIC_NATIVE}" is reserved for plain Anthropic (Claude Code's own OAuth/Max-plan login) and cannot be configured here — remove this entry; use --provider ${ANTHROPIC_NATIVE} or "pai worker providers use ${ANTHROPIC_NATIVE}" instead`
    );
  }
  if (typeof raw !== "object" || raw === null) bad(`.providers.${name}`, "must be an object");
  const p = raw as Record<string, unknown>;

  const protocol = p.protocol === undefined ? "anthropic" : str(p.protocol);
  if (protocol !== "anthropic" && protocol !== "openai") {
    bad(`.providers.${name}.protocol`, `"${str(p.protocol)}" is neither "anthropic" nor "openai"`);
  }
  const engine = p.engine === undefined ? "claude" : str(p.engine);
  if (engine !== "claude" && engine !== "codex" && engine !== "image") {
    bad(`.providers.${name}.engine`, `"${str(p.engine)}" is none of "claude", "codex", "image"`);
  }

  const baseUrl = str(p.baseUrl);
  // openai providers reach the model through the PAI proxy; their baseUrl is
  // the proxy URL, filled in by the runner — only anthropic needs one here.
  if (p.router !== undefined && typeof p.router !== "boolean") {
    bad(`.providers.${name}.router`, "must be true or false");
  }
  if (p.contract !== undefined && typeof p.contract !== "string") {
    bad(`.providers.${name}.contract`, "must be a string path");
  }
  if (!baseUrl && protocol !== "openai") bad(`.providers.${name}.baseUrl`, "is required");

  const keyFile =
    p.keyFile === undefined || p.keyFile === null || str(p.keyFile) === ""
      ? null
      : str(p.keyFile);
  const key = str(p.key) || undefined;

  const models = parseModelsBlock(`.providers.${name}.models`, p.models);

  let modelTiers: Record<string, ModelTier> | undefined;
  if (p.modelTiers !== undefined) {
    if (typeof p.modelTiers !== "object" || p.modelTiers === null || Array.isArray(p.modelTiers)) {
      bad(`.providers.${name}.modelTiers`, "must be an object of model id → haiku | sonnet | opus");
    }
    modelTiers = {};
    for (const [id, tier] of Object.entries(p.modelTiers as Record<string, unknown>)) {
      if (typeof tier !== "string" || !MODEL_TIERS.includes(tier as ModelTier)) {
        bad(
          `.providers.${name}.modelTiers.${id}`,
          `must be "haiku", "sonnet" or "opus" (got ${JSON.stringify(tier)})`
        );
      }
      modelTiers[id] = tier as ModelTier;
    }
  }

  const env: Record<string, string> = {};
  if (p.env !== undefined) {
    if (typeof p.env !== "object" || p.env === null || Array.isArray(p.env)) {
      bad(`.providers.${name}.env`, "must be an object of string values");
    }
    for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
      if (typeof v !== "string") bad(`.providers.${name}.env.${k}`, "must be a string");
      env[k] = v;
    }
  }

  if (p.workerModel !== undefined && p.workerModel !== "default" && p.workerModel !== "fast") {
    bad(`.providers.${name}.worker_model`, 'must be "default" or "fast"');
  }
  const quotaSkipAt = p.quotaSkipAt === undefined ? undefined : p.quotaSkipAt;
  if (quotaSkipAt !== undefined) {
    if (typeof quotaSkipAt !== "number" || quotaSkipAt < 0 || quotaSkipAt > 100) {
      bad(`.providers.${name}.quotaSkipAt`, "must be a number between 0 and 100");
    }
  }

  let thinking: boolean | undefined;
  if (p.thinking !== undefined) {
    if (p.thinking !== "on" && p.thinking !== "off" && typeof p.thinking !== "boolean") {
      bad(`.providers.${name}.thinking`, 'must be "on" or "off"');
    }
    thinking = p.thinking === "on" || p.thinking === true;
  }

  const contextWindow = p.contextWindow === undefined ? undefined : p.contextWindow;
  if (contextWindow !== undefined) {
    if (typeof contextWindow !== "number" || contextWindow <= 0) {
      bad(`.providers.${name}.contextWindow`, "must be a positive number of tokens");
    }
  }

  if (p.maxConcurrent !== undefined) {
    if (typeof p.maxConcurrent !== "number" || !Number.isInteger(p.maxConcurrent) || p.maxConcurrent < 1) {
      bad(`.providers.${name}.maxConcurrent`, "must be a positive integer");
    }
  }

  if (p.conversationSlots !== undefined) {
    if (typeof p.conversationSlots !== "number" || !Number.isInteger(p.conversationSlots) || p.conversationSlots < 1) {
      bad(`.providers.${name}.conversationSlots`, "must be a positive integer");
    }
  }

  const upstreamUrl = str(p.upstreamUrl);
  if (protocol === "openai" && !upstreamUrl) {
    bad(`.providers.${name}.upstreamUrl`, `is required for protocol "openai" (the Chat Completions base, e.g. "https://api.openai.com/v1")`);
  }

  const costTier = p.costTier === undefined ? undefined : p.costTier;
  if (costTier !== undefined) {
    if (typeof costTier !== "number" || !Number.isInteger(costTier) || costTier < 1 || costTier > 5) {
      bad(`.providers.${name}.costTier`, "must be an integer 1 (cheapest) … 5 (most expensive)");
    }
  }

  let tags: ProviderTag[] | undefined;
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || p.tags.some((x) => typeof x !== "string")) {
      bad(`.providers.${name}.tags`, `must be an array of tags from: ${PROVIDER_TAGS.join(", ")}`);
    }
    for (const t of p.tags as string[]) {
      if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
        bad(`.providers.${name}.tags`, `"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
      }
    }
    tags = p.tags as ProviderTag[];
  }

  let usage: ProviderUsage | undefined;
  if (p.usage !== undefined) {
    if (typeof p.usage !== "object" || p.usage === null || Array.isArray(p.usage)) {
      bad(`.providers.${name}.usage`, "must be an object");
    }
    const u = p.usage as Record<string, unknown>;
    const usageUrl = str(u.url);
    if (!usageUrl) bad(`.providers.${name}.usage.url`, "is required");
    if (!Array.isArray(u.windows) || u.windows.length === 0) {
      bad(`.providers.${name}.usage.windows`, "must be a non-empty array");
    }
    const windows: UsageWindow[] = [];
    for (const [i, wRaw] of (u.windows as unknown[]).entries()) {
      const wpath = `.providers.${name}.usage.windows[${i}]`;
      if (typeof wRaw !== "object" || wRaw === null || Array.isArray(wRaw)) {
        bad(wpath, "must be an object");
      }
      const w = wRaw as Record<string, unknown>;
      const wname = str(w.name);
      if (!wname) bad(`${wpath}.name`, "is required");
      const percent = str(w.percent);
      if (!percent) bad(`${wpath}.percent`, "is required (a jq expression yielding 0–100)");
      const resetUnit = w.resetUnit === undefined ? undefined : str(w.resetUnit);
      if (resetUnit !== undefined && resetUnit !== "ms" && resetUnit !== "s" && resetUnit !== "iso") {
        bad(`${wpath}.resetUnit`, `must be "ms", "s" or "iso"`);
      }
      windows.push({
        name: wname,
        percent,
        ...(str(w.resetAt) ? { resetAt: str(w.resetAt) } : {}),
        ...(resetUnit ? { resetUnit } : {}),
      });
    }
    const ttlSeconds = u.ttlSeconds === undefined ? undefined : u.ttlSeconds;
    if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || ttlSeconds <= 0)) {
      bad(`.providers.${name}.usage.ttlSeconds`, "must be a positive number of seconds");
    }
    usage = {
      url: usageUrl,
      ...(str(u.authHeader) ? { authHeader: str(u.authHeader) } : {}),
      ...(str(u.label) ? { label: str(u.label) } : {}),
      windows,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    };
  }

  return {
    enabled: p.enabled === undefined ? true : p.enabled === true,
    protocol,
    baseUrl,
    keyFile,
    ...(key ? { key } : {}),
    models,
    ...(modelTiers ? { modelTiers } : {}),
    env,
    ...(str(p.note) ? { note: str(p.note) } : {}),
    ...(p.router === false ? { router: false } : {}),
    ...(str(p.contract) ? { contract: str(p.contract) } : {}),
    ...(upstreamUrl ? { upstreamUrl } : {}),
    ...(engine !== "claude" ? { engine } : {}),
    ...(str(p.quotaProbe) ? { quotaProbe: str(p.quotaProbe) } : {}),
    ...(p.workerModel === "fast" ? { workerModel: "fast" as const } : {}),
    ...(quotaSkipAt !== undefined ? { quotaSkipAt } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(p.maxConcurrent !== undefined ? { maxConcurrent: p.maxConcurrent as number } : {}),
    ...(p.conversationSlots !== undefined ? { conversationSlots: p.conversationSlots as number } : {}),
    ...(costTier !== undefined ? { costTier } : {}),
    ...(tags ? { tags } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Parse a `classes` (or legacy `roles`) value shared by JSON and YAML
 * loading. `badPathPrefix` names the field in error messages, e.g. ".classes".
 */
export function parseClassesValue(
  classesRaw: unknown,
  badPathPrefix: string
): Record<string, ClassTarget> {
  // The shipped defaults file's classes apply only when the key is absent;
  // a user's map replaces it wholesale (HEAD semantics — the map is the
  // routing table, not a patch; a shipped row would shadow repointed classes
  // at read time).
  const classes: Record<string, ClassTarget> = {};
  if (classesRaw === undefined) return {};
  if (typeof classesRaw !== "object" || classesRaw === null || Array.isArray(classesRaw)) {
    bad(badPathPrefix, "must be an object of class → provider[/alias] or {provider, mcp, maxCostTier, requireTags, order}");
  }
  for (const [cls, target] of Object.entries(classesRaw as Record<string, unknown>)) {
    if (typeof target === "object" && target !== null && !Array.isArray(target)) {
      const o = target as Record<string, unknown>;
      const provider = str(o.provider);
      if (o.provider !== undefined && (!provider || provider.includes(" "))) {
        bad(`${badPathPrefix}.${cls}.provider`, `invalid provider "${provider}"`);
      }
      let mcp: string[] | undefined;
      if (o.mcp !== undefined) {
        if (!Array.isArray(o.mcp) || o.mcp.some((x) => typeof x !== "string")) {
          bad(`${badPathPrefix}.${cls}.mcp`, "must be an array of MCP server or set names");
        }
        mcp = o.mcp as string[];
      }
      let maxCostTier: number | undefined;
      if (o.maxCostTier !== undefined) {
        if (
          typeof o.maxCostTier !== "number" ||
          !Number.isInteger(o.maxCostTier) ||
          o.maxCostTier < 1 ||
          o.maxCostTier > 5
        ) {
          bad(`${badPathPrefix}.${cls}.maxCostTier`, "must be an integer 1 … 5");
        }
        maxCostTier = o.maxCostTier;
      }
      let requireTags: string[] | undefined;
      if (o.requireTags !== undefined) {
        if (!Array.isArray(o.requireTags) || o.requireTags.some((x) => typeof x !== "string")) {
          bad(`${badPathPrefix}.${cls}.requireTags`, `must be an array of tags from: ${PROVIDER_TAGS.join(", ")}`);
        }
        for (const t of o.requireTags as string[]) {
          if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
            bad(`${badPathPrefix}.${cls}.requireTags`, `"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
          }
        }
        requireTags = o.requireTags as string[];
      }
      let order: string[] | undefined;
      if (o.order !== undefined) {
        if (!Array.isArray(o.order) || o.order.some((x) => typeof x !== "string")) {
          bad(`${badPathPrefix}.${cls}.order`, "must be an array of provider names");
        }
        order = o.order as string[];
      }
      let models: string[] | undefined;
      if (o.models !== undefined) {
        if (!Array.isArray(o.models) || o.models.some((x) => typeof x !== "string" || !x || x.includes(" "))) {
          bad(`${badPathPrefix}.${cls}.models`, "must be an array of provider[/model] entries");
        }
        models = [...new Set(o.models as string[])];
      }
      const note = str(o.note);
      const obj: ClassTarget = {
        ...(provider ? { provider } : {}),
        ...(note ? { note } : {}),
        ...(models?.length ? { models } : {}),
        ...(mcp ? { mcp } : {}),
        ...(maxCostTier !== undefined ? { maxCostTier } : {}),
        ...(requireTags ? { requireTags } : {}),
        ...(order ? { order } : {}),
      };
      classes[cls] = Object.keys(obj).length ? obj : {};
    } else {
      const t = str(target);
      if (!t || t.includes(" ")) bad(`${badPathPrefix}.${cls}`, `invalid target "${t}"`);
      classes[cls] = t;
    }
  }
  return classes;
}

/**
 * Parse an `mcpSets` (or `mcp_sets`) value shared by JSON and YAML loading.
 * Always merged over the shipped defaults file's `mcp_sets`, so an omitted
 * `desktop` key keeps the built-in clickr set.
 */
export function parseMcpSetsValue(raw: unknown, badPathPrefix: string): Record<string, string[]> {
  // The shipped defaults file's sets start the map; a user's entries replace
  // them per set, so `desktop: []` removes the set deliberately.
  const mcpSets: Record<string, string[]> = {
    ...((shippedWorkersDefaults().mcp_sets as Record<string, string[]>) ?? {}),
  };
  if (raw === undefined) return mcpSets;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad(badPathPrefix, "must be an object of set name → [server names]");
  }
  for (const [setName, servers] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(servers) || servers.some((x) => typeof x !== "string")) {
      bad(`${badPathPrefix}.${setName}`, "must be an array of MCP server names");
    }
    mcpSets[setName] = servers as string[];
  }
  return mcpSets;
}

/**
 * Parse a `capabilities` value shared by JSON and YAML loading: capability
 * name (open set, see isModelCapability) → provider names in preference
 * order. Provider names are not cross-checked here — a name that stops
 * existing is simply skipped by resolveCapability at resolve time, the same
 * way routing.order tolerates a removed provider.
 */
export function parseCapabilitiesValue(raw: unknown, badPathPrefix: string): Record<string, string[]> {
  const capabilities: Record<string, string[]> = {};
  if (raw === undefined) return capabilities;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad(badPathPrefix, "must be an object of capability name → [provider names]");
  }
  for (const [name, order] of Object.entries(raw as Record<string, unknown>)) {
    if (!isModelCapability(name)) {
      bad(`${badPathPrefix}.${name}`, `"${name}" is not a valid capability name (must match ^[a-z][a-z0-9-]*$)`);
    }
    if (!Array.isArray(order) || order.length === 0 || order.some((x) => typeof x !== "string" || !x)) {
      bad(`${badPathPrefix}.${name}`, "must be a non-empty array of provider names");
    }
    capabilities[name] = order as string[];
  }
  return capabilities;
}

/**
 * Parse and validate a raw `workers` value. Missing section → defaults.
 * Unknown-but-typed garbage → WorkersConfigError naming the offending field.
 */
export function parseWorkersConfig(raw: unknown, yamlProviders: Record<string, WorkerProvider> = {}): WorkersConfig {
  const d = defaultWorkersConfig();
  if (raw === undefined || raw === null) return d;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    bad("", "section must be an object");
  }
  const w = raw as Record<string, unknown>;

  const providers: Record<string, WorkerProvider> = {};
  if (w.providers !== undefined) {
    if (typeof w.providers !== "object" || w.providers === null || Array.isArray(w.providers)) {
      bad(".providers", "must be an object keyed by provider name");
    }
    for (const [name, p] of Object.entries(w.providers)) {
      providers[name] = parseProvider(name, p);
    }
  }

  // classes is canonical; a config that still carries the pre-classes `roles`
  // key is migrated by reading it here — the next write stores only `classes`.
  const classesRaw = w.classes !== undefined ? w.classes : w.roles;
  const classes =
    classesRaw === undefined
      ? { ...d.classes }
      : parseClassesValue(classesRaw, w.classes !== undefined ? ".classes" : ".roles");

  const mcpSets = parseMcpSetsValue(w.mcpSets, ".mcpSets");
  const capabilities = parseCapabilitiesValue(w.capabilities, ".capabilities");

  let pane = { ...d.pane };
  if (w.pane !== undefined) {
    if (typeof w.pane !== "object" || w.pane === null) bad(".pane", "must be an object");
    const pc = w.pane as Record<string, unknown>;
    if (pc.enabled !== undefined && typeof pc.enabled !== "boolean") bad(".pane.enabled", "must be boolean");
    if (pc.fontSize !== undefined && (typeof pc.fontSize !== "number" || pc.fontSize <= 0)) {
      bad(".pane.fontSize", "must be a positive number of points");
    }
    if (pc.autoExitSecs !== undefined && typeof pc.autoExitSecs !== "number") {
      bad(".pane.autoExitSecs", "must be a number");
    }
    // legacy fontScale (a relative scale, superseded by fontSize) is tolerated and ignored
    pane = {
      enabled: pc.enabled === undefined ? d.pane.enabled : pc.enabled === true,
      fontSize: pc.fontSize === undefined ? d.pane.fontSize : pc.fontSize,
      autoExitSecs: pc.autoExitSecs === undefined ? d.pane.autoExitSecs : pc.autoExitSecs,
    };
  }

  let routing = { ...d.routing, order: [] as string[] };
  if (w.routing !== undefined) {
    if (typeof w.routing !== "object" || w.routing === null) bad(".routing", "must be an object");
    const r = w.routing as Record<string, unknown>;
    if (r.order !== undefined) {
      if (!Array.isArray(r.order) || r.order.some((x) => typeof x !== "string")) {
        bad(".routing.order", "must be an array of provider names");
      }
      routing.order = r.order as string[];
    }
    if (r.cooldownMinutes !== undefined && typeof r.cooldownMinutes !== "number") {
      bad(".routing.cooldownMinutes", "must be a number");
    }
    if (r.retryOnQuota !== undefined && typeof r.retryOnQuota !== "boolean") {
      bad(".routing.retryOnQuota", "must be boolean");
    }
    if (r.policy !== undefined && r.policy !== "budget" && r.policy !== "order") {
      bad(".routing.policy", 'must be "budget" or "order"');
    }
    if (r.priority !== undefined) {
      if (!Array.isArray(r.priority) || r.priority.some((x) => typeof x !== "string")) {
        bad(".routing.priority", "must be an array of provider names");
      }
    }
    if (r.budgetWalls !== undefined) {
      if (typeof r.budgetWalls !== "object" || r.budgetWalls === null || Array.isArray(r.budgetWalls)) {
        bad(".routing.budgetWalls", "must be an object of provider name → percent or window → percent");
      }
      const okPct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
      for (const [k, v] of Object.entries(r.budgetWalls as Record<string, unknown>)) {
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          for (const [w, pct] of Object.entries(v as Record<string, unknown>)) {
            if (!okPct(pct)) bad(`.routing.budgetWalls.${k}.${w}`, "must be a percent 0–100");
          }
        } else if (!okPct(v)) {
          bad(`.routing.budgetWalls.${k}`, "must be a percent 0–100 or a map of window name → percent");
        }
      }
    }
    routing = {
      order: routing.order,
      cooldownMinutes: r.cooldownMinutes === undefined ? d.routing.cooldownMinutes : r.cooldownMinutes,
      retryOnQuota: r.retryOnQuota === undefined ? d.routing.retryOnQuota : r.retryOnQuota === true,
      policy: (r.policy as WorkersRoutingConfig["policy"]) ?? d.routing.policy,
      priority: r.priority === undefined ? [] : [...(r.priority as string[])],
      budgetWalls:
        r.budgetWalls === undefined ? {} : ({ ...(r.budgetWalls as WorkersRoutingConfig["budgetWalls"]) }),
      budgetPriority: [...d.routing.budgetPriority],
      budgetPercent: { ...d.routing.budgetPercent },
      budgetWall: d.routing.budgetWall,
    };
  }

  let supervision: WorkersSupervisionConfig = { ...d.supervision };
  if (w.supervision !== undefined) {
    if (typeof w.supervision !== "object" || w.supervision === null || Array.isArray(w.supervision)) {
      bad(".supervision", "must be an object");
    }
    const sv = w.supervision as Record<string, unknown>;
    if (sv.pointer !== undefined && typeof sv.pointer !== "boolean") bad(".supervision.pointer", "must be a boolean");
    if (sv.push !== undefined && sv.push !== "harness" && sv.push !== "all") bad(".supervision.push", 'must be "harness" or "all"');
    if (sv.stallMinutes !== undefined && !(typeof sv.stallMinutes === "number" && Number.isFinite(sv.stallMinutes) && sv.stallMinutes > 0)) {
      bad(".supervision.stallMinutes", "must be a positive number");
    }
    supervision = {
      pointer: sv.pointer === true,
      push: sv.push === "all" ? "all" : "harness",
      stallMinutes: typeof sv.stallMinutes === "number" ? sv.stallMinutes : d.supervision.stallMinutes,
    };
  }

  let tree = { ...d.tree };
  if (w.tree !== undefined) {
    if (typeof w.tree !== "object" || w.tree === null || Array.isArray(w.tree)) {
      bad(".tree", "must be an object");
    }
    const t = w.tree as Record<string, unknown>;
    if (t.maxDepth !== undefined) {
      if (typeof t.maxDepth !== "number" || !Number.isInteger(t.maxDepth) || t.maxDepth < 0) {
        bad(".tree.maxDepth", "must be a non-negative integer");
      }
    }
    if (t.maxChildren !== undefined) {
      if (typeof t.maxChildren !== "number" || !Number.isInteger(t.maxChildren) || t.maxChildren < 1) {
        bad(".tree.maxChildren", "must be a positive integer");
      }
    }
    tree = {
      maxDepth: t.maxDepth === undefined ? d.tree.maxDepth : t.maxDepth,
      maxChildren: t.maxChildren === undefined ? d.tree.maxChildren : t.maxChildren,
    };
  }

  let pool = { ...d.pool };
  if (w.pool !== undefined) {
    if (typeof w.pool !== "object" || w.pool === null || Array.isArray(w.pool)) {
      bad(".pool", "must be an object");
    }
    const pc = w.pool as Record<string, unknown>;
    if (pc.enabled !== undefined && typeof pc.enabled !== "boolean") bad(".pool.enabled", "must be boolean");
    if (pc.native !== undefined && typeof pc.native !== "boolean") bad(".pool.native", "must be boolean");
    if (pc.maxSlots !== undefined) {
      if (typeof pc.maxSlots !== "number" || !Number.isInteger(pc.maxSlots) || pc.maxSlots < 1 || pc.maxSlots > 8) {
        bad(".pool.maxSlots", "must be an integer 1 … 8");
      }
    }
    if (pc.idleSecs !== undefined) {
      if (typeof pc.idleSecs !== "number" || !Number.isInteger(pc.idleSecs) || pc.idleSecs < 0) {
        bad(".pool.idleSecs", "must be a non-negative integer (seconds, 0 = never)");
      }
    }
    if (pc.continuation !== undefined && typeof pc.continuation !== "boolean") bad(".pool.continuation", "must be boolean");
    if (pc.spares !== undefined) {
      if (typeof pc.spares !== "number" || !Number.isInteger(pc.spares) || pc.spares < 0 || pc.spares > 4) {
        bad(".pool.spares", "must be an integer 0 … 4 (0 = off)");
      }
    }
    if (pc.idleKillSec !== undefined) {
      if (typeof pc.idleKillSec !== "number" || !Number.isInteger(pc.idleKillSec) || pc.idleKillSec < 0) {
        bad(".pool.idleKillSec", "must be a non-negative integer (seconds, 0 = never)");
      }
    }
    if (pc.port !== undefined) {
      if (typeof pc.port !== "number" || !Number.isInteger(pc.port) || pc.port <= 0 || pc.port > 65535) {
        bad(".pool.port", "must be a TCP port (1 … 65535)");
      }
    }
    pool = {
      enabled: pc.enabled === undefined ? d.pool.enabled : pc.enabled === true,
      maxSlots: pc.maxSlots === undefined ? d.pool.maxSlots : pc.maxSlots,
      idleSecs: pc.idleSecs === undefined ? d.pool.idleSecs : pc.idleSecs,
      port: pc.port === undefined ? d.pool.port : pc.port,
      native: pc.native === undefined ? d.pool.native : pc.native === true,
      spares: pc.spares === undefined ? d.pool.spares : (pc.spares as number),
      idleKillSec: pc.idleKillSec === undefined ? d.pool.idleKillSec : (pc.idleKillSec as number),
      continuation: pc.continuation === undefined ? d.pool.continuation : pc.continuation === true,
    };
  }

  let cacheKeepaliveSecs = d.cacheKeepaliveSecs;
  if (w.cacheKeepaliveSecs !== undefined) {
    if (
      typeof w.cacheKeepaliveSecs !== "number" ||
      !Number.isInteger(w.cacheKeepaliveSecs) ||
      w.cacheKeepaliveSecs < 0
    ) {
      bad(".cacheKeepaliveSecs", "must be a non-negative integer (seconds, 0 = off)");
    }
    cacheKeepaliveSecs = w.cacheKeepaliveSecs;
  }

  let defaultMaxMinutes = d.defaultMaxMinutes;
  if (w.defaultMaxMinutes !== undefined) {
    if (typeof w.defaultMaxMinutes !== "number" || !Number.isInteger(w.defaultMaxMinutes) || w.defaultMaxMinutes < 0) {
      bad(".defaultMaxMinutes", "must be a non-negative integer (minutes, 0 = no limit)");
    }
    defaultMaxMinutes = w.defaultMaxMinutes;
  }
  let waitAlarmMinutes = d.waitAlarmMinutes;
  if (w.waitAlarmMinutes !== undefined) {
    if (typeof w.waitAlarmMinutes !== "number" || !Number.isInteger(w.waitAlarmMinutes) || w.waitAlarmMinutes < 1) {
      bad(".waitAlarmMinutes", "must be a positive integer (minutes)");
    }
    waitAlarmMinutes = w.waitAlarmMinutes;
  }
  const stagger = { ...d.stagger };
  if (w.stagger !== undefined) {
    if (typeof w.stagger !== "object" || w.stagger === null || Array.isArray(w.stagger)) {
      bad(".stagger", "must be an object");
    }
    const t = w.stagger as Record<string, unknown>;
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== "boolean") bad(".stagger.enabled", "must be true or false");
      stagger.enabled = t.enabled as boolean;
    }
    for (const k of ["localDefaultSec", "remoteDefaultSec", "minSec", "maxSec"] as const) {
      if (t[k] === undefined) continue;
      if (typeof t[k] !== "number" || !Number.isFinite(t[k]) || (t[k] as number) < 0) {
        bad(`.stagger.${k}`, "must be a non-negative number of seconds");
      }
      stagger[k] = t[k] as number;
    }
  }
  const capacity: CapacityConfig = { ...d.capacity };
  if (w.capacity !== undefined) {
    if (typeof w.capacity !== "object" || w.capacity === null || Array.isArray(w.capacity)) {
      bad(".capacity", "must be an object");
    }
    const t = w.capacity as Record<string, unknown>;
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== "boolean") bad(".capacity.enabled", "must be true or false");
      capacity.enabled = t.enabled as boolean;
    }
    for (const k of ["localDefaultCap", "uncappedQueueCap", "maxTotalWaitMs", "heartbeatMs", "agingMs"] as const) {
      if (t[k] === undefined) continue;
      if (typeof t[k] !== "number" || !Number.isFinite(t[k]) || (t[k] as number) <= 0) bad(`.capacity.${k}`, "must be a positive number");
      capacity[k] = t[k] as number;
    }
  }
  const localIdle = { ...d.localIdle };
  if (w.localIdle !== undefined) {
    if (typeof w.localIdle !== "object" || w.localIdle === null || Array.isArray(w.localIdle)) {
      bad(".localIdle", "must be an object");
    }
    const t = w.localIdle as Record<string, unknown>;
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== "boolean") bad(".localIdle.enabled", "must be true or false");
      localIdle.enabled = t.enabled as boolean;
    }
    for (const k of ["gpuBelowPct", "minutes", "backoffMinutes"] as const) {
      if (t[k] === undefined) continue;
      if (typeof t[k] !== "number" || !Number.isFinite(t[k]) || (t[k] as number) <= 0) bad(`.localIdle.${k}`, "must be a positive number");
      localIdle[k] = t[k] as number;
    }
  }
  const loopGuard = { ...d.loopGuard };
  if (w.loopGuard !== undefined) {
    if (typeof w.loopGuard !== "object" || w.loopGuard === null || Array.isArray(w.loopGuard)) bad(".loopGuard", "must be an object");
    const t = w.loopGuard as Record<string, unknown>;
    for (const k of ["echoLines", "echoChars", "echoRunnerLines"] as const) {
      if (t[k] === undefined) continue;
      if (typeof t[k] !== "number" || !Number.isInteger(t[k]) || (t[k] as number) < 0) bad(`.loopGuard.${k}`, "must be a non-negative integer");
      loopGuard[k] = t[k] as number;
    }
  }
  if (w.noBrowserByDefault !== undefined && typeof w.noBrowserByDefault !== "boolean") {
    bad(".noBrowserByDefault", "must be true or false");
  }
  const noBrowserByDefault = w.noBrowserByDefault === true;
  const positive = (key: string, v: unknown, dflt: number): number => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`.${key}`, "must be a positive number");
    return v as number;
  };
  const gcOlderThanHours = positive("gcOlderThanHours", w.gcOlderThanHours, d.gcOlderThanHours);
  const worktreesMaxGb = positive("worktreesMaxGb", w.worktreesMaxGb, d.worktreesMaxGb);
  if (w.reaper !== undefined && typeof w.reaper !== "boolean") {
    bad(".reaper", "must be true or false");
  }
  const reaper = w.reaper !== false;

  if (w.caveman !== undefined && typeof w.caveman !== "boolean") {
    bad(".caveman", "must be true or false");
  }
  const caveman = w.caveman === true;

  const active = w.active === undefined || w.active === null ? null : str(w.active);
  if (active !== null && active !== "auto" && !(active in providers)) {
    // Tolerated at parse time (a provider may have been removed while active
    // still names it) but every consumer resolves it to a clear error.
  }

  let fallback: WorkersFallback | null = null;
  if (w.fallback !== undefined && w.fallback !== null) {
    if (typeof w.fallback !== "object" || Array.isArray(w.fallback)) {
      bad(".fallback", "must be an object (written by `pai worker fallback on`)");
    }
    const f = w.fallback as Record<string, unknown>;
    const provider = str(f.provider);
    if (!provider) bad(".fallback.provider", "is required");
    const savedRaw = f.saved;
    if (typeof savedRaw !== "object" || savedRaw === null || Array.isArray(savedRaw)) {
      bad(".fallback.saved", "must be an object");
    }
    const s = savedRaw as Record<string, unknown>;
    if (typeof s.env !== "object" || s.env === null || Array.isArray(s.env)) {
      bad(".fallback.saved.env", "must be an object of env key → previous value or null");
    }
    const env: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
      env[k] = v === null || typeof v === "string" ? (v as string | null) : null;
    }
    if (s.model !== null && s.model !== undefined && typeof s.model !== "string") {
      bad(".fallback.saved.model", "must be a string or null");
    }
    fallback = {
      provider,
      saved: {
        env,
        model: typeof s.model === "string" ? s.model : null,
        envExisted: s.envExisted === true,
      },
      on: str(f.on) || new Date(0).toISOString(),
    };
  }

  return {
    enabled: w.enabled === undefined ? d.enabled : w.enabled === true,
    active,
    providers,
    classes,
    // a `local` placeholder entry resolves to the first enabled local provider
    // of this section (the JSON path has no `local:` key)
    tiers: parseTiersValue(
      w.tiers,
      "workers.tiers",
      Object.entries(providers).find(([, p]) => p.enabled && p.engine !== "image" && isLocalProvider(p.baseUrl))?.[0] ?? null
    ),
    mcpSets,
    capabilities,
    pane,
    logDir: str(w.logDir) || d.logDir,
    routing,
    tree,
    supervision,
    pool,
    cacheKeepaliveSecs,
    defaultMaxMinutes,
    waitAlarmMinutes,
    stagger,
    capacity,
    localIdle,
    escalate: parseEscalate(w.escalate, bad),
    loopGuard,
    noBrowserByDefault,
    gcOlderThanHours,
    worktreesMaxGb,
    reaper,
    caveman,
    fallback,
    nativeModels: { ...d.nativeModels },
    costTier: d.costTier,
    quotaSkipAt: d.quotaSkipAt,
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

function workersYamlDataOf(workers: WorkersConfig): WorkersYamlData {
  return {
    active: workers.active,
    providers: workers.providers,
    classes: workers.classes,
    tiers: workers.tiers,
    mcpSets: workers.mcpSets,
    capabilities: workers.capabilities,
    nativeModels: workers.nativeModels,
  };
}

/**
 * Read the whole config file and return (raw, workers) — the raw record so
 * callers can rewrite it preserving every other section, the parsed+validated
 * workers section. Unreadable config throws, missing is fine. `path`
 * overrides the config location (tests, CLAUDE_SETTINGS_PATH-style dry runs);
 * default CONFIG_FILE (see paiConfigFilePath). Reads via readMainConfigRaw,
 * so a config.yaml next to `path` is preferred over JSON, same as every
 * other main-config reader.
 *
 * Providers, classes, mcpSets and active load from workers.yaml (next to
 * `path`) when it exists; otherwise they fall back to the JSON `workers`
 * section, and then to built-in defaults — nothing breaks before migration
 * (`pai worker config migrate`). Everything else (pane, routing, tree,
 * cacheKeepaliveSecs, fallback, enabled, logDir) always comes from the main
 * config (JSON or YAML).
 */
export function readWorkersSection(
  // paiConfigFilePath() at call time, not the module-load CONFIG_FILE: tests
  // re-point PAI_CONFIG_FILE after import (see paiConfigFilePath).
  path: string = paiConfigFilePath(),
  onWarn: (msg: string) => void = (msg) => process.stderr.write(`pai worker: ${msg}\n`)
): {
  raw: Record<string, unknown>;
  workers: WorkersConfig;
} {
  // The main config's `workers` section is read against the shipped defaults
  // file first (defaults/config.yaml merged under the user's file), so the
  // non-provider settings (pane, routing, tree, pool, …) come from config.
  const merged = effectiveMainConfig(path);
  const raw = readMainConfigRaw(path);
  // The providers live in workers.yaml when the user file exists (defaults
  // merged under it); otherwise they fall back to the JSON `workers` section.
  // Classes/mcpSets always ride the shipped defaults merged under whatever the
  // user wrote. A flat chain of the earlier JSON format is split by providers.
  const yaml = existsSync(workersYamlPath()) ? effectiveWorkersYamlData(workersYamlPath()) : null;
  const workers = parseWorkersConfig(merged.workers, yaml?.providers);
  if (yaml) {
    workers.active = yaml.active;
    workers.providers = yaml.providers;
    workers.tiers = yaml.tiers;
    workers.capabilities = yaml.capabilities;
    workers.nativeModels = yaml.nativeModels;
  }
  // classes/mcpSets ride workers.yaml when the user file names them; the JSON
  // section (or the shipped defaults via parseWorkersConfig) stands otherwise.
  workers.classes =
    yaml && Object.keys(yaml.classes).length ? yaml.classes : workers.classes;
  workers.mcpSets =
    yaml && Object.keys(yaml.mcpSets).length ? yaml.mcpSets : workers.mcpSets;
  // the retired rank chains (workers.chains) become the class lists; the next write drops the key
  // the nine per-class lists become the three role lists, those the `tiers` (t0 / t1 / t2); the next write stores them
  migrateClassRoutes(workers.classes);
  migrateLegacyChains((raw.workers as { chains?: unknown } | undefined)?.chains, workers.classes);
  migrateToTiers(workers);
  // no user workers.yaml and no legacy roles to fold: the shipped delegation table
  if (!workers.tiers.length) {
    const local = Object.entries(workers.providers).find(([, p]) => p.enabled && p.engine !== "image" && isLocalProvider(p.baseUrl))?.[0] ?? null;
    workers.tiers = parseTiersValue(shippedWorkersDefaults().tiers, "defaults tiers", local);
  }
  // role keys left over a config that already has tiers fold into the class ->
  // tier mapping (their list into the served tier) and drop — they must not
  // reach the pin migration as a "pin"
  const folded = foldLegacyRoles(workers.classes, workers.tiers);
  // a legacy per-class pin (workers.classes entry naming a route) moves into its
  // tier's list — the tier list is the only routing source for every class; the
  // next write stores only `tiers`
  const moved = migrateClassPins(workers.classes, workers.tiers);
  if (folded.length || moved.length)
    onWarn(`legacy routing migrated into the tier lists: ${[...folded, ...moved].join(", ")} (pai worker route)`);
  return { raw, workers };
}

/**
 * Write the workers section back, atomically. When workers.yaml exists, its
 * providers/classes/mcpSets/active are synced there (comment-preserving,
 * only the entries that changed are touched) and stripped from the JSON
 * `workers` section; everything else still writes to JSON as before.
 */
export function writeWorkersSection(
  raw: Record<string, unknown>,
  workers: WorkersConfig,
  path: string = CONFIG_FILE
): void {
  const yamlPath = workersYamlPath();
  const usingYaml = existsSync(yamlPath);
  if (usingYaml) {
    writeWorkersYaml(yamlPath, workersYamlDataOf(workers));
  }
  const jsonWorkers = usingYaml
    ? {
        enabled: workers.enabled,
        pane: workers.pane,
        logDir: workers.logDir,
        routing: workers.routing,
        tree: workers.tree,
        supervision: workers.supervision,
        pool: workers.pool,
        cacheKeepaliveSecs: workers.cacheKeepaliveSecs,
        defaultMaxMinutes: workers.defaultMaxMinutes,
        waitAlarmMinutes: workers.waitAlarmMinutes,
        stagger: workers.stagger,
        capacity: workers.capacity,
        localIdle: workers.localIdle,
        escalate: workers.escalate,
        loopGuard: workers.loopGuard,
        tiers: workers.tiers,
        noBrowserByDefault: workers.noBrowserByDefault,
        gcOlderThanHours: workers.gcOlderThanHours,
        worktreesMaxGb: workers.worktreesMaxGb,
        reaper: workers.reaper,
        caveman: workers.caveman,
        ...(workers.fallback ? { fallback: workers.fallback } : {}),
      }
    : workers.fallback
      ? workers
      : { ...workers, fallback: undefined };
  raw.workers = jsonWorkers;
  writeMainConfigRaw(raw, path);
}

/** Expand a leading ~ (config values are written with `~` to stay portable). */
export { expandHome };

// ---------------------------------------------------------------------------
// Runnability checks (proxy / codex providers included)
// ---------------------------------------------------------------------------

export function assertProviderRunnable(name: string, p: WorkerProvider): void {
  if (p.protocol === "openai" && !p.upstreamUrl) {
    throw new WorkersConfigError(
      `provider "${name}" uses protocol "openai" but has no upstreamUrl — ` +
        `set its Chat Completions base (e.g. "https://api.openai.com/v1") ` +
        `so the PAI proxy knows where to translate to.`
    );
  }
}

/** Where a provider's key file lives, or null. Shared by run + test + add. */
export function providerKeyPath(p: WorkerProvider): string | null {
  return p.keyFile ? expandHome(p.keyFile) : null;
}

/**
 * The provider's auth token: inline `key` wins when set, else `key_file`
 * read and trimmed, else null (native/local providers use the "local"
 * placeholder). The one place a provider's key value is resolved — every
 * spawn path (buildRunEnv, the codex runner, the openai proxy, the
 * machine-wide fallback) reads through this instead of its own
 * readFileSync, so inline keys work everywhere a key file already did.
 */
export function resolveProviderKey(p: WorkerProvider): string | null {
  if (p.key) return p.key;
  const keyPath = providerKeyPath(p);
  if (!keyPath) return null;
  let content: string;
  try {
    content = readFileSync(keyPath, "utf8");
  } catch {
    throw new WorkersConfigError(`key file not readable: ${keyPath}`);
  }
  const token = content.trim();
  if (!token) throw new WorkersConfigError(`key file is empty: ${keyPath}`);
  return token;
}

/** `key: ****` + last 4 chars — never the full value. Used everywhere a
 *  provider's key would otherwise be echoed (`providers`, `config check`). */
export function maskKey(key: string): string {
  return `****${key.slice(-4)}`;
}

export { DEFAULT_CONTEXT_WINDOW } from "../utils/model-window.js";

/** Cost tier of a provider for class filtering (unset = workers.costTier, the middle). */
export function providerCostTier(p: WorkerProvider): number {
  return p.costTier ?? defaultWorkersConfig().costTier;
}

/** Budget-routing skip percentage of a provider (unset = workers.quotaSkipAt). */
export function providerQuotaSkipAt(p: WorkerProvider): number {
  return p.quotaSkipAt ?? defaultWorkersConfig().quotaSkipAt;
}

/**
 * The model id for a capability: the provider's preference for it, else its
 * default model — the one resolution rule every consumer (image class, fast
 * tier spawns, env pins) goes through.
 */
export function resolveModelCapability(p: WorkerProvider, capability: ModelCapability): string {
  return p.models[capability] ?? p.models.default;
}

/** Runner behind a provider, defaulting to the Claude Code harness. */
function providerEngine(p: WorkerProvider): WorkerEngine {
  return p.engine ?? "claude";
}

/** Does this provider name a model for the capability ("default" always counts)? */
function providerDeclaresCapability(p: WorkerProvider, capability: string): boolean {
  return capability === "default" || p.models[capability] !== undefined;
}

/** A provider usable for this capability: declares it, enabled, and passes assertProviderRunnable. */
function providerUsableForCapability(p: WorkerProvider | undefined, capability: string): p is WorkerProvider {
  if (!p || !p.enabled || !providerDeclaresCapability(p, capability)) return false;
  try {
    assertProviderRunnable("", p);
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedCapability {
  /** Provider name the capability resolved to ("anthropic" for the built-in). */
  provider: string;
  model: string;
  engine: WorkerEngine;
  /**
   * True when nothing declared this capability anywhere and the result is
   * just the active provider's default model — a caller should treat this as
   * "no real image/vision/… provider is configured", not a genuine match.
   */
  fellBack: boolean;
}

/**
 * Cross-provider capability resolution (`workers.yaml`'s `capabilities:`
 * map): which provider+model serves a named capability (e.g. "image"),
 * independent of any one provider's own `models` table.
 *
 * Resolution order:
 *   1. `capabilities.<name>` (explicit preference list) — first provider
 *      that declares the capability, is enabled, and passes
 *      assertProviderRunnable.
 *   2. No preference list: the active provider, if it declares the
 *      capability.
 *   3. Still nothing: any enabled provider that declares the capability
 *      (stable order — provider names sorted, "anthropic" included).
 *   4. Nothing anywhere: the active provider's default model, `fellBack: true`.
 */
export function resolveCapability(
  workers: Pick<WorkersConfig, "providers" | "active" | "capabilities" | "nativeModels">,
  capability: string
): ResolvedCapability {
  const order = workers.capabilities[capability];
  if (order?.length) {
    for (const name of order) {
      const p = getProviderOrNative(workers, name);
      if (providerUsableForCapability(p, capability)) {
        return { provider: name, model: resolveModelCapability(p, capability), engine: providerEngine(p), fellBack: false };
      }
    }
    throw new WorkersConfigError(
      `no configured provider for capability "${capability}" is usable right now ` +
        `(checked, in order: ${order.join(", ")}) — set one with: pai worker capability ${capability} <provider>`
    );
  }

  const activeName = workers.active && workers.active !== "auto" ? workers.active : null;
  if (activeName) {
    const p = getProviderOrNative(workers, activeName);
    if (providerUsableForCapability(p, capability)) {
      return { provider: activeName, model: resolveModelCapability(p, capability), engine: providerEngine(p), fellBack: false };
    }
  }

  const candidates: Record<string, WorkerProvider> = {
    [ANTHROPIC_NATIVE]: nativeAnthropicProvider(workers.nativeModels),
    ...workers.providers,
  };
  for (const name of Object.keys(candidates).sort()) {
    const p = candidates[name];
    if (providerUsableForCapability(p, capability)) {
      return { provider: name, model: resolveModelCapability(p, capability), engine: providerEngine(p), fellBack: false };
    }
  }

  const fallbackName = activeName ?? ANTHROPIC_NATIVE;
  const fallback = getProviderOrNative(workers, fallbackName) ?? nativeAnthropicProvider(workers.nativeModels);
  return {
    provider: fallbackName,
    model: fallback.models.default,
    engine: providerEngine(fallback),
    fellBack: true,
  };
}

/**
 * Context window used by the meter when the run reports none: an explicit
 * `contextWindow` first, then whatever the default model's id declares
 * ("[1m]" → 1,000,000), then the last-resort default.
 */
export function providerContextWindow(p: WorkerProvider): number {
  return (
    p.contextWindow ??
    contextWindowFromModelId(p.models.default) ??
    DEFAULT_CONTEXT_WINDOW
  );
}

/** Directory under which inline keys (MCP `key` field) are stored, 0600. */
export function keysDir(): string {
  return paiHomePath("keys");
}
