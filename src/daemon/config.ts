/**
 * config.ts — Configuration loader for PAI Daemon
 *
 * Loads config from ~/.pai/config.json (the pre-2026-09-19 location
 * was ~/.config/pai/config.json, briefly ~/.pai.json in between —
 * see paiConfigFilePath/migrateConfigFile).
 * Deep-merges with defaults so partial configs work fine.
 * Expands ~ in path values at runtime.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { loginUsername } from "../utils/login-username.js";
import { join, dirname, basename } from "node:path";
import type { NotificationConfig } from "../notifications/types.js";
import type { TaskConfig } from "../tasks/types.js";
import { paiSocketPath } from "../runtime-paths.js";
import { postgresConnectionString } from "../storage/postgres/config.js";
import { effectiveMainConfig, shippedMainDefaults } from "../config/shipped-defaults.js";
import {
  paiHomePath,
  claudeHomeDir,
  legacyConfigDir,
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

export interface EmbeddingConfig {
  /** Backend id: "transformers-cpu-q8" (default, in-process) or "ollama-f16". */
  backend: string;
  /** Model name for the backend. Ollama: the model name on the server
   *  (default "arctic-embed-m-v1.5-f16"). Unset for transformers-cpu-q8,
   *  which uses embeddingModel. */
  model?: string;
  ollama: { baseUrl: string };
}

export interface ObsidianConfig {
  /** Gates only the writing side (sync, master notes, symlinks). Default: false. */
  enabled: boolean;
}

export interface VaultIndexConfig {
  /** Read-only indexing of `vaultPath` for memory search. Independent of `obsidian.enabled`. Default: true. */
  enabled: boolean;
}

export interface RouterConfig {
  /** Keep `pai router` (127.0.0.1:8790) running under the daemon. Default: false. */
  enabled: boolean;
  /** TCP port of the router. Default: 8790. */
  port: number;
  /** Upstream for claude-* model ids. Default: https://api.anthropic.com. */
  claudeUpstream: string;
  /** Milliseconds a stopping router waits for in-flight requests before force-closing. Default: 120000. */
  drainMs: number;
  /** After a handover the old router stops accepting and finishes its in-flight requests; `drainMaxSecs` bounds that (then they end with a retryable error). Default: 1800. */
  handover?: { drainMaxSecs?: number };
  /** Bare model aliases (besides ids starting with `claude-`) that route to claudeUpstream. */
  claudeModelAliases: string[];
  /**
   * Listen scope: "loopback" (default — 127.0.0.1 only, as always), or beyond
   * it: "tailscale" (the utun address inside 100.64.0.0/10) or an explicit
   * IPv4 — never 0.0.0.0. A wider bind adds a second listener on that address
   * for the cockpit, which then needs the token from
   * ~/.pai/router-cockpit.token (printed once as a full URL at
   * startup); /v1 keeps answering only loopback and tailnet remotes.
   */
  bind: string;
  /**
   * Extra Host headers the router accepts beyond loopback and the bind
   * address — the tailnet names (MagicDNS) the cockpit is opened by. Default:
   * empty. Requests whose Host matches none of these are refused (403) before
   * any handler runs; see hostAllowed in src/router/cockpit-auth.ts.
   */
  allowedHosts?: string[];
  /**
   * Request scheduling for local engines (src/router/scheduler.ts): one request in
   * flight per engine, fair across the workers' owning sessions. Defaults:
   * enabled true, wTokIn 1, wTokOut 2, agingSec 120, sessionWeights {},
   * warmMs 300000, pingMs 15000, lowAgingSec 900.
   */
  scheduling?: { enabled?: boolean; wTokIn?: number; wTokOut?: number; agingSec?: number; sessionWeights?: Record<string, number>; warmMs?: number; pingMs?: number; lowAgingSec?: number };
  /**
   * Park an idle local conversation to disk while its worker waits on a long build gate
   * (src/router/parking.ts). Needs the engine started with `--slot-save-path <PAI home>/state/strata-slots`.
   * Defaults: enabled false, parkAfterSec 120.
   */
  parking?: { enabled?: boolean; parkAfterSec?: number };
  /**
   * Cockpit Models cards: the live sampler of running runtimes
   * (src/router/runtime-samples.ts). Defaults: sampleMs 5000, historyLen 60,
   * engineStatusTimeoutMs 1000, cardReadingMaxAgeMs 2000.
   */
  samples?: { sampleMs?: number; historyLen?: number; engineStatusTimeoutMs?: number; cardReadingMaxAgeMs?: number };
  /**
   * Cockpit page: `sections` lists the section ids to render, in page order (cloud, routing, workers, pool, models,
   * system, memory, kpis, tokens, cache, speed, pause, sessions, runs, daily). Missing or empty = all. Re-read per page load.
   */
  cockpit?: { sections?: string[] };
}

