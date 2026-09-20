/**
 * config.ts — Configuration loader for PAI Daemon
 *
 * Loads config from ~/.claude/pai/config.json (the pre-2026-09-19 location
 * was ~/.config/pai/config.json, briefly ~/.claude/pai.json in between —
 * see paiConfigFilePath/migrateConfigFile).
 * Deep-merges with defaults so partial configs work fine.
 * Expands ~ in path values at runtime.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import type { NotificationConfig } from "../notifications/types.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "../notifications/types.js";
import type { TaskConfig } from "../tasks/types.js";
import { DEFAULT_TASK_CONFIG } from "../tasks/types.js";
import { paiSocketPath } from "../runtime-paths.js";
import {
  paiHomePath,
  resolvePaiFile,
  migratePaiFile,
  PaiFileMigrationError,
  type MigrateFileResult,
} from "../config/pai-home.js";
import {
  yamlSiblingPath,
  readDualFormatConfigRaw,
  writeDualFormatConfigRaw,
  MainConfigError,
} from "../config/main-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchConfig {
  /** Default search mode: 'keyword', 'semantic', or 'hybrid'. Default: 'keyword'. */
  mode: "keyword" | "semantic" | "hybrid";
  /** Enable cross-encoder reranking by default. Default: true. */
  rerank: boolean;
  /** Recency boost half-life in days. 0 = off. Default: 90. */
  recencyBoostDays: number;
  /** Default max results. Default: 10. */
  defaultLimit: number;
  /** Default snippet length for MCP results. Default: 200. */
  snippetLength: number;
}

export interface PostgresConfig {
  /** Connection string — if set, overrides individual host/port/etc. fields */
  connectionString?: string;
  /** Postgres host (default: "localhost") */
  host?: string;
  /** Postgres port (default: 5432) */
  port?: number;
  /** Postgres database name (default: "pai") */
  database?: string;
  /** Postgres user (default: "pai") */
  user?: string;
  /** Postgres password (default: "pai") */
  password?: string;
  /** Maximum pool connections (default: 5) */
  maxConnections?: number;
  /** Connection timeout in ms (default: 5000) */
  connectionTimeoutMs?: number;
}

/**
 * Idle-triggered prompt-cache keepalive for interactive Claude Code sessions
 * (see docs/cache-keepalive.md, "Interactive sessions"). Distinct from
 * `workers.cacheKeepaliveSecs` (src/workers/config.ts), which re-arms a
 * *worker provider's* cache via trivial worker spawns on a fixed timer: this
 * beats a live interactive session only when it has actually gone idle long
 * enough to risk its 1h ephemeral cache expiring, and only within working
 * hours — a fixed timer would beat while the user is active (no-op, wasted
 * quota) or overnight (never pays back before the next real prompt anyway).
 */
export interface SessionsCacheKeepaliveConfig {
  /** Off by default — arming it is the operator's explicit call. */
  enabled: boolean;
  /** Beat a session once it has been idle at least this long. Must be < the
   *  provider's cache TTL (60 for the 1h ephemeral cache) or the beat is too
   *  late to matter. */
  idleMinutes: number;
  /** Cap on consecutive beats per idle stretch; resets when the user prompts
   *  the session again for real (not with the keepalive word itself). */
  maxBeats: number;
  /** Local time window "HH:MM-HH:MM" outside which no beats are sent. */
  activeHours: string;
  /** Skip sessions whose context is too small to be worth a beat. */
  minContextTokens: number;
  /** The exact word typed into the session; kept to one word so the
   *  UserPromptSubmit hook can recognise it and answer minimally. */
  prompt: string;
}

export interface SessionsConfig {
  cacheKeepalive: SessionsCacheKeepaliveConfig;
}

export interface PaiDaemonConfig {
  /** Unix Domain Socket path for IPC */
  socketPath: string;

  /** Index schedule interval in seconds (default: 300 = 5 minutes) */
  indexIntervalSecs: number;

