/**
 * main-config-ops.ts — the `pai config list/get/set/unset` operations shared
 * by the CLI (src/cli/commands/config.ts) and the MCP tools
 * (src/daemon-mcp/tools/config.ts). One implementation, two thin callers, so
 * a change to masking or validation cannot drift between them.
 */

import { existsSync, readFileSync } from "node:fs";
import { Document, isMap, isSeq, parseDocument, Scalar, type Node } from "yaml";
import {
  defaults as loadConfigDefaults,
  loadConfig,
  paiConfigFilePath,
  paiConfigYamlFilePath,
  readMainConfigRaw,
  writeMainConfigRaw,
} from "../daemon/config.js";
import {
  defaultWorkersConfig,
  maskKey,
  mergeConfigYamlProviderOverrides,
  parseProvider,
  parseWorkersConfig,
  readWorkersSection,
  type WorkerProvider,
} from "../workers/config.js";
import {
  parseWorkersYamlDocument,
  providerToYamlPlain,
  workersYamlPath,
  writeWorkersYamlText,
  yamlProviderToRaw,
} from "../workers/workers-config.js";
import {
  deepMergeConfig,
  mergeYamlUnderDefaults,
  shippedMainDefaults,
  shippedWorkersDefaultsPath,
} from "./shipped-defaults.js";
import { userWorkersYamlRaw } from "./shipped-defaults.js";
import { MAIN_CONFIG_SECTION_COMMENTS, migrateMainConfigToYaml, yamlSiblingPath } from "./main-config.js";
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
// Document-level edits (set/unset never reflow the file)
// ---------------------------------------------------------------------------

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True when `node` is an empty collection (`{}` / `[]`). */
function isEmptyCollection(node: unknown): boolean {
  if (isMap(node)) return node.items.length === 0;
  if (isSeq(node)) return node.items.length === 0;
  return false;
}

/** Remove a mapping entry whose value became an empty `{}`/`[]`, walking up
 *  so a `set`→`unset` round-trip leaves no empty-parent scaffolding behind. */
function pruneEmptyParents(doc: Document, segments: string[]): void {
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const path = segments.slice(0, depth);
    const node = doc.getIn(path, true);
    if (!isEmptyCollection(node)) return;
    doc.deleteIn(path);
  }
}

/** True when a plain scalar's YAML form would re-parse as the wrong type or
 *  shape (an all-digit token, "true", "null", an empty string, JSON-looking):
 *  such values are written double-quoted. */
function needsQuoting(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (v === "") return true;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return true; // int/float lookalike
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(v)) return true; // bool/null lookalikes
  const t = v.trim();
  if (t.startsWith("[") || t.startsWith("{")) return true; // flow collection lookalike
  return false;
}

/**
 * Set one leaf in a YAML Document with the Document API (`setIn`): every
 * untouched line keeps its exact bytes (quotes, folding, comments). Scalars are
 * written plain unless their form would re-parse as another type (see
 * needsQuoting); `forceString` always writes a double-quoted string — an env
 * value must be one even when it looks like an int. Objects/arrays are stored
 * as plain values (the yaml lib styles them at stringify time).
 */
function setInYamlDoc(doc: Document, segments: string[], value: unknown, forceString = false): void {
  if (typeof value === "object" && value !== null) {
    doc.setIn(segments, value);
    return;
  }
  const s = new Scalar(String(value));
  if (forceString || needsQuoting(value)) s.type = Scalar.QUOTE_DOUBLE;
  else s.type = Scalar.PLAIN;
  doc.setIn(segments, s as Node);
}

/**
 * Set one leaf in a plain JSON config (config.json era): same coercion rule —
 * every value is stored as a string, so `pai config set` never writes an int
 * the loader would reject.
 */
function setAtPathCoerced(root: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  const clone = structuredClone(root);
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cur[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segments[segments.length - 1]] = String(value);
  return clone;
}

/** A config write that would not load is refused before anything touches disk;
 *  the message names the loader error (the same read path the router serves from). */
class ConfigWriteRejectedError extends MainConfigOpsError {}

