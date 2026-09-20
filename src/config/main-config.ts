/**
 * main-config.ts — the dual-format (config.yaml / config.json) engine behind
 * the main PAI config file. Deliberately has NO dependency on
 * src/daemon/config.ts (which owns path resolution, PaiDaemonConfig and
 * DEFAULTS) so that module can import this one for loadConfig() without a
 * cycle; every path this module touches is passed in explicitly.
 *
 * Precedence, same shape as workers.yaml/workers/config.ts: config.yaml wins
 * when it exists, config.json otherwise. `pai config yaml` (see
 * src/cli/commands/config.ts) performs the one-time JSON→YAML conversion;
 * every writer that goes through readMainConfigRaw/writeMainConfigRaw (see
 * src/daemon/config.ts) keeps working unmodified either way.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { Document, parseDocument } from "yaml";
import { readJsonStrict, writeJsonAtomic } from "./json-store.js";
import { writeYamlFileAtomic, syncPlainObjectIntoYamlDoc, deepEqualJson, setYamlKeyComment } from "./yaml-store.js";

export class MainConfigError extends Error {}

/** The config.yaml sibling of a given config.json path (same directory). */
export function yamlSiblingPath(jsonPath: string): string {
  return join(dirname(jsonPath), "config.yaml");
}

/** The path a user should be pointed at: config.yaml when it exists (same
 *  precedence as readDualFormatConfigRaw), else config.json. */
export function resolvedMainConfigPath(jsonPath: string, yamlPath: string = yamlSiblingPath(jsonPath)): string {
  return existsSync(yamlPath) ? yamlPath : jsonPath;
}

/**
 * Read the raw main config: config.yaml if it exists, else config.json
 * (readJsonStrict — missing is `{}`, damaged throws), matching
 * readWorkersSection's precedence for workers.yaml/JSON.
 */
