/**
 * foreign-config-guard.ts — a config that is not the canonical one must not
 * run destructive operations against the canonical config's database.
 *
 * 2026-10-24 01:48 UTC bench/eval runs set PAI_CONFIG_FILE to a per-run copy of
 * the live config; the copy named the live Postgres database, so tasks and
 * hidden tests in a throwaway clone wiped and rebuilt the live `projects`
 * table. "Foreign config on the live database" is detected here, once, for
 * every backend: createPgPool notes it (one loud line per process), and each
 * destructive operation calls assertDestructiveAllowed. Override:
 * PAI_ALLOW_FOREIGN_LIVE_DB=1.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { paiHomeDir } from "../config/pai-home.js";
import { readDualFormatConfigRaw } from "../config/main-config.js";
import { postgresConnectionString, type PostgresConfig } from "./postgres/config.js";

export interface ForeignLiveDb {
  /** The foreign config file. */
  path: string;
  /** host:port/dbname both configs name. */
  database: string;
}

/** The canonical config: <PAI home>/config.yaml, else config.json. */
export function canonicalConfigPath(): string {
  const yaml = join(paiHomeDir(), "config.yaml");
  return existsSync(yaml) ? yaml : join(paiHomeDir(), "config.json");
}

function sameFile(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** host:port/dbname of the postgres section of a config file, or null if it has none or is unreadable. */
export function configDatabase(file: string): string | null {
  try {
    const pg = readDualFormatConfigRaw(file).postgres;
    if (!pg || typeof pg !== "object") return null;
    const url = new URL(postgresConnectionString(pg as PostgresConfig));
    const host = LOCAL_HOSTS.has(url.hostname) ? "localhost" : url.hostname;
    return `${host}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
  } catch {
    return null;
  }
}

/**
 * The foreign config on the live database, or null: `configFile` (default
 * PAI_CONFIG_FILE) is set, differs from the canonical config, and names the
 * same postgres host+port+database. Null too when PAI_ALLOW_FOREIGN_LIVE_DB=1.
 */
export function detectForeignLiveDb(
  opts: { configFile?: string; canonicalFile?: string; env?: NodeJS.ProcessEnv } = {},
): ForeignLiveDb | null {
  const env = opts.env ?? process.env;
  if (env.PAI_ALLOW_FOREIGN_LIVE_DB === "1") return null;
  const file = opts.configFile ?? env.PAI_CONFIG_FILE;
  if (!file) return null;
  const canonical = opts.canonicalFile ?? canonicalConfigPath();
  if (sameFile(file, canonical)) return null;
  const db = configDatabase(file);
  if (!db || db !== configDatabase(canonical)) return null;
  return { path: file, database: db };
}

/** Throws when a foreign config on the live database tries a destructive `op`. */
export function assertDestructiveAllowed(op: string, opts: Parameters<typeof detectForeignLiveDb>[0] = {}): void {
  const f = detectForeignLiveDb(opts);
  if (!f) return;
  throw new Error(
    `this run uses a foreign config (${f.path}) on the live database ${f.database}; refusing ${op}. ` +
      "Point the config at its own database (e.g. pai_eval).",
  );
}

let noted = false;

/** Reset for tests. */
export function resetForeignConfigNote(): void {
  noted = false;
}

/** One FOREIGN-CONFIG-LIVE-DB line per process (stderr, and logs/foreign-config.log) when the guard applies. */
export function noteForeignConfigLiveDb(opts: Parameters<typeof detectForeignLiveDb>[0] = {}): string | null {
  if (noted) return null;
  const f = detectForeignLiveDb(opts);
  if (!f) return null;
  noted = true;
  const line = `FOREIGN-CONFIG-LIVE-DB path=${f.path} db=${f.database} pid=${process.pid} cmd=${process.argv.join(" ")}`;
  process.stderr.write(`[pai-registry] ${line}\n`);
  try {
    mkdirSync(join(paiHomeDir(), "logs"), { recursive: true });
    appendFileSync(join(paiHomeDir(), "logs", "foreign-config.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the stderr line stands
  }
  return line;
}

/** Config files under `root` (default ~/.cache/pai, depth 5) that name the live database: what `pai build doctor` reports. */
export function foreignConfigsOnLiveDb(root: string = join(homedir(), ".cache", "pai")): ForeignLiveDb[] {
  const found: ForeignLiveDb[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 5 && e.name !== "node_modules" && e.name !== ".git") walk(p, depth + 1);
      } else if (e.isFile() && /\.(ya?ml|json)$/i.test(e.name)) {
        try {
          if (statSync(p).size > 1_000_000) continue;
        } catch {
          continue;
        }
        const f = detectForeignLiveDb({ configFile: p });
        if (f) found.push(f);
      }
    }
  };
  walk(root, 0);
  return found;
}