  /** Embedding schedule interval in seconds (default: 600 = 10 minutes) */
  embedIntervalSecs: number;
  /** Run an embed pass 60s after daemon start. Off by default: with a large
   *  backlog it makes every restart a CPU storm, and it ignores the interval. */
  embedOnStartup: boolean;

  /** Local hour (0-23) to anchor the recurring index/embed cycle to. When unset,
   *  the cycle is anchored to daemon start, so a daytime restart pins every
   *  later pass to daytime too — a 24h interval does not by itself mean "at
   *  night". Set this to run maintenance in a fixed window regardless of when
   *  the machine last booted. */
  maintenanceHour?: number;

  /** Storage backend: "sqlite" (default) or "postgres" */
  storageBackend: "sqlite" | "postgres";

  /** PostgreSQL connection config (used when storageBackend = "postgres") */
  postgres?: PostgresConfig;

  /** Embedding model name (used for semantic/hybrid search) */
  embeddingModel: string;

  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Obsidian vault root path for zettelkasten indexing. If set, vault indexing runs alongside project indexing. */
  vaultPath?: string;

  /** Registry project_id to use for vault chunks in memory_chunks. Default: auto-detected. */
  vaultProjectId?: number;

  /** Notification subsystem configuration */
  notifications: NotificationConfig;

  /** Search defaults — applied when MCP tool or CLI doesn't specify a value */
  search: SearchConfig;

  /** Task bus — optional external tracker for cross-session work */
  tasks: TaskConfig;

  /** Who "me" is — addresses that count as the user's own. */
  identity: IdentityConfig;

  /** Interactive-session settings (currently just the cache keepalive). */
  sessions: SessionsConfig;
}

/**
 * The user's own identity, for anything that delivers back to them.
 *
 * This exists so "my own address" is a fact the system can check rather than
 * something a model infers from context. An assistant deciding on the spot
 * whether an address looks like the user's is exactly the judgement that should
 * not be re-made per message.
 *
 * Empty by default and never guessed at install time: an empty `selfEmails`
 * means nothing is self-addressed, so anything reading this fails closed.
 */
export interface IdentityConfig {
  /**
   * Where digests and "mail me X" requests are delivered.
   *
   * Must be a mailbox separate from the account doing the sending. Gmail files
   * a message sent from an account to itself — or to one of its own domain
   * aliases — under Sent only, and it never reaches the inbox. The send reports
   * success, so this fails silently and looks exactly like delivery. Observed
   * 2026-08-01: owner@example.ch → owner@example.de, sent fine, invisible.
   *
   * Where a separate mailbox is not available, deliver by writing the message
   * and adding the INBOX label to it rather than relying on the send path.
   */
  deliverTo?: string;

  /**
   * Every address that counts as the user's own.
   *
   * Used as an allowlist by anything that may act without review — outbound
   * mail being the case that motivated it. Membership is the whole test: an
   * address that is not listed is not the user's, however similar it looks.
   * Plus-aliases and domain aliases must be listed explicitly rather than
   * pattern-matched, because the patterns that would match them also match
   * addresses belonging to other people.
   */
  selfEmails: string[];

  /** The account used to send on the user's behalf, when one is configured. */
  sendingAccount?: string;
}

// ---------------------------------------------------------------------------
// Per-user Postgres isolation
// ---------------------------------------------------------------------------

/** Derive a per-user Postgres database name: pai_<username> */
function perUserDbName(): string {
  const username = userInfo().username;
  // Sanitize: only allow alphanumeric and underscore for Postgres identifiers
  const safe = username.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return `pai_${safe}`;
}

