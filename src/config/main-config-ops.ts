/**
 * main-config-ops.ts — the `pai config list/get/set/unset` operations shared
 * by the CLI (src/cli/commands/config.ts) and the MCP tools
 * (src/daemon-mcp/tools/config.ts). One implementation, two thin callers, so
 * a change to masking or validation cannot drift between them.
 */

import { existsSync } from "node:fs";
import { Document } from "yaml";
import {
  DEFAULTS,
  loadConfig,
  paiConfigFilePath,
  paiConfigYamlFilePath,
  readMainConfigRaw,
  writeMainConfigRaw,
} from "../daemon/config.js";
import {
  readWorkersSection,
  DEFAULT_PANE,
  DEFAULT_LOG_DIR,
  DEFAULT_ROUTING,
  DEFAULT_TREE,
  DEFAULT_CACHE_KEEPALIVE_SECS,
  maskKey,
} from "../workers/config.js";
import { migrateMainConfigToYaml } from "./main-config.js";
import { writeYamlFileAtomic } from "./yaml-store.js";

export class MainConfigOpsError extends Error {}

// ---------------------------------------------------------------------------
// Dotted-path helpers
// ---------------------------------------------------------------------------

export function splitConfigPath(dotted: string): string[] {
  const segments = dotted.split(".").filter((s) => s.length > 0);
  if (!segments.length) throw new MainConfigOpsError("path is required");
  return segments;
}

function getAtPath(root: unknown, segments: string[]): { value: unknown; found: boolean } {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { value: undefined, found: false };
    }
  }
  return { value: cur, found: true };
}

function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  const clone = structuredClone(root);
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = value;
  return clone;
}

function deleteAtPath(root: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  const clone = structuredClone(root);
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return clone;
    cur = next as Record<string, unknown>;
  }
  delete cur[segments[segments.length - 1]];
  return clone;
}

// ---------------------------------------------------------------------------
// Value parsing (`pai config set <path> <value>`)
// ---------------------------------------------------------------------------

