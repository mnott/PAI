/**
 * config.ts — Configuration loader for PAI Daemon
 *
 * Loads config from ~/.config/pai/config.json (XDG convention).
 * Deep-merges with defaults so partial configs work fine.
 * Expands ~ in path values at runtime.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NotificationConfig } from "../notifications/types.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "../notifications/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface PaiDaemonConfig {
  /** Unix Domain Socket path for IPC */
  socketPath: string;

  /** Index schedule interval in seconds (default: 300 = 5 minutes) */
  indexIntervalSecs: number;

  /** Embedding schedule interval in seconds (default: 600 = 10 minutes) */
  embedIntervalSecs: number;

  /** Storage backend: "sqlite" (default) or "postgres" */
  storageBackend: "sqlite" | "postgres";

  /** PostgreSQL connection config (used when storageBackend = "postgres") */
  postgres?: PostgresConfig;

  /** Embedding model name (used for semantic/hybrid search) */
  embeddingModel: string;

  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";

  /** Notification subsystem configuration */
  notifications: NotificationConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS: PaiDaemonConfig = {
  socketPath: "/tmp/pai.sock",
  indexIntervalSecs: 300,
  embedIntervalSecs: 600,
  storageBackend: "sqlite",
  postgres: {
    connectionString: "postgresql://pai:pai@localhost:5432/pai",
    maxConnections: 5,
    connectionTimeoutMs: 5000,
  },
  embeddingModel: "Snowflake/snowflake-arctic-embed-m-v1.5",
  logLevel: "info",
  notifications: DEFAULT_NOTIFICATION_CONFIG,
};

const CONFIG_TEMPLATE = `{
  "socketPath": "/tmp/pai.sock",
  "indexIntervalSecs": 300,
  "embedIntervalSecs": 600,
  "storageBackend": "sqlite",
  "postgres": {
    "connectionString": "postgresql://pai:pai@localhost:5432/pai",
    "maxConnections": 5,
    "connectionTimeoutMs": 5000
  },
  "embeddingModel": "Snowflake/snowflake-arctic-embed-m-v1.5",
  "logLevel": "info"
}
`;

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

export const CONFIG_DIR = join(homedir(), ".config", "pai");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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
 * Load configuration from ~/.config/pai/config.json.
 * Returns defaults merged with any values found in the file.
 */
export function loadConfig(): PaiDaemonConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Could not read config file at ${CONFIG_FILE}: ${e}\n`
    );
    return { ...DEFAULTS };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    process.stderr.write(
      `[pai-daemon] Config file is not valid JSON: ${e}\n`
    );
    return { ...DEFAULTS };
  }

  return deepMerge(DEFAULTS, parsed);
}

/**
 * Ensure ~/.config/pai/ exists and write a default config.json template
 * if none exists yet. Call this only from the `serve` command.
 */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    process.stderr.write(
      `[pai-daemon] Created config directory: ${CONFIG_DIR}\n`
    );
  }

  if (!existsSync(CONFIG_FILE)) {
    try {
      writeFileSync(CONFIG_FILE, CONFIG_TEMPLATE, "utf-8");
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
