/**
 * config.ts — the `workers` section of the PAI config file (CONFIG_FILE,
 * see src/daemon/config.ts's paiConfigFilePath — ~/.claude/pai/config.yaml
 * today, config.json until `pai config yaml` runs).
 *
 * Everything that knows about worker providers reads this module: the CLI
 * (`pai worker …`), the MCP tools (worker_*), and the Agent-routing hook.
 * Keep it free of commander/MCP imports so all three layers stay thin over it.
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, readMainConfigRaw, writeMainConfigRaw } from "../daemon/config.js";
import { paiHomePath } from "../config/pai-home.js";
import { contextWindowFromModelId, DEFAULT_CONTEXT_WINDOW } from "../utils/model-window.js";
import { readWorkersYaml, workersYamlPath, writeWorkersYaml, type WorkersYamlData } from "./workers-config.js";

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
  /** Extra environment variables for runs through this provider (string values). */
  env: Record<string, string>;
  note?: string;
  /**
   * OpenAI Chat Completions base (e.g. "https://api.openai.com/v1"). Required
   * for protocol "openai"; read by the PAI proxy, never by the runner.
   */
  upstreamUrl?: string;
  /** Runner for this provider; "codex" goes through the Codex CLI. */
  engine?: WorkerEngine;
  /** Optional shell command printing 0–100 (percent of quota used). */
  quotaProbe?: string;
  /** Auto-routing skips the provider at or above this percentage. Default 95. */
  quotaSkipAt?: number;
  /**
   * Context window of the provider's model, for the context meter. No
   * default: the meter only shows a window the init event announced (or
   * this explicit value, for engines without one, e.g. codex).
   */
  contextWindow?: number;
  /** Cost tier 1 (cheapest) … 5 (most expensive); classes cap it via maxCostTier. */
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
 * Models the built-in provider runs on. This is the only place a model id is
 * named for it: run.ts resolves the class capability against this table like
 * it does for any configured provider and passes `--model` explicitly.
 *
 * Workers exist to parallelise and to save cost, so they must never inherit
 * the orchestrator's model. A bare headless `claude` takes the interactive
 * session default, and one probe came up on the most expensive tier because
 * the chat session had been switched to it. Sonnet is the working tier;
 * haiku serves the fast classes (spotcheck, simple).
 */
export const NATIVE_ANTHROPIC_MODELS: WorkerProvider["models"] = {
  default: "claude-sonnet-5",
  fast: "claude-haiku-4-5-20251001",
};

/**
 * The synthetic provider object for ANTHROPIC_NATIVE. `baseUrl` is empty and
 * there is no key file, so buildRunEnv strips every provider env override;
 * the models come from NATIVE_ANTHROPIC_MODELS so a run always names its
 * model on the command line.
 */
export function nativeAnthropicProvider(
  models: WorkerProvider["models"] = NATIVE_ANTHROPIC_MODELS
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
}

/** Sub-worker caps: how deep the worker tree may grow, how wide per parent. */
export interface WorkersTreeConfig {
  /** Maximum nesting depth of sub-workers (top-level = 0). */
  maxDepth: number;
  /** Maximum concurrently running children per parent. */
  maxChildren: number;
}

/** Cost/quality tier of a provider's model, 1 (cheapest) … 5 (most expensive). */
export type CostTier = 1 | 2 | 3 | 4 | 5;

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
 * Which model capability a class runs on when its target names no alias: the
 * image class uses the image model, the cheap classes (spotcheck, simple) the
 * fast model, every other class the provider default. A provider without a
 * fast model falls back to its default (resolveModelCapability).
 */
const CLASS_MODEL_CAPABILITY: Record<WorkerClassName, ModelCapability> = {
  draft: "default",
  plan: "default",
  implement: "default",
  review: "default",
  research: "default",
  spotcheck: "fast",
  simple: "fast",
  complex: "default",
  image: "image",
};