export interface PaiDaemonConfig {
  /** Unix Domain Socket path for IPC */
  socketPath: string;

  /** Index schedule interval in seconds (default: 300 = 5 minutes) */
  indexIntervalSecs: number;

  /** Embedding schedule interval in seconds (default: 600 = 10 minutes) */
  embedIntervalSecs: number;
  /** Obsidian vault sync interval in seconds (default: 1800 = 30 minutes); syncs only if a hook flagged a change. */
  obsidianSyncIntervalSecs: number;
  /** Run an embed pass 60s after daemon start. Off by default: with a large
   *  backlog it makes every restart a CPU storm, and it ignores the interval. */
  embedOnStartup: boolean;
  /** Wall-clock budget of one embed pass in minutes (default 60); the rest waits for the next cycle. */
  embedMaxMinutes?: number;
  /** Total minutes the embed phase of one anchored cycle may keep running passes (default 300). */
  embedCycleMaxMinutes?: number;
  /** Minutes to wait before resuming after a pass yielded to load or a local worker (default 10). */
  embedResumeMinutes?: number;
  /** Load average (1 min) above which an embed pass yields (default 8). */
  embedMaxLoad?: number;

  /** Local hour (0-23) to anchor the recurring index/embed cycle to. When unset,
   *  the cycle is anchored to daemon start, so a daytime restart pins every
   *  later pass to daytime too — a 24h interval does not by itself mean "at
   *  night". Set this to run maintenance in a fixed window regardless of when
   *  the machine last booted. */
  maintenanceHour?: number;

  /** Priority of the scheduled index/embed passes. "background" (default) runs
   *  them in a child under `taskpolicy -b nice -n 19` (macOS) or
   *  `nice -n 19 ionice -c3` (Linux); the daemon itself, which serves MCP,
   *  keeps normal priority. "normal" runs them in-process. */
  passPriority: "background" | "normal";

  /** Storage backend: "sqlite" (default) or "postgres" */
  storageBackend: "sqlite" | "postgres";

  /** PostgreSQL connection config (used when storageBackend = "postgres") */
  postgres?: PostgresConfig;

  /** Embedding model name (used for semantic/hybrid search) */
  embeddingModel: string;

  /** Embedding backend selection (see src/memory/backends/). */
  embedding: EmbeddingConfig;

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


  /** Obsidian sync switch (off by default). */
  obsidian: ObsidianConfig;

  /** Vault index switch (on by default). */
  vaultIndex: VaultIndexConfig;

  /** Model router supervised by the daemon (src/router/supervisor.ts). */
  router: RouterConfig;

  /** Worker settings; `merge` drives conflict auto-resolution in `pai worker merge`. */
  workers?: {
    merge?: {
      /** Globs of generated paths: a conflict only in these is resolved by regenerating. */
      generated?: string[];
      /** Shell command that regenerates them. */
      regenerate?: string;
      /** Globs of files where two add-only clashes are union-merged (shipped defaults: docs, markdown, CHANGELOG, CLI registry). */
      union?: string[];
      /** Related-tests command run after a merge; `{files}` = changed source files. Empty = off. */
      verify?: string;
      /** Seconds before the related-tests command is stopped. */
      verifyTimeoutSec?: number;
      /** Test paths/globs appended to every related-tests run (repo guards `vitest related` never selects). */
      alwaysTests?: string[];
    };
  };
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
  const username = loginUsername();
  // Sanitize: only allow alphanumeric and underscore for Postgres identifiers
  const safe = username.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  return `pai_${safe}`;
}