export function readDualFormatConfigRaw(jsonPath: string, yamlPath: string = yamlSiblingPath(jsonPath)): Record<string, unknown> {
  if (existsSync(yamlPath)) {
    let text: string;
    try {
      text = readFileSync(yamlPath, "utf8");
    } catch (e) {
      throw new MainConfigError(`Could not read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const doc = parseDocument(text);
    if (doc.errors.length) {
      throw new MainConfigError(`${yamlPath}: ${doc.errors[0].message}`);
    }
    const parsed = doc.toJS();
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MainConfigError(`${yamlPath}: top level must be a mapping`);
    }
    return parsed as Record<string, unknown>;
  }
  return readJsonStrict(jsonPath, jsonPath);
}

/**
 * Write the raw main config back: comment-preserving diff-sync into
 * config.yaml when it exists, else plain writeJsonAtomic to config.json —
 * this is the one seam every writer of the main config (CLI commands,
 * identity, notifications, setup, workers) routes through, so a config.yaml
 * on disk is honored no matter which of them made the change.
 */
export function writeDualFormatConfigRaw(
  jsonPath: string,
  raw: Record<string, unknown>,
  yamlPath: string = yamlSiblingPath(jsonPath)
): void {
  if (existsSync(yamlPath)) {
    let text: string;
    try {
      text = readFileSync(yamlPath, "utf8");
    } catch (e) {
      throw new MainConfigError(`Could not read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const doc = parseDocument(text);
    if (doc.errors.length) {
      throw new MainConfigError(`${yamlPath}: ${doc.errors[0].message}`);
    }
    const before = (doc.toJS() ?? {}) as Record<string, unknown>;
    syncPlainObjectIntoYamlDoc(doc, before, raw);
    try {
      writeYamlFileAtomic(yamlPath, String(doc), { label: yamlPath });
    } catch (e) {
      throw new MainConfigError(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  writeJsonAtomic(jsonPath, raw, { label: jsonPath });
}

// ---------------------------------------------------------------------------
// JSON → YAML migration ("pai config yaml")
// ---------------------------------------------------------------------------

/**
 * Short annotation for every top-level PaiDaemonConfig field, shown as a `#`
 * comment above the field in the generated config.yaml. Mirrors (and must be
 * kept in sync with) the doc comments on PaiDaemonConfig in
 * src/daemon/config.ts — kept as a separate short-form table rather than
 * parsed from the TS source at runtime.
 */
export const MAIN_CONFIG_SECTION_COMMENTS: Record<string, string> = {
  socketPath: "Unix Domain Socket path for daemon IPC.",
  indexIntervalSecs: "How often the daemon re-indexes changed files, in seconds.",
  embedIntervalSecs: "How often the daemon runs the embedding pass, in seconds.",
  embedOnStartup:
    "Run an embed pass 60s after daemon start. Off by default: with a large backlog it makes every restart a CPU storm.",
  maintenanceHour: "Local hour (0-23) to anchor the recurring index/embed cycle to, so maintenance runs in a fixed window.",
  storageBackend: 'Storage backend: "sqlite" (default) or "postgres".',
  postgres: 'PostgreSQL connection settings, used when storageBackend is "postgres".',
  embeddingModel: "Embedding model name, used for semantic/hybrid search.",
  logLevel: "Daemon log level: debug, info, warn, or error.",
  vaultPath: "Obsidian vault root path for zettelkasten indexing, if any.",
  vaultProjectId: "Registry project_id used for vault chunks in memory_chunks. Default: auto-detected.",
  notifications: "Notification subsystem configuration.",
  search: "Search defaults, applied when an MCP tool or CLI call doesn't specify one.",
  tasks: "Task bus — optional external tracker for cross-session work.",
  identity:
    'Who "me" is — addresses that count as the user\'s own. Empty by default and never guessed: nothing is self-addressed until this is set.',
  workers:
    "Non-provider worker settings (pane, routing, tree, cache keepalive, fallback). Providers/classes/mcp_sets live in workers.yaml, not here.",
};

/** Keys whose leading-underscore string value is a JSON stand-in for a
 *  comment (e.g. `"_comment": "..."`, `"_deliverToNote": "..."`). Stripped
 *  from the generated YAML and re-attached as a real `#` comment above the
 *  nearest remaining sibling key in the same object. */
function isCommentKey(key: string): boolean {
  return key.startsWith("_");
}

interface CollectedComment {
  path: (string | number)[];
  text: string;
}

/** Recursively strip `_`-prefixed comment keys out of a plain JSON value,
 *  returning the cleaned value plus where each stripped comment belongs. */
function stripUnderscoreComments(value: unknown, path: (string | number)[] = []): { cleaned: unknown; comments: CollectedComment[] } {
  if (Array.isArray(value)) {
    const comments: CollectedComment[] = [];
    const cleaned = value.map((v, i) => {
      const r = stripUnderscoreComments(v, [...path, i]);
      comments.push(...r.comments);
      return r.cleaned;
    });
    return { cleaned, comments };
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    const comments: CollectedComment[] = [];
    const localComments: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (isCommentKey(k)) {
        if (typeof v === "string" && v.trim()) localComments.push(v.trim());
        continue;
      }
      const r = stripUnderscoreComments(v, [...path, k]);
      cleaned[k] = r.cleaned;
      comments.push(...r.comments);
    }
    // Attach every local comment above the first remaining key in this
    // object (in source order) — good enough for the JSON-workaround shape
    // this exists to convert (a `_comment` sibling explaining the object).
    const firstKey = Object.keys(cleaned)[0];
    if (localComments.length && firstKey !== undefined) {
      comments.unshift({ path: [...path, firstKey], text: localComments.join(" ") });
    }
    return { cleaned, comments };
  }
  return { cleaned: value, comments: [] };
}

export interface MainConfigMigrateResult {
  yamlPath: string;
  yamlText: string;
  /** Path the pre-migration JSON was renamed to; null on a dry run. */
  backupPath: string | null;
  dryRun: boolean;
}

/**
 * `pai config yaml`: convert config.json to config.yaml. Strips `_`-prefixed
 * JSON-comment-workaround keys into real `#` comments, adds a short
 * annotation above every top-level section (MAIN_CONFIG_SECTION_COMMENTS),
 * verifies the generated YAML re-parses to the exact same data before
 * writing anything, then renames the JSON aside to
 * `config.json.migrated-<YYYY-MM-DD>` (never deleted). Refuses when
 * config.yaml already exists unless `force`. `dryRun` computes and returns
 * the would-be YAML text without touching either file.
 */
export function migrateMainConfigToYaml(
  jsonPath: string,
  opts: { dryRun?: boolean; force?: boolean; yamlPath?: string; sectionComments?: Record<string, string> } = {}
): MainConfigMigrateResult {
  const yamlPath = opts.yamlPath ?? yamlSiblingPath(jsonPath);
  if (existsSync(yamlPath) && !opts.force) {
    throw new MainConfigError(`${yamlPath} already exists — edit it directly, or pass --force to regenerate it from ${jsonPath}`);
  }
  if (!existsSync(jsonPath)) {
    throw new MainConfigError(`${jsonPath} does not exist — nothing to migrate`);
  }

  const raw = readJsonStrict(jsonPath, jsonPath);
  const { cleaned, comments } = stripUnderscoreComments(raw);
  const cleanedObj = cleaned as Record<string, unknown>;

  const doc = new Document(cleanedObj);
  const sectionComments = opts.sectionComments ?? MAIN_CONFIG_SECTION_COMMENTS;
  for (const [key, text] of Object.entries(sectionComments)) {
    if (key in cleanedObj) setYamlKeyComment(doc, [key], text);
  }
  for (const c of comments) {
    setYamlKeyComment(doc, c.path, c.text);
  }
  const yamlText = String(doc);

  // Round-trip check: the generated YAML must re-parse to exactly the data
  // it was built from before anything is written or renamed.
  const reparsed = parseDocument(yamlText).toJS();
  if (!deepEqualJson(reparsed, cleanedObj)) {
    throw new MainConfigError(
      `${yamlPath}: generated YAML does not re-parse to the same data as ${jsonPath} — aborting, nothing written`
    );
  }

  if (opts.dryRun) {
    return { yamlPath, yamlText, backupPath: null, dryRun: true };
  }

  writeYamlFileAtomic(yamlPath, yamlText, { label: yamlPath });

  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = join(dirname(jsonPath), `${basename(jsonPath)}.migrated-${stamp}`);
  renameSync(jsonPath, backupPath);

  return { yamlPath, yamlText, backupPath, dryRun: false };
}