// ---------------------------------------------------------------------------
// Provider overrides: workers.providers.<name>.* lives in workers.yaml
// ---------------------------------------------------------------------------

/**
 * A `workers.providers…` path routes to workers.yaml when that file exists:
 * providers are DEFINED there, and a partial entry written into config.yaml is
 * not merged onto the workers.yaml provider — readWorkersSection replaces the
 * whole providers map with workers.yaml's — so the write would make every
 * config load fail (`workers.providers.<name>.baseUrl: is required`, 2026-11-17).
 * A provider named nowhere, or no workers.yaml at all, stays in config.yaml.
 */
function providerOverrideTarget(segments: string[]): { yamlPath: string; rest: string[] } | null {
  if (segments.length < 3 || segments[0] !== "workers" || segments[1] !== "providers") return null;
  const name = segments[2];
  // the builtin anthropic block is native models, not a provider entry — it never receives an override
  if (!name || name === "anthropic") return null;
  const yamlPath = workersYamlPath();
  if (!existsSync(yamlPath)) return null;
  // `active` (workers.providers.active) and the builtin block stay outside the
  // providers map routing.
  if (name === "active") return null;
  let root: Record<string, unknown> | null;
  try {
    root = parseDocument(readFileSync(yamlPath, "utf8")).toJS() as Record<string, unknown> | null;
  } catch {
    return null; // an unloadable workers.yaml is not this path's error to route around
  }
  const providersRaw = root?.providers;
  const providers: Record<string, unknown> = {};
  if (isPlainObj(providersRaw)) {
    for (const [k, v] of Object.entries(providersRaw)) {
      // a builtin block is not an overridable provider entry either
      if (isPlainObj(v) && v.builtin === true) continue;
      providers[k] = v;
    }
  }
  if (!(name in providers)) return null;
  return { yamlPath, rest: segments.slice(2) };
}

/** The workers.yaml Document after applying a provider set/unset, or null
 *  when nothing changed. `value === undefined` unsets the leaf. */