/** Capability for a run's class (default when unset or not a standard class). */
export function classModelCapability(className?: string): ModelCapability {
  return (className && CLASS_MODEL_CAPABILITY[className as WorkerClassName]) || "default";
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
  /**
   * Daemon cache-keepalive cadence in seconds: how often a trivial
   * single-turn heartbeat worker re-arms the provider prompt cache
   * (src/workers/keepalive.ts). 0 = off.
   */
  cacheKeepaliveSecs: number;
  /** Machine-wide Claude Code fallback; null = off. */
  fallback: WorkersFallback | null;
  /**
   * Model ids for the built-in `anthropic` provider, when workers.yaml
   * documents an override under `providers.anthropic.models`. Defaults to
   * NATIVE_ANTHROPIC_MODELS.
   */
  nativeModels: WorkerProvider["models"];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_LOG_DIR = "~/.claude/logs/workers";

export const DEFAULT_PANE: WorkersPaneConfig = {
  enabled: true,
  fontSize: 13,
  autoExitSecs: 60,
};

export const DEFAULT_ROUTING: WorkersRoutingConfig = {
  order: [],
  cooldownMinutes: 30,
  retryOnQuota: true,
};

export const DEFAULT_TREE: WorkersTreeConfig = {
  maxDepth: 2,
  maxChildren: 4,
};

/**
 * Cache-keepalive cadence when the config names none. Measured 2026-09-18
 * (pair probes through the real worker spawn path, numbers in
 * docs/cache-keepalive.md): the implicit provider cache only serves a fresh
 * worker warm within roughly the first minute (positive back-to-back, gone
 * at 2 min), and it covers only ~2.6k of the ~18k-token prefix. Holding it
 * needs a beat every <2 min — a continuous bill for a small saving — so the
 * default is OFF and arming it is the operator's explicit call (set e.g.
 * "cacheKeepaliveSecs": 60).
 */
export const DEFAULT_CACHE_KEEPALIVE_SECS = 0;

/**
 * The default MCP sets every config starts from. `desktop` names the clickr
 * server so `--mcp desktop` hands a worker the machine controls (read-only
 * tools always; actuating ones after the operator hands the controls over,
 * see `pai worker controls`). A user's mcpSets section is merged over this,
 * so `desktop: []` removes the set deliberately.
 */
export const DEFAULT_MCP_SETS: Record<string, string[]> = {
  desktop: ["clickr"],
};

export function defaultWorkersConfig(): WorkersConfig {
  return {
    enabled: false,
    active: null,
    providers: {},
    classes: {},
    mcpSets: { ...DEFAULT_MCP_SETS },
    capabilities: {},
    pane: { ...DEFAULT_PANE },
    logDir: DEFAULT_LOG_DIR,
    routing: { ...DEFAULT_ROUTING, order: [] },
    tree: { ...DEFAULT_TREE },
    cacheKeepaliveSecs: DEFAULT_CACHE_KEEPALIVE_SECS,
    fallback: null,
    nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class WorkersConfigError extends Error {}

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

  const quotaSkipAt = p.quotaSkipAt === undefined ? undefined : p.quotaSkipAt;
  if (quotaSkipAt !== undefined) {
    if (typeof quotaSkipAt !== "number" || quotaSkipAt < 0 || quotaSkipAt > 100) {
      bad(`.providers.${name}.quotaSkipAt`, "must be a number between 0 and 100");
    }
  }

  const contextWindow = p.contextWindow === undefined ? undefined : p.contextWindow;
  if (contextWindow !== undefined) {
    if (typeof contextWindow !== "number" || contextWindow <= 0) {
      bad(`.providers.${name}.contextWindow`, "must be a positive number of tokens");
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
    ...(upstreamUrl ? { upstreamUrl } : {}),
    ...(engine !== "claude" ? { engine } : {}),
    ...(str(p.quotaProbe) ? { quotaProbe: str(p.quotaProbe) } : {}),
    ...(quotaSkipAt !== undefined ? { quotaSkipAt } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
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
  const classes: Record<string, ClassTarget> = {};
  if (classesRaw === undefined) return classes;
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
      const obj: ClassTarget = {
        ...(provider ? { provider } : {}),
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
 * Always merged over DEFAULT_MCP_SETS, so an omitted `desktop` key keeps the
 * built-in clickr set (see DEFAULT_MCP_SETS).
 */
export function parseMcpSetsValue(raw: unknown, badPathPrefix: string): Record<string, string[]> {
  const mcpSets: Record<string, string[]> = { ...DEFAULT_MCP_SETS };
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
export function parseWorkersConfig(raw: unknown): WorkersConfig {
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
  const classes = parseClassesValue(classesRaw, w.classes !== undefined ? ".classes" : ".roles");

  const mcpSets = parseMcpSetsValue(w.mcpSets, ".mcpSets");
  const capabilities = parseCapabilitiesValue(w.capabilities, ".capabilities");

  let pane = { ...DEFAULT_PANE };
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
      enabled: pc.enabled === undefined ? DEFAULT_PANE.enabled : pc.enabled === true,
      fontSize: pc.fontSize === undefined ? DEFAULT_PANE.fontSize : pc.fontSize,
      autoExitSecs: pc.autoExitSecs === undefined ? DEFAULT_PANE.autoExitSecs : pc.autoExitSecs,
    };
  }

  let routing = { ...DEFAULT_ROUTING, order: [] as string[] };
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
    routing = {
      order: routing.order,
      cooldownMinutes: r.cooldownMinutes === undefined ? DEFAULT_ROUTING.cooldownMinutes : r.cooldownMinutes,
      retryOnQuota: r.retryOnQuota === undefined ? DEFAULT_ROUTING.retryOnQuota : r.retryOnQuota === true,
    };
  }

  let tree = { ...DEFAULT_TREE };
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
      maxDepth: t.maxDepth === undefined ? DEFAULT_TREE.maxDepth : t.maxDepth,
      maxChildren: t.maxChildren === undefined ? DEFAULT_TREE.maxChildren : t.maxChildren,
    };
  }

  let cacheKeepaliveSecs = DEFAULT_CACHE_KEEPALIVE_SECS;
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
    mcpSets,
    capabilities,
    pane,
    logDir: str(w.logDir) || d.logDir,
    routing,
    tree,
    cacheKeepaliveSecs,
    fallback,
    nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
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
export function readWorkersSection(path: string = CONFIG_FILE): {
  raw: Record<string, unknown>;
  workers: WorkersConfig;
} {
  const raw = readMainConfigRaw(path);
  const workers = parseWorkersConfig(raw.workers);
  const yaml = readWorkersYaml(workersYamlPath());
  if (yaml) {
    workers.active = yaml.data.active;
    workers.providers = yaml.data.providers;
    workers.classes = yaml.data.classes;
    workers.mcpSets = yaml.data.mcpSets;
    workers.capabilities = yaml.data.capabilities;
    workers.nativeModels = yaml.data.nativeModels;
  }
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
        cacheKeepaliveSecs: workers.cacheKeepaliveSecs,
        ...(workers.fallback ? { fallback: workers.fallback } : {}),
      }
    : workers.fallback
      ? workers
      : { ...workers, fallback: undefined };
  raw.workers = jsonWorkers;
  writeMainConfigRaw(raw, path);
}

/** Expand a leading ~ (config values are written with `~` to stay portable). */
export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

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

/** Cost tier of a provider for class filtering (unset = 3, the middle). */
export function providerCostTier(p: WorkerProvider): number {
  return p.costTier ?? DEFAULT_COST_TIER;
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