/** true/false, null, numbers, `[...]`/`{...}` as JSON, else the raw string. */
export function parseConfigValueString(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new MainConfigOpsError(`invalid JSON value: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

const SECRET_SEGMENT_RE = /key|token|secret|password/i;

/** Paths not caught by SECRET_SEGMENT_RE but whose value routinely embeds a
 *  credential (a Postgres URL's userinfo component). */
const SPECIAL_SECRET_PATHS = new Set(["postgres.connectionString"]);

function isSecretPath(segments: (string | number)[]): boolean {
  if (SPECIAL_SECRET_PATHS.has(segments.filter((s) => typeof s === "string").join("."))) return true;
  return segments.some((s) => typeof s === "string" && SECRET_SEGMENT_RE.test(s));
}

/** Deep-clone `value`, replacing every string leaf on a secret path with
 *  `maskKey`'s `****<last4>` form. Used by every reader (list/get, MCP). */
export function maskSecretsDeep(value: unknown, path: (string | number)[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => maskSecretsDeep(v, [...path, i]));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskSecretsDeep(v, [...path, k]);
    }
    return out;
  }
  if (typeof value === "string" && value && isSecretPath(path)) return maskKey(value);
  return value;
}

// ---------------------------------------------------------------------------
// Schema (DEFAULTS + the non-provider `workers` shape) for type validation
// and the effective (defaults-merged) view
// ---------------------------------------------------------------------------

/** The non-provider `workers` sub-object every writer persists to the main
 *  config (providers/classes/mcp_sets/active live in workers.yaml instead —
 *  see readWorkersSection). Shared by schemaRoot and effectiveConfigRoot. */
function workersMainConfigShape(): Record<string, unknown> {
  const { workers } = readWorkersSection();
  return {
    enabled: workers.enabled,
    pane: workers.pane,
    logDir: workers.logDir,
    routing: workers.routing,
    tree: workers.tree,
    cacheKeepaliveSecs: workers.cacheKeepaliveSecs,
    ...(workers.fallback ? { fallback: workers.fallback } : {}),
  };
}

function schemaRoot(): Record<string, unknown> {
  return {
    ...(DEFAULTS as unknown as Record<string, unknown>),
    workers: {
      enabled: false,
      pane: DEFAULT_PANE,
      logDir: DEFAULT_LOG_DIR,
      routing: DEFAULT_ROUTING,
      tree: DEFAULT_TREE,
      cacheKeepaliveSecs: DEFAULT_CACHE_KEEPALIVE_SECS,
    },
  };
}

/** loadConfig() (typed, defaults-merged) plus the workers subset — the
 *  "effective" view `pai config list --all` / `get` resolve against. */
function effectiveConfigRoot(): Record<string, unknown> {
  return {
    ...(loadConfig() as unknown as Record<string, unknown>),
    workers: workersMainConfigShape(),
  };
}

/**
 * Refuse an unset top-level key (typo protection) unless --force, and — when
 * DEFAULTS names a scalar at this exact path — refuse a value of a different
 * JS type unless --force. Nested unknown keys (e.g. under `tasks.providers`)
 * are always allowed: DEFAULTS does not enumerate every provider shape.
 */
function validateAgainstSchema(segments: string[], value: unknown, opts: { force?: boolean }): void {
  const schema = schemaRoot();
  const topKey = segments[0];
  if (!(topKey in schema) && !opts.force) {
    throw new MainConfigOpsError(
      `unknown top-level config key "${topKey}" (known: ${Object.keys(schema).sort().join(", ")}) — pass --force to set it anyway`
    );
  }
  const { value: expected, found } = getAtPath(schema, segments);
  if (found && expected !== null && expected !== undefined) {
    const expectedType = Array.isArray(expected) ? "array" : typeof expected;
    const actualType = Array.isArray(value) ? "array" : typeof value;
    if (expectedType !== actualType && !opts.force) {
      throw new MainConfigOpsError(
        `${segments.join(".")}: expected ${expectedType}, got ${actualType} (pass --force to override)`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public ops
// ---------------------------------------------------------------------------

export interface ListConfigResult {
  /** The section this reflects: file-set values only, or defaults-merged. */
  scope: "file" | "effective";
  yaml: string;
  data: Record<string, unknown>;
}

/** `pai config list` / `config_list`. `all=true` shows the defaults-merged
 *  effective config; otherwise only what the file explicitly sets. Secrets
 *  are always masked. */
export function listConfigOp(opts: { all?: boolean } = {}): ListConfigResult {
  const root = opts.all ? effectiveConfigRoot() : readMainConfigRaw();
  const masked = maskSecretsDeep(root) as Record<string, unknown>;
  return { scope: opts.all ? "effective" : "file", yaml: String(new Document(masked)), data: masked };
}

export interface GetConfigResult {
  found: boolean;
  value: unknown;
}

/** `pai config get <path>` / `config_get`: resolves against the
 *  defaults-merged effective config (a value not set in the file still
 *  answers with its default), masked if the path looks like a secret. */
export function getConfigValueOp(dottedPath: string): GetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const { value, found } = getAtPath(effectiveConfigRoot(), segments);
  return { found, value: found ? maskSecretsDeep(value, segments) : undefined };
}

/** `pai config get`'s CLI text: a scalar prints as-is, an object/array
 *  subtree prints as YAML (matching `config list`) unless `json` is passed —
 *  the MCP `config_get` tool returns the structured value directly and never
 *  goes through this. */
export function formatConfigGetOutput(value: unknown, opts: { json?: boolean } = {}): string {
  if (opts.json) return JSON.stringify(value, null, 2);
  if (value !== null && typeof value === "object") return String(new Document(value)).trimEnd();
  return String(value);
}

export interface SetConfigResult {
  yamlCreated: boolean;
  yamlPath: string;
  value: unknown;
}

/**
 * `pai config set <path> <value>` / `config_set`: parses `value`, validates
 * its type against DEFAULTS (refusable with `force`), converts config.json
 * to config.yaml first if neither exists yet, then writes through
 * writeMainConfigRaw (comment-preserving when config.yaml exists).
 */
export function setConfigValueOp(dottedPath: string, rawValue: string, opts: { force?: boolean } = {}): SetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const value = parseConfigValueString(rawValue);
  validateAgainstSchema(segments, value, opts);

  const jsonPath = paiConfigFilePath();
  const yamlPath = paiConfigYamlFilePath();
  let yamlCreated = false;
  if (!existsSync(yamlPath)) {
    if (existsSync(jsonPath)) {
      migrateMainConfigToYaml(jsonPath, {});
    } else {
      writeYamlFileAtomic(yamlPath, "{}\n", { label: yamlPath });
    }
    yamlCreated = true;
  }

  const raw = readMainConfigRaw();
  writeMainConfigRaw(setAtPath(raw, segments, value));
  return { yamlCreated, yamlPath, value };
}

export interface UnsetConfigResult {
  existed: boolean;
}

/** `pai config unset <path>` / `config_unset`: no-ops (existed=false) when
 *  the path was never set explicitly — defaults are never "unset". */
export function unsetConfigValueOp(dottedPath: string): UnsetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const raw = readMainConfigRaw();
  const { found } = getAtPath(raw, segments);
  if (!found) return { existed: false };
  writeMainConfigRaw(deleteAtPath(raw, segments));
  return { existed: true };
}