/** Derive the per-user connection string */
function perUserConnectionString(): string {
  const db = perUserDbName();
  return `postgresql://pai:pai@localhost:5432/${db}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * idleMinutes=50 sits under the 60-minute ephemeral-1h TTL with margin for
 * scheduler jitter; maxBeats=6 (~5h of coverage at one beat per idle stretch)
 * and activeHours 08:00-22:00 keep an unattended overnight machine from
 * beating all night for a session nobody will return to before the cache
 * would have expired anyway.
 */
export const DEFAULT_SESSIONS_CACHE_KEEPALIVE: SessionsCacheKeepaliveConfig = {
  enabled: false,
  idleMinutes: 50,
  maxBeats: 6,
  activeHours: "08:00-22:00",
  minContextTokens: 20_000,
  prompt: "keepalive",
};

export const DEFAULTS: PaiDaemonConfig = {
  socketPath: paiSocketPath(),
  indexIntervalSecs: 300,
  embedIntervalSecs: 600,
  embedOnStartup: false,
  storageBackend: "sqlite",
  postgres: {
    connectionString: perUserConnectionString(),
    maxConnections: 5,
    connectionTimeoutMs: 5000,
  },
  embeddingModel: "Snowflake/snowflake-arctic-embed-m-v1.5",
  logLevel: "info",
  notifications: DEFAULT_NOTIFICATION_CONFIG,
  tasks: DEFAULT_TASK_CONFIG,
  // Deliberately empty. An install must not guess who the user is: a wrong
  // guess here is an address that can be mailed without review.
  identity: { selfEmails: [] },
  sessions: { cacheKeepalive: { ...DEFAULT_SESSIONS_CACHE_KEEPALIVE } },
  search: {
    mode: "keyword",
    rerank: true,
    recencyBoostDays: 90,
    defaultLimit: 10,
    snippetLength: 200,
  },
};

/** Config template — generated at runtime so the DB name is per-user */
function configTemplate(): string {
  return `{
  "socketPath": "/tmp/pai.sock",
  "indexIntervalSecs": 300,
  "embedIntervalSecs": 600,
  "storageBackend": "sqlite",
  "postgres": {
    "connectionString": "${perUserConnectionString()}",
    "maxConnections": 5,
    "connectionTimeoutMs": 5000
  },
  "embeddingModel": "Snowflake/snowflake-arctic-embed-m-v1.5",
  "logLevel": "info",
  "vaultPath": "",
  "vaultProjectId": 0,
  "search": {
    "mode": "keyword",
    "rerank": true,
    "recencyBoostDays": 90,
    "defaultLimit": 10,
    "snippetLength": 200
  }
}
`;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand a leading ~ to the real home directory */
export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/** Canonical location since 2026-09-19: under the PAI_HOME namespace dir,
 *  so nothing PAI writes can collide with a file Claude Code itself owns. */
const NEW_CONFIG_FILE = paiHomePath("config.json");

/** Briefly the canonical location between 2026-09-19's two migrations —
 *  read during the transition, never written to again. */
const OLD_CONFIG_FILE = join(homedir(), ".claude", "pai.json");

/** Where the config lived before 2026-09-19 — read during the transition,
 *  never written to once NEW_CONFIG_FILE exists (see `pai config migrate`). */
const LEGACY_CONFIG_FILE = join(homedir(), ".config", "pai", "config.json");

/**
 * The path any read/write of the PAI config actually uses: PAI_CONFIG_FILE
 * (tests, power users) first, else the new PAI_HOME location if it exists,
 * else the most recent old location that is actually on disk (printing a
 * one-time notice), else the new location (the target a first write creates).
 */
export function paiConfigFilePath(): string {
  const override = process.env.PAI_CONFIG_FILE;
  if (override) return override;
  return resolvePaiFile(NEW_CONFIG_FILE, [OLD_CONFIG_FILE, LEGACY_CONFIG_FILE], "pai config migrate");
}

export const CONFIG_FILE = paiConfigFilePath();
export const CONFIG_DIR = dirname(CONFIG_FILE);

/** config.yaml — the canonical main config once `pai config yaml` has run,
 *  read/written by readMainConfigRaw/writeMainConfigRaw instead of
 *  CONFIG_FILE whenever it exists (see src/config/main-config.ts). */
export function paiConfigYamlFilePath(): string {
  return yamlSiblingPath(CONFIG_FILE);
}

/**
 * Read the raw main config object exactly as every non-typed writer
 * (identity, notifications, obsidian, setup, workers, memory settings) needs
 * it: config.yaml when it exists, else CONFIG_FILE. `path` overrides the
 * JSON location (tests, or workers/config.ts's parametrized CONFIG_FILE) —
 * its YAML sibling (same dir, `config.yaml`) is what gets preferred.
 */
export function readMainConfigRaw(path: string = CONFIG_FILE): Record<string, unknown> {
  try {
    return readDualFormatConfigRaw(path);
  } catch (e) {
    throw e instanceof MainConfigError ? new Error(e.message) : e;
  }
}

/**
 * Write the raw main config object back through the same seam: a
 * comment-preserving sync into config.yaml when it exists, else a plain
 * writeJsonAtomic to `path`. Every writer of the main config must call this
 * instead of touching CONFIG_FILE directly, so a config.yaml on disk is
 * honored no matter which of them made the change.
 */
export function writeMainConfigRaw(raw: Record<string, unknown>, path: string = CONFIG_FILE): void {
  try {
    writeDualFormatConfigRaw(path, raw);
  } catch (e) {
    throw e instanceof MainConfigError ? new Error(e.message) : e;
  }
}

export const ConfigMigrationError = PaiFileMigrationError;
export type ConfigMigrateResult = MigrateFileResult;

/**
 * `pai config migrate`: move config.json (from ~/.claude/pai.json or
 * ~/.config/pai/config.json, whichever is found) to ~/.claude/pai/config.json
 * byte-for-byte, verify the copy, then rename the old file aside as
 * config.json.migrated-<YYYYMMDD> (never deleted).
 */
export function migrateConfigFile(opts: { dryRun?: boolean } = {}): ConfigMigrateResult {
  return migratePaiFile(NEW_CONFIG_FILE, [OLD_CONFIG_FILE, LEGACY_CONFIG_FILE], opts);
}

// ---------------------------------------------------------------------------
// Deep merge (handles nested objects, not arrays)
// ---------------------------------------------------------------------------

function deepMerge<T extends object>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    const tgtVal = (target as Record<string, unknown>)[key];
    if (
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as object,
        srcVal as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load configuration: config.yaml (see paiConfigYamlFilePath) if it exists,
 * else CONFIG_FILE (see paiConfigFilePath), else defaults. Returns defaults
 * deep-merged with any values found in the file.
 */
export function loadConfig(): PaiDaemonConfig {
  if (!existsSync(CONFIG_FILE) && !existsSync(paiConfigYamlFilePath())) {
    return { ...DEFAULTS };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = readMainConfigRaw();
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Could not read config: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return { ...DEFAULTS };
  }

  // Compat: config.json may use "obsidianVaultPath" (legacy key) instead of "vaultPath".
  // Map it across so the daemon picks it up correctly.
  if (parsed.obsidianVaultPath && !parsed.vaultPath) {
    parsed.vaultPath = parsed.obsidianVaultPath;
    process.stderr.write(
      `[pai-daemon] Config: mapped obsidianVaultPath → vaultPath (${parsed.vaultPath})\n`
    );
  }

  return deepMerge(DEFAULTS, parsed);
}

/**
 * Ensure CONFIG_DIR exists and write a default config template to CONFIG_FILE
 * if none exists yet. Call this only from the `serve` command.
 */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    process.stderr.write(
      `[pai-daemon] Created config directory: ${CONFIG_DIR}\n`
    );
  }

  if (!existsSync(CONFIG_FILE) && !existsSync(paiConfigYamlFilePath())) {
    try {
      writeFileSync(CONFIG_FILE, configTemplate(), "utf-8");
      process.stderr.write(
        `[pai-daemon] Wrote default config to: ${CONFIG_FILE}\n`
      );
    } catch (e) {
      process.stderr.write(
        `[pai-daemon] Could not write default config: ${e}\n`
      );
    }
  }
}
