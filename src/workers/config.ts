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
  models: {
    default: string;
    /** Alias used for cheap/fast work (spotcheck, research). */
    fast?: string;
  };
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
  /** Context window of the provider's model, for the context meter. Default 200000. */
  contextWindow?: number;
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

/**
 * A role target: "<provider>", "<provider>/<modelAlias>", or an object with a
 * provider and the MCP servers (or mcpSets names) its workers start with.
 */
export type RoleTarget = string | { provider: string; mcp?: string[] };

export interface WorkersConfig {
  enabled: boolean;
  /** Provider name, or "auto" for routing.order resolution. */
  active: string | null;
  providers: Record<string, WorkerProvider>;
  /** Role → target; see RoleTarget. */
  roles: Record<string, RoleTarget>;
  /** MCP set name → server names; `--mcp <set>` and role `mcp` expand these. */
  mcpSets: Record<string, string[]>;
  pane: WorkersPaneConfig;
  logDir: string;
  routing: WorkersRoutingConfig;
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

export function defaultWorkersConfig(): WorkersConfig {
  return {
    enabled: false,
    active: null,
    providers: {},
    roles: {},
    mcpSets: {},
    pane: { ...DEFAULT_PANE },
    logDir: DEFAULT_LOG_DIR,
    routing: { ...DEFAULT_ROUTING, order: [] },
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
  const fast = m.fast === undefined ? undefined : str(m.fast);

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

  return {
    enabled: p.enabled === undefined ? true : p.enabled === true,
    protocol,
    baseUrl,
    keyFile,
    models: fast ? { default: defaultModel, fast } : { default: defaultModel },
    env,
    ...(str(p.note) ? { note: str(p.note) } : {}),
    ...(upstreamUrl ? { upstreamUrl } : {}),
    ...(engine !== "claude" ? { engine } : {}),
    ...(str(p.quotaProbe) ? { quotaProbe: str(p.quotaProbe) } : {}),
    ...(quotaSkipAt !== undefined ? { quotaSkipAt } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
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

  const roles: Record<string, RoleTarget> = {};
  if (w.roles !== undefined) {
    if (typeof w.roles !== "object" || w.roles === null || Array.isArray(w.roles)) {
      bad(".roles", "must be an object of role → provider[/alias] or {provider, mcp}");
    }
    for (const [role, target] of Object.entries(w.roles)) {
      if (typeof target === "object" && target !== null && !Array.isArray(target)) {
        const o = target as Record<string, unknown>;
        const provider = str(o.provider);
        if (!provider || provider.includes(" ")) {
          bad(`.roles.${role}.provider`, `invalid provider "${provider}"`);
        }
        let mcp: string[] | undefined;
        if (o.mcp !== undefined) {
          if (!Array.isArray(o.mcp) || o.mcp.some((x) => typeof x !== "string")) {
            bad(`.roles.${role}.mcp`, "must be an array of MCP server or set names");
          }
          mcp = o.mcp as string[];
        }
        roles[role] = mcp ? { provider, mcp } : { provider };
      } else {
        const t = str(target);
        if (!t || t.includes(" ")) bad(`.roles.${role}`, `invalid target "${t}"`);
        roles[role] = t;
      }
    }
  }

  const mcpSets: Record<string, string[]> = {};
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

  const active = w.active === undefined || w.active === null ? null : str(w.active);
  if (active !== null && active !== "auto" && !(active in providers)) {
    // Tolerated at parse time (a provider may have been removed while active
    // still names it) but every consumer resolves it to a clear error.
  }

  return {
    enabled: w.enabled === undefined ? d.enabled : w.enabled === true,
    active,
    providers,
    roles,
    mcpSets,
    pane,
    logDir: str(w.logDir) || d.logDir,
    routing,
  };
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read the whole config file and return (raw, workers) — the raw record so
 * callers can rewrite it preserving every other section, the parsed+validated
 * workers section. Unreadable config throws (readJsonStrict), missing is fine.
 */
export function readWorkersSection(): {
  raw: Record<string, unknown>;
  workers: WorkersConfig;
} {
  const raw = readJsonStrict(CONFIG_FILE, "~/.config/pai/config.json");
  return { raw, workers: parseWorkersConfig(raw.workers) };
}

/** Write the workers section back into the config file, atomically. */
export function writeWorkersSection(
  raw: Record<string, unknown>,
  workers: WorkersConfig
): void {
  raw.workers = workers;
  writeJsonAtomic(CONFIG_FILE, raw, { label: "~/.config/pai/config.json" });
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

export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context window used by the meter when the init event carries none. */
export function providerContextWindow(p: WorkerProvider): number {
  return p.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

/** Directory under which inline keys (MCP `key` field) are stored, 0600. */
export function keysDir(): string {
  return join(homedir(), ".config", "pai", "keys");
}
