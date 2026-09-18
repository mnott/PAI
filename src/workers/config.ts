/**
 * config.ts — the `workers` section of ~/.config/pai/config.json
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

import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";
import { CONFIG_FILE } from "../daemon/config.js";
import { contextWindowFromModelId, DEFAULT_CONTEXT_WINDOW } from "../utils/model-window.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wire protocol a provider speaks: "anthropic" natively, "openai" through the
 * PAI proxy (which translates the Anthropic Messages API to Chat Completions).
 */
export type WorkerProtocol = "anthropic" | "openai";

/** Runner executable behind a provider: Claude Code or the Codex CLI. */
export type WorkerEngine = "claude" | "codex";

export interface WorkerProvider {
  enabled: boolean;
  /** Wire protocol the baseUrl speaks. */
  protocol: WorkerProtocol;
  /** Anthropic-compatible Messages API base. */
  baseUrl: string;
  /** 0600 file holding the auth token; null for local servers ("local"). */
  keyFile: string | null;
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
 * The named model capabilities a provider may carry a preference for, set
 * per provider under `workers.providers.<name>.models`. "default" is the
 * required catch-all; the others name what a model is *for* — "fast" the
 * cheap tier (spotcheck, haiku-tier spawns), "image" the image class.
 * Everything resolves through resolveModelCapability, falling back to default.
 */
export const MODEL_CAPABILITIES = ["default", "fast", "image"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** Is this string the name of a known model capability? */
export function isModelCapability(v: string): v is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * Which model capability a class runs on when its target names no alias: the
 * image class uses the image model; every other class the provider default.
 */
const CLASS_MODEL_CAPABILITY: Record<WorkerClassName, ModelCapability> = {
  draft: "default",
  plan: "default",
  implement: "default",
  review: "default",
  research: "default",
  spotcheck: "default",
  simple: "default",
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
    pane: { ...DEFAULT_PANE },
    logDir: DEFAULT_LOG_DIR,
    routing: { ...DEFAULT_ROUTING, order: [] },
    tree: { ...DEFAULT_TREE },
    cacheKeepaliveSecs: DEFAULT_CACHE_KEEPALIVE_SECS,
    fallback: null,
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

function parseProvider(name: string, raw: unknown): WorkerProvider {
  if (typeof raw !== "object" || raw === null) bad(`.providers.${name}`, "must be an object");
  const p = raw as Record<string, unknown>;

  const protocol = p.protocol === undefined ? "anthropic" : str(p.protocol);
  if (protocol !== "anthropic" && protocol !== "openai") {
    bad(`.providers.${name}.protocol`, `"${str(p.protocol)}" is neither "anthropic" nor "openai"`);
  }
  const engine = p.engine === undefined ? "claude" : str(p.engine);
  if (engine !== "claude" && engine !== "codex") {
    bad(`.providers.${name}.engine`, `"${str(p.engine)}" is neither "claude" nor "codex"`);
  }

  const baseUrl = str(p.baseUrl);
  // openai providers reach the model through the PAI proxy; their baseUrl is
  // the proxy URL, filled in by the runner — only anthropic needs one here.
  if (!baseUrl && protocol !== "openai") bad(`.providers.${name}.baseUrl`, "is required");

  const keyFile =
    p.keyFile === undefined || p.keyFile === null || str(p.keyFile) === ""
      ? null
      : str(p.keyFile);

  const modelsRaw = p.models === undefined ? {} : p.models;
  if (typeof modelsRaw !== "object" || modelsRaw === null) {
    bad(`.providers.${name}.models`, "must be an object");
  }
  const m = modelsRaw as Record<string, unknown>;
  const defaultModel = str(m.default);
  if (!defaultModel) bad(`.providers.${name}.models.default`, "is required");
  const models: WorkerProvider["models"] = { default: defaultModel };
  for (const key of Object.keys(m)) {
    if (key === "default") continue;
    if (!isModelCapability(key)) {
      bad(
        `.providers.${name}.models.${key}`,
        `"${key}" is not a model capability (from: ${MODEL_CAPABILITIES.join(", ")})`
      );
    }
    const id = str(m[key]);
    if (!id) bad(`.providers.${name}.models.${key}`, "must be a non-empty model id");
    models[key] = id;
  }

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

  return {
    enabled: p.enabled === undefined ? true : p.enabled === true,
    protocol,
    baseUrl,
    keyFile,
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
  };
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
  const classes: Record<string, ClassTarget> = {};
  const classesRaw = w.classes !== undefined ? w.classes : w.roles;
  if (classesRaw !== undefined) {
    if (typeof classesRaw !== "object" || classesRaw === null || Array.isArray(classesRaw)) {
      bad(w.classes !== undefined ? ".classes" : ".roles", "must be an object of class → provider[/alias] or {provider, mcp, maxCostTier, requireTags, order}");
    }
    for (const [cls, target] of Object.entries(classesRaw)) {
      if (typeof target === "object" && target !== null && !Array.isArray(target)) {
        const o = target as Record<string, unknown>;
        const provider = str(o.provider);
        if (o.provider !== undefined && (!provider || provider.includes(" "))) {
          bad(`.classes.${cls}.provider`, `invalid provider "${provider}"`);
        }
        let mcp: string[] | undefined;
        if (o.mcp !== undefined) {
          if (!Array.isArray(o.mcp) || o.mcp.some((x) => typeof x !== "string")) {
            bad(`.classes.${cls}.mcp`, "must be an array of MCP server or set names");
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
            bad(`.classes.${cls}.maxCostTier`, "must be an integer 1 … 5");
          }
          maxCostTier = o.maxCostTier;
        }
        let requireTags: string[] | undefined;
        if (o.requireTags !== undefined) {
          if (!Array.isArray(o.requireTags) || o.requireTags.some((x) => typeof x !== "string")) {
            bad(`.classes.${cls}.requireTags`, `must be an array of tags from: ${PROVIDER_TAGS.join(", ")}`);
          }
          for (const t of o.requireTags as string[]) {
            if (!(PROVIDER_TAGS as readonly string[]).includes(t)) {
              bad(`.classes.${cls}.requireTags`, `"${t}" is not a tag (from: ${PROVIDER_TAGS.join(", ")})`);
            }
          }
          requireTags = o.requireTags as string[];
        }
        let order: string[] | undefined;
        if (o.order !== undefined) {
          if (!Array.isArray(o.order) || o.order.some((x) => typeof x !== "string")) {
            bad(`.classes.${cls}.order`, "must be an array of provider names");
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
        if (!t || t.includes(" ")) bad(`.classes.${cls}`, `invalid target "${t}"`);
        classes[cls] = t;
      }
    }
  }

  const mcpSets: Record<string, string[]> = { ...DEFAULT_MCP_SETS };
  if (w.mcpSets !== undefined) {
    if (typeof w.mcpSets !== "object" || w.mcpSets === null || Array.isArray(w.mcpSets)) {
      bad(".mcpSets", "must be an object of set name → [server names]");
    }
    for (const [setName, servers] of Object.entries(w.mcpSets)) {
      if (!Array.isArray(servers) || servers.some((x) => typeof x !== "string")) {
        bad(`.mcpSets.${setName}`, "must be an array of MCP server names");
      }
      mcpSets[setName] = servers as string[];
    }
  }

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
    pane,
    logDir: str(w.logDir) || d.logDir,
    routing,
    tree,
    cacheKeepaliveSecs,
    fallback,
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read the whole config file and return (raw, workers) — the raw record so
 * callers can rewrite it preserving every other section, the parsed+validated
 * workers section. Unreadable config throws (readJsonStrict), missing is fine.
 * `path` overrides the config location (tests, CLAUDE_SETTINGS_PATH-style
 * dry runs); default ~/.config/pai/config.json.
 */
export function readWorkersSection(path: string = CONFIG_FILE): {
  raw: Record<string, unknown>;
  workers: WorkersConfig;
} {
  const raw = readJsonStrict(path, "~/.config/pai/config.json");
  return { raw, workers: parseWorkersConfig(raw.workers) };
}

/** Write the workers section back into the config file, atomically. */
export function writeWorkersSection(
  raw: Record<string, unknown>,
  workers: WorkersConfig,
  path: string = CONFIG_FILE
): void {
  // null fallback (off) is omitted rather than written, so a config that
  // never used it does not gain a `"fallback": null` line from an unrelated
  // worker mutation.
  raw.workers = workers.fallback ? workers : { ...workers, fallback: undefined };
  writeJsonAtomic(path, raw, { label: "~/.config/pai/config.json" });
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
  return join(homedir(), ".config", "pai", "keys");
}
