/**
 * main-config-ops.ts — the `pai config list/get/set/unset` operations shared
 * by the CLI (src/cli/commands/config.ts) and the MCP tools
 * (src/daemon-mcp/tools/config.ts). One implementation, two thin callers, so
 * a change to masking or validation cannot drift between them.
 */

import { existsSync } from "node:fs";
import { Document } from "yaml";
import {
  defaults as loadConfigDefaults,
  loadConfig,
  paiConfigFilePath,
  paiConfigYamlFilePath,
  readMainConfigRaw,
  writeMainConfigRaw,
} from "../daemon/config.js";
import { readWorkersSection, defaultWorkersConfig, maskKey } from "../workers/config.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { userWorkersYamlRaw } from "./shipped-defaults.js";
import { MAIN_CONFIG_SECTION_COMMENTS, migrateMainConfigToYaml } from "./main-config.js";
import { writeYamlFileAtomic } from "./yaml-store.js";

export class MainConfigOpsError extends Error {}

// ---------------------------------------------------------------------------
// Dotted-path helpers
// ---------------------------------------------------------------------------

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Refuse segments that would walk into Object.prototype when a path is applied to an object. */
function assertSafeSegments(segments: string[]): void {
  const bad = segments.find((s) => UNSAFE_SEGMENTS.has(s));
  if (bad !== undefined) throw new MainConfigOpsError(`path segment "${bad}" is not allowed`);
}

export function splitConfigPath(dotted: string): string[] {
  const segments = dotted.split(".").filter((s) => s.length > 0);
  if (!segments.length) throw new MainConfigOpsError("path is required");
  assertSafeSegments(segments);
  return segments;
}

function getAtPath(root: unknown, segments: string[]): { value: unknown; found: boolean } {
  assertSafeSegments(segments);
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
  assertSafeSegments(segments);
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
  assertSafeSegments(segments);
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
// Schema (the shipped defaults file + the non-provider `workers` shape) for
// type validation and the effective (defaults-merged) view
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
    defaultMaxMinutes: workers.defaultMaxMinutes,
    noBrowserByDefault: workers.noBrowserByDefault,
    gcOlderThanHours: workers.gcOlderThanHours,
    worktreesMaxGb: workers.worktreesMaxGb,
    reaper: workers.reaper,
    ...(workers.fallback ? { fallback: workers.fallback } : {}),
  };
}

function schemaRoot(): Record<string, unknown> {
  return {
    // the shipped file plus the load-time computed values (per-user Postgres
    // connection string, socket path) — the same shape loadConfig() starts from
    ...(loadConfigDefaults() as unknown as Record<string, unknown>),
    workers: workersMainConfigShape(),
  };
}

/** loadConfig() (typed, shipped defaults merged under the user file) plus the
 *  workers subset — the "effective" view `pai config list --all` / `get`
 *  resolve against. */
function effectiveConfigRoot(): Record<string, unknown> {
  return {
    ...(loadConfig() as unknown as Record<string, unknown>),
    workers: workersMainConfigShape(),
  };
}

/**
 * Refuse an unset top-level key (typo protection) unless --force, and — when
 * the shipped defaults file names a scalar at this exact path — refuse a
 * value of a different JS type unless --force. Nested unknown keys (e.g.
 * under `tasks.providers`) are always allowed: the defaults file does not
 * enumerate every provider shape.
 */
function validateAgainstSchema(segments: string[], value: unknown, opts: { force?: boolean }): void {
  const schema = schemaRoot();
  const topKey = segments[0];
  // Known keys: the shipped defaults plus every documented key (optional
  // fields such as maintenanceHour have no default but are real).
  const known = new Set([...Object.keys(schema), ...Object.keys(MAIN_CONFIG_SECTION_COMMENTS)]);
  if (!known.has(topKey) && !opts.force) {
    throw new MainConfigOpsError(
      `unknown top-level config key "${topKey}" (known: ${[...known].sort().join(", ")}) — pass --force to set it anyway`
    );
  }
  if (segments.length === 1 && topKey === "maintenanceHour" && !opts.force) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 23) {
      throw new MainConfigOpsError(`maintenanceHour: expected an integer hour 0-23 (pass --force to override)`);
    }
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
  /** Where the value came from: the user's file or the shipped defaults file. */
  source?: "user" | "defaults";
}

/** `pai config get <path>` / `config_get`: resolves against the
 *  defaults-merged effective config (a value not set in the file still
 *  answers with its default), masked if the path looks like a secret. */
export function getConfigValueOp(dottedPath: string): GetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const root = effectiveConfigRoot();
  const { value, found } = getAtPath(root, segments);
  let source: "user" | "defaults" | undefined;
  if (found) {
    // The user's raw main config (config.yaml/config.json) plus the workers
    // section as the user actually wrote it (workers.yaml or the JSON
    // `workers` key — NOT the defaults-merged parse); anything not present
    // there comes from the shipped defaults file.
    // Explicit CONFIG_FILE argument: the default parameter binds at module
    // load, and tests re-point PAI_CONFIG_FILE afterwards (see
    // paiConfigFilePath).
    const rawMain = readMainConfigRaw(paiConfigFilePath());
    const userWorkersRaw = rawMain.workers ?? userWorkersYamlRaw(workersYamlPath());
    const userRoot: Record<string, unknown> = {
      ...rawMain,
      ...(userWorkersRaw !== undefined && userWorkersRaw !== null ? { workers: userWorkersRaw } : {}),
    };
    source = getAtPath(userRoot, segments).found ? "user" : "defaults";
  }
  return { found, value: found ? maskSecretsDeep(value, segments) : undefined, source };
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
 * its type against the shipped defaults (refusable with `force`; `asString` stores `value` verbatim, no parsing), converts
 * config.json
 * to config.yaml first if neither exists yet, then writes through
 * writeMainConfigRaw (comment-preserving when config.yaml exists).
 */
export function setConfigValueOp(dottedPath: string, rawValue: string, opts: { force?: boolean; asString?: boolean } = {}): SetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const value = opts.asString ? rawValue : parseConfigValueString(rawValue);
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

/** Which file a `pai config get` value came from, for `--source`. */
export function formatConfigSource(source: "user" | "defaults" | undefined): string {
  if (source === "user") return "user config";
  if (source === "defaults") return "shipped defaults";
  return "unknown";
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