/** Derive the per-user connection string */
function perUserConnectionString(): string {
  return postgresConnectionString({ database: perUserDbName() });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The main-config defaults live in the shipped defaults file
 * (src/config/defaults/config.yaml, copied into dist by the build) and are
 * deep-merged UNDER the user's config.yaml/config.json — see
 * src/config/shipped-defaults.ts. Only values COMPUTED at load time stay in
 * code: the socket path (PAI_SOCKET_PATH) and the per-user Postgres
 * connection string.
 */
function computedDefaults(): Record<string, unknown> {
  return {
    socketPath: paiSocketPath(),
    postgres: { connectionString: perUserConnectionString() },
  };
}

/** The effective defaults: the shipped file plus the load-time computed
 *  values, as the typed shape. */
export function defaults(): PaiDaemonConfig {
  return deepMerge(
    deepMerge(shippedMainDefaults(), computedDefaults()) as unknown as PaiDaemonConfig,
    {}
  );
}

/** Config template — generated at runtime so the DB name is per-user */
function configTemplate(): string {
  return `{
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

/** Inverse of expandHome: a path under the home directory is written as `~/…` so config never hardcodes the user's home. */
export function homeRel(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** Canonical location since 2026-09-19: under the PAI_HOME namespace dir,
 *  so nothing PAI writes can collide with a file Claude Code itself owns. */
const NEW_CONFIG_FILE = paiHomePath("config.json");

/** Briefly the canonical location between 2026-09-19's two migrations —
 *  read during the transition, never written to again. */
const oldConfigFile = (): string => join(claudeHomeDir(), "pai.json");

/** Where the config lived before 2026-09-19 — read during the transition,
 *  never written to once NEW_CONFIG_FILE exists (see `pai config migrate`). */
const legacyConfigFile = (): string => join(legacyConfigDir(), "config.json");

/**
 * The path any read/write of the PAI config actually uses: PAI_CONFIG_FILE
 * (tests, power users) first, else the new PAI_HOME location if it exists,
 * else the most recent old location that is actually on disk (printing a
 * one-time notice), else the new location (the target a first write creates).
 */
export function paiConfigFilePath(): string {
  const override = process.env.PAI_CONFIG_FILE;
  if (override) return override;
  return resolvePaiFile(NEW_CONFIG_FILE, [oldConfigFile(), legacyConfigFile()], "pai config migrate");
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
 * `pai config migrate`: move config.json (from ~/.pai.json or
 * ~/.config/pai/config.json, whichever is found) to ~/.pai/config.json
 * byte-for-byte, verify the copy, then rename the old file aside as
 * config.json.migrated-<YYYYMMDD> (never deleted).
 */
export function migrateConfigFile(opts: { dryRun?: boolean } = {}): ConfigMigrateResult {
  const result = migratePaiFile(NEW_CONFIG_FILE, [oldConfigFile(), legacyConfigFile()], opts);
  if (!result.dryRun && result.fromPath) {
    // config.json can hold secrets (e.g. the Postgres password) — lock down
    // both the new location and the `.migrated-<stamp>` copy left behind.
    if (existsSync(result.toPath)) chmodSync(result.toPath, 0o600);
    const oldDir = dirname(result.fromPath);
    const oldName = basename(result.fromPath);
    for (const entry of readdirSync(oldDir)) {
      if (entry.startsWith(`${oldName}.migrated-`)) chmodSync(join(oldDir, entry), 0o600);
    }
  }
  return result;
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
 * Load configuration: the shipped defaults file (defaults/config.yaml) with
 * the load-time computed values over it, then the user's config.yaml (see
 * paiConfigYamlFilePath) or CONFIG_FILE deep-merged over that — user values
 * win, arrays replace, objects merge. Missing user file → the defaults alone.
 */
export function loadConfig(): PaiDaemonConfig {
  let merged: Record<string, unknown>;
  try {
    // paiConfigFilePath() at call time, not the module-load CONFIG_FILE:
    // tests re-point PAI_CONFIG_FILE after import (see paiConfigFilePath).
    merged = effectiveMainConfig(paiConfigFilePath());
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Could not read config: ${e instanceof Error ? e.message : String(e)}\n`
    );
    // The user's file is damaged: fall back to the shipped defaults alone
    // (plus the computed values), same as the old defaults-only behaviour.
    merged = deepMerge(shippedMainDefaults(), computedDefaults());
  }
  // the computed values are defaults too: the user's file wins
  merged = deepMerge(computedDefaults(), merged);

  // Compat: config.json may use "obsidianVaultPath" (legacy key) instead of "vaultPath".
  // Map it across so the daemon picks it up correctly.
  if (merged.obsidianVaultPath && !merged.vaultPath) {
    merged.vaultPath = merged.obsidianVaultPath;
    process.stderr.write(
      `[pai-daemon] Config: mapped obsidianVaultPath → vaultPath (${merged.vaultPath})\n`
    );
  }

  return merged as unknown as PaiDaemonConfig;
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