function editedProviderYamlDoc(yamlPath: string, rest: string[], value: unknown | undefined): Document | null {
  const text = readFileSync(yamlPath, "utf8");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new MainConfigOpsError(`${yamlPath}: ${doc.errors[0].message}`);
  const at = ["providers", ...rest];
  if (value === undefined) {
    const before = String(doc);
    doc.deleteIn(at);
    pruneEmptyParents(doc, at); // from `providers`, not from the document root
    return String(doc) === before ? null : doc;
  }
  // The provider's own block receives the leaf directly — a top-level sibling
  // mapping would parse as a second (invalid) provider.
  if (!doc.hasIn(at)) {
    const parentPath = at.slice(0, -1);
    const parent = doc.getIn(parentPath, true);
    if (parent !== undefined && !isMap(parent)) {
      throw new MainConfigOpsError(
        `workers.providers.${rest[0]}.${rest.slice(1).join(".")}: its parent is not a mapping — refusing to write`
      );
    }
  }
  // under `env` every value is a string; elsewhere plain unless ambiguous
  const forceString = rest.length >= 2 && rest[1] === "env";
  setInYamlDoc(doc, at, value, forceString);
  return doc;
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
    localHandoffMinutes: workers.localHandoffMinutes,
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
  // workers.providers.<name>.* is the provider's own file shape (workers.yaml
  // snake_case), not config.yaml's internal camelCase — schemaRoot's map holds
  // parsed WorkerProvider objects, so validate against the on-disk names.
  const checkPath: string[] = [...segments];
  if (segments.length >= 4 && segments[0] === "workers" && segments[1] === "providers") {
    // under `env` every value is a string — no type expectation applies
    if (segments[3] === "env") return;
    const at = 3; // index of the field inside providers.<name>.<field>…
    if (segments[at] === "url") checkPath[at] = "baseUrl";
    else if (segments[at] === "key_file") checkPath[at] = "keyFile";
    else if (segments[at] === "upstream_url") checkPath[at] = "upstreamUrl";
    else if (segments[at] === "tier") checkPath[at] = "costTier";
    else if (segments[at] === "quota_probe") checkPath[at] = "quotaProbe";
    else if (segments[at] === "quota_skip_at") checkPath[at] = "quotaSkipAt";
    else if (segments[at] === "worker_model") checkPath[at] = "workerModel";
    else if (segments[at] === "context_window") checkPath[at] = "contextWindow";
    else if (segments[at] === "model_tiers") checkPath[at] = "modelTiers";
    else if (segments[at] === "max_concurrent") checkPath[at] = "maxConcurrent";
    else if (segments[at] === "conversation_slots") checkPath[at] = "conversationSlots";
  }
  const { value: expected, found } = getAtPath(schema, checkPath);
  if (found && expected !== null && expected !== undefined) {
    const expectedType = Array.isArray(expected) ? "array" : typeof expected;
    // a string passes any type expectation: `pai config set` can store it quoted,
    // and the loader validates the parsed result before the write commits.
    const actualType = Array.isArray(value) ? "array" : typeof value === "string" ? expectedType : typeof value;
    if (expectedType !== actualType && !opts.force) {
      throw new MainConfigOpsError(
        `${segments.join(".")}: expected ${expectedType}, got ${actualType} (pass --force to override)`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Value parsing (`pai config set <path> <value>`)
// ---------------------------------------------------------------------------

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
 * its type against the shipped defaults (refusable with `force`; `asString` stores `value` verbatim, no parsing), routes a
 * `workers.providers.<name>.*` key to workers.yaml when the provider is
 * defined there (a partial provider block in config.yaml would break every
 * load — readWorkersSection replaces the providers map wholesale), then writes
 * through writeMainConfigRaw / writeWorkersYamlText. Every value is stored as
 * a string (env and any scalar alike: a YAML int under `env` is not a valid
 * env value). The resulting full config must pass the same loader the router
 * reads with before anything touches disk: a write that would make the config
 * unloadable is refused, both files left byte-identical.
 */
export function setConfigValueOp(dottedPath: string, rawValue: string, opts: { force?: boolean; asString?: boolean } = {}): SetConfigResult {
  const segments = splitConfigPath(dottedPath);
  const value = opts.asString ? rawValue : parseConfigValueString(rawValue);
  validateAgainstSchema(segments, value, opts);

  // provider override → workers.yaml (deep merge into the defined provider),
  // validated before committing; config.yaml is not touched at all.
  const target = providerOverrideTarget(segments);
  if (target) {
    const doc = editedProviderYamlDoc(target.yamlPath, target.rest, value);
    if (!doc) return { yamlCreated: false, yamlPath: target.yamlPath, value };
    validateResultingConfig(String(doc));
    writeWorkersYamlText(target.yamlPath, String(doc));
    return { yamlCreated: false, yamlPath: target.yamlPath, value };
  }

  const jsonPath = paiConfigFilePath();
  const yamlPath = yamlSiblingPath(jsonPath);
  let yamlCreated = false;
  if (!existsSync(yamlPath)) {
    if (existsSync(jsonPath)) {
      migrateMainConfigToYaml(jsonPath, {});
    } else {
      writeYamlFileAtomic(yamlPath, "{}\n", { label: yamlPath });
    }
    yamlCreated = true;
  }

  // config.yaml exists (just created or migrated): edit the Document directly —
  // only the changed leaf is touched, so unrelated lines keep their exact bytes.
  const doc = parseDocument(readFileSync(yamlPath, "utf8"));
  if (doc.errors.length) throw new MainConfigOpsError(`${yamlPath}: ${doc.errors[0].message}`);
  // A provider block in config.yaml is a partial override the loader deep-merges
  // onto its workers.yaml provider (mergeConfigYamlProviderOverrides), so it
  // must arrive in the workers.yaml on-disk shape: providers.<name>.<snake_key>
  // — `url`, not the parsed field name `baseUrl`.
  // the doc path carries snake_case provider field names; `segments` is what the
  // user typed (and what the env-leaf rule reads)
  const at = isProviderOverrideSegments(segments) ? providerOverrideDocPath(segments) : segments;
  const before = String(doc);
  // env values are always strings (a YAML int under `env` is not a valid env
  // value — the 2026-11-17 write landed CLAUDE_CODE_MAX_OUTPUT_TOKENS as an
  // int); every other scalar keeps the type the user asked for, and any value
  // whose plain form would re-parse as something else (an all-digit token,
  // "true", "no") is forced to a quoted string.
  const envLeaf = segments.length >= 4 && segments[0] === "workers" && segments[1] === "providers" && segments[3] === "env";
  setInYamlDoc(doc, at, value, envLeaf);
  validateResultingConfig(undefined, String(doc));
  // no-op when the file already holds this exact quoted scalar (the write also
  // skips its .bak-pai backup and the home commit)
  // the write goes to jsonPath's sibling explicitly: every path in this seam is
  // call-time resolved (tests re-point PAI_CONFIG_FILE after import)
  if (String(doc) !== before) writeMainConfigRaw(doc.toJS() as Record<string, unknown>, jsonPath);
  return { yamlCreated, yamlPath, value };
}

/** True when `segments` reaches into config.yaml's `workers.providers.<name>.*`
 *  tree — an override block the loader deep-merges onto its workers.yaml provider. */
function isProviderOverrideSegments(segments: string[]): boolean {
  return segments.length >= 3 && segments[0] === "workers" && segments[1] === "providers";
}

/** The on-disk snake_case key for a workers.providers.<name>.<field> path, so
 *  the loader's deep merge lands it on the right provider field (camelCase
 *  names like `baseUrl` are the PARSED shape and would merge nowhere). */
function snakeProviderField(field: string): string {
  const map: Record<string, string> = {
    baseUrl: "url", keyFile: "key_file", upstreamUrl: "upstream_url", costTier: "tier",
    quotaProbe: "quota_probe", quotaSkipAt: "quota_skip_at", workerModel: "worker_model",
    contextWindow: "context_window", modelTiers: "model_tiers", maxConcurrent: "max_concurrent",
    conversationSlots: "conversation_slots",
  };
  return map[field] ?? field;
}

/** workers.providers.<name>.<field>… → workers.providers.<name>.<snake_field>…. */
function providerOverrideDocPath(segments: string[]): string[] {
  if (segments.length < 4) return segments;
  const out = [...segments];
  out[3] = snakeProviderField(segments[3]);
  return out;
}

/**
 * Load the resulting full config with the router's own read path — loadConfig()
 * plus readWorkersSection(), which throws `workers…: …` on a provider that
 * would not parse (the 2026-11-17 failure) and deep-merges a partial config.yaml
 * provider override onto its workers.yaml provider. The candidate text is
 * validated IN MEMORY (`candidateYamlText` = the would-be workers.yaml,
 * `candidateMainText` = the would-be config.yaml): nothing is staged to disk and
 * no parse cache can go stale against a same-mtime temp file. Throws
 * ConfigWriteRejectedError naming the load error; nothing has been written yet.
 */
function validateResultingConfig(candidateYamlText?: string, candidateMainText?: string): void {
  const configPath = paiConfigFilePath();
  try {
    const mainRaw: Record<string, unknown> = candidateMainText !== undefined
      ? (parseDocument(candidateMainText).toJS() as Record<string, unknown>) ?? {}
      : readMainConfigRaw(configPath);
    if (candidateMainText !== undefined && parseDocument(candidateMainText).errors.length) {
      throw new MainConfigOpsError(`config.yaml: ${parseDocument(candidateMainText).errors[0].message}`);
    }

    // effectiveMainConfig's semantics with the candidate main text swapped in for
    // the file: shipped defaults under the user's config.yaml (a broken candidate
    // throws here, exactly as loadConfig would).
    const merged = deepMergeConfig(shippedMainDefaults(), mainRaw);
    // the workers section exactly as readWorkersSection builds it. The merged
    // doc must carry the USER's providers node for the cross-checks (classes →
    // provider names), so merge the candidate over the user file's own text
    // rather than re-merging over the shipped defaults.
    const yamlPath = workersYamlPath();
    let yamlData: ReturnType<typeof parseWorkersYamlDocument> | null = null;
    if (existsSync(yamlPath)) {
      const defaultsText = readFileSync(shippedWorkersDefaultsPath(), "utf8");
      const userText = readFileSync(yamlPath, "utf8");
      // the shipped defaults merged under the candidate (= what the file will be)
      const doc = mergeYamlUnderDefaults(defaultsText, candidateYamlText ?? userText);
      if (candidateYamlText !== undefined) {
        // a class the USER named but the candidate drops would otherwise fall
        // back to the shipped table and dodge the cross-check: re-apply the
        // user's classes/capabilities over the candidate, as effectiveWorkersYamlDoc
        // merges them.
        const user = parseDocument(userText);
        const userClasses = user.get("classes");
        if (!user.has("tiers") && isMap(userClasses) && userClasses.items.length) doc.delete("tiers");
        for (const key of ["classes", "capabilities"]) {
          const v = user.get(key, true);
          if (v !== undefined) doc.set(key, structuredClone(v));
        }
      }
      yamlData = parseWorkersYamlDocument(doc, yamlPath);
    }
    // the provider map exactly as readWorkersSection builds it: a config.yaml
    // entry naming a workers.yaml provider is an override (deep-merged onto it,
    // validated through the merge); one naming none is a full definition and is
    // validated as such by parseWorkersConfig.
    const workers = parseWorkersConfig(merged.workers, yamlData?.providers);
    if (yamlData) {
      workers.active = yamlData.active;
      workers.providers = mergeConfigYamlProviderOverrides(
        yamlData.providers,
        (merged.workers as { providers?: Record<string, unknown> } | undefined)?.providers
      );
      workers.tiers = yamlData.tiers;
      workers.capabilities = yamlData.capabilities;
      workers.nativeModels = yamlData.nativeModels;
      if (Object.keys(yamlData.classes).length) workers.classes = yamlData.classes;
      if (Object.keys(yamlData.mcpSets).length) workers.mcpSets = yamlData.mcpSets;
    }
    // when workers.yaml supplies the map, config.yaml's `providers` are partial
    // overrides — validated through the merge above, never as standalone entries.
    if (!yamlData) {
      for (const [name, p] of Object.entries(workers.providers)) {
        if (p.native) continue;
        parseProvider(name, yamlProviderToRaw(providerToYamlPlain(p)));
      }
    }
    // the main config itself must still be a loadable mapping
    loadConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigWriteRejectedError(
      `refusing to write: the resulting config would not load (${msg}) — no file was changed`
    );
  }
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
 *  the path was never set explicitly — defaults are never "unset". A
 *  `workers.providers.<name>.*` path unsets in workers.yaml when the provider
 *  is defined there (the same routing `set` uses); a Document-level delete
 *  leaves every other line byte-identical, and the result must still load. */
export function unsetConfigValueOp(dottedPath: string): UnsetConfigResult {
  const segments = splitConfigPath(dottedPath);

  const target = providerOverrideTarget(segments);
  if (target) {
    const doc = editedProviderYamlDoc(target.yamlPath, target.rest, undefined);
    if (!doc) return { existed: false };
    validateResultingConfig(String(doc));
    writeWorkersYamlText(target.yamlPath, String(doc));
    return { existed: true };
  }

  const jsonPath = paiConfigFilePath();
  const yamlPath = yamlSiblingPath(jsonPath);
  if (existsSync(yamlPath)) {
    const doc = parseDocument(readFileSync(yamlPath, "utf8"));
    if (doc.errors.length) throw new MainConfigOpsError(`${yamlPath}: ${doc.errors[0].message}`);
    const at = isProviderOverrideSegments(segments) ? providerOverrideDocPath(segments) : segments;
    const found = doc.hasIn(at);
    if (!found) return { existed: false };
    const before = String(doc);
    doc.deleteIn(at);
    pruneEmptyParents(doc, at);
    if (String(doc) === before) return { existed: true };
    validateResultingConfig();
    writeMainConfigRaw(doc.toJS() as Record<string, unknown>, jsonPath);
    return { existed: true };
  }

  const raw = readMainConfigRaw(jsonPath);
  const { found } = getAtPath(raw, segments);
  if (!found) return { existed: false };
  validateResultingConfig();
  writeMainConfigRaw(deleteAtPath(raw, segments), jsonPath);
  return { existed: true };
}
