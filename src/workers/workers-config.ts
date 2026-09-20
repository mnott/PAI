/**
 * workers-config.ts — workers.yaml: providers, model roles, class routing,
 * mcp_sets.
 *
 * config.ts's readWorkersSection/writeWorkersSection are the only callers —
 * every other module keeps talking to the WorkersConfig shape from config.ts
 * and never touches this file. That is deliberate: adding a provider used to
 * mean editing JSON inside an unrelated config blob; this module makes
 * providers/classes/mcp_sets/active a single human-editable file, documented
 * in docs/workers-config.md, while everything downstream is unchanged.
 *
 * Writes go through the `yaml` package's Document API and only touch the
 * entries that actually changed, so hand-written comments elsewhere in the
 * file — including a comment directly above an untouched provider — survive
 * byte-for-byte across `add`, `use`, `disable`, and every other mutation.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Document, Scalar, parseDocument, type Node } from "yaml";
import { readJsonStrict, writeJsonAtomic } from "../config/json-store.js";
import { writeYamlFileAtomic, YamlStoreError } from "../config/yaml-store.js";
import { paiHomePath, resolvePaiFile, migratePaiFile, type MigrateFileResult } from "../config/pai-home.js";
import {
  ANTHROPIC_NATIVE,
  NATIVE_ANTHROPIC_MODELS,
  WorkersConfigError,
  expandHome,
  isModelCapability,
  parseCapabilitiesValue,
  parseClassesValue,
  parseMcpSetsValue,
  parseModelsBlock,
  parseProvider,
  parseWorkersConfig,
  type ClassTarget,
  type WorkerProvider,
} from "./config.js";

export const WORKERS_YAML_FILENAME = "workers.yaml";

/**
 * Where workers.yaml lives since 2026-09-19: under the PAI_HOME namespace
 * dir (~/.claude/pai by default) — this file is per-user state that can
 * carry API keys and must never be committed, same as the rest of PAI_HOME.
 */
function defaultWorkersYamlPath(): string {
  return paiHomePath(WORKERS_YAML_FILENAME);
}

/** Briefly the canonical location between 2026-09-19's two migrations —
 *  read during the transition, never written to again. */
function oldWorkersYamlPath(): string {
  return join(homedir(), ".claude", WORKERS_YAML_FILENAME);
}

/** Where workers.yaml lived before 2026-09-19 — read during the transition,
 *  never written to (see `pai worker config migrate`). */
function legacyWorkersYamlPath(): string {
  return join(homedir(), ".config", "pai", WORKERS_YAML_FILENAME);
}

/**
 * The path any read/write of workers.yaml actually uses: PAI_WORKERS_YAML
 * (tests, power users) first, else the new PAI_HOME location if it exists,
 * else the most recent old location that is actually on disk (printing a
 * one-time notice), else the new location (the target a first write creates).
 */
export function workersYamlPath(): string {
  const override = process.env.PAI_WORKERS_YAML;
  if (override) return override;
  return resolvePaiFile(
    defaultWorkersYamlPath(),
    [oldWorkersYamlPath(), legacyWorkersYamlPath()],
    "pai worker config migrate"
  );
}

/** Where a fresh write (init, migrate, relocate's destination) always
 *  targets — the new location, or PAI_WORKERS_YAML for test isolation.
 *  Never an old path: nothing is ever written there again. */
function writeTargetWorkersYamlPath(): string {
  return process.env.PAI_WORKERS_YAML ?? defaultWorkersYamlPath();
}

/**
 * One-line notice for `pai worker config check` and `pai worker providers`
 * when workers.yaml is still sitting at an old location. Null once it has
 * moved (or PAI_WORKERS_YAML is set — that always wins, nothing to migrate).
 */
export function workersYamlLegacyNotice(): string | null {
  if (process.env.PAI_WORKERS_YAML) return null;
  if (existsSync(defaultWorkersYamlPath())) return null;
  const found = [oldWorkersYamlPath(), legacyWorkersYamlPath()].find((p) => existsSync(p));
  if (!found) return null;
  return `workers.yaml is still at the old location (${found}) — run \`pai worker config migrate\` to move it to ${defaultWorkersYamlPath()}`;
}

export interface WorkersYamlData {
  active: string | null;
  providers: Record<string, WorkerProvider>;
  classes: Record<string, ClassTarget>;
  capabilities: Record<string, string[]>;
  mcpSets: Record<string, string[]>;
  nativeModels: WorkerProvider["models"];
}

// ---------------------------------------------------------------------------
// Friendly (on-disk) provider shape ↔ internal WorkerProvider
// ---------------------------------------------------------------------------

/** snake_case on-disk keys → the camelCase raw shape parseProvider expects. */
function yamlProviderToRaw(y: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (y.enabled !== undefined) raw.enabled = y.enabled;
  if (y.url !== undefined) raw.baseUrl = y.url;
  if (y.key_file !== undefined) raw.keyFile = y.key_file;
  if (y.key !== undefined) raw.key = y.key;
  if (y.tier !== undefined) raw.costTier = y.tier;
  if (y.models !== undefined) raw.models = y.models;
  if (y.protocol !== undefined) raw.protocol = y.protocol;
  if (y.engine !== undefined) raw.engine = y.engine;
  if (y.upstream_url !== undefined) raw.upstreamUrl = y.upstream_url;
  if (y.env !== undefined) raw.env = y.env;
  if (y.note !== undefined) raw.note = y.note;
  if (y.quota_probe !== undefined) raw.quotaProbe = y.quota_probe;
  if (y.quota_skip_at !== undefined) raw.quotaSkipAt = y.quota_skip_at;
  if (y.context_window !== undefined) raw.contextWindow = y.context_window;
  if (y.tags !== undefined) raw.tags = y.tags;
  if (y.usage !== undefined) raw.usage = y.usage;
  if (y.model_tiers !== undefined) raw.modelTiers = y.model_tiers;
  return raw;
}

/** Internal WorkerProvider → the friendly on-disk plain object for writing. */
function providerToYamlPlain(p: WorkerProvider): Record<string, unknown> {
  const y: Record<string, unknown> = {};
  if (!p.enabled) y.enabled = false;
  if (p.baseUrl) y.url = p.baseUrl;
  if (p.keyFile) y.key_file = p.keyFile;
  if (p.key) y.key = p.key;
  if (p.costTier !== undefined) y.tier = p.costTier;
  y.models = { ...p.models };
  if (p.protocol && p.protocol !== "anthropic") y.protocol = p.protocol;
  if (p.engine && p.engine !== "claude") y.engine = p.engine;
  if (p.upstreamUrl) y.upstream_url = p.upstreamUrl;
  if (p.env && Object.keys(p.env).length) y.env = { ...p.env };
  if (p.note) y.note = p.note;
  if (p.quotaProbe) y.quota_probe = p.quotaProbe;
  if (p.quotaSkipAt !== undefined) y.quota_skip_at = p.quotaSkipAt;
  if (p.contextWindow !== undefined) y.context_window = p.contextWindow;
  if (p.tags?.length) y.tags = [...p.tags];
  if (p.usage) y.usage = p.usage;
  if (p.modelTiers) y.model_tiers = { ...p.modelTiers };
  return y;
}

/** The builtin `anthropic` block only ever carries `builtin: true` + `models`. */
function parseBuiltinAnthropic(raw: unknown, pathPrefix: string): WorkerProvider["models"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkersConfigError(`${pathPrefix}: must be an object`);
  }
  const p = raw as Record<string, unknown>;
  if (p.builtin !== true) {
    throw new WorkersConfigError(
      `${pathPrefix}: "${ANTHROPIC_NATIVE}" is reserved for the built-in Claude Code login — ` +
        `set "builtin: true" (optionally with a "models" override) or rename this provider`
    );
  }
  const disallowed = ["url", "key_file", "key", "engine", "protocol", "upstream_url"].filter(
    (k) => p[k] !== undefined
  );
  if (disallowed.length) {
    throw new WorkersConfigError(
      `${pathPrefix}: a builtin provider cannot set ${disallowed.join(", ")} — it runs on Claude Code's own login`
    );
  }
  if (p.models === undefined) return { ...NATIVE_ANTHROPIC_MODELS };
  return parseModelsBlock(`${pathPrefix}.models`, p.models);
}

// ---------------------------------------------------------------------------
// Line-numbered errors
// ---------------------------------------------------------------------------

function lineOf(doc: Document, path: (string | number)[]): number | null {
  try {
    const node = doc.getIn(path, true) as Node | undefined;
    const range = node && typeof node === "object" && "range" in node ? node.range : undefined;
    if (!range) return null;
    const text = String(doc);
    return text.slice(0, range[0]).split("\n").length;
  } catch {
    return null;
  }
}

function withLine(doc: Document, path: (string | number)[], yamlPath: string, e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const line = lineOf(doc, path);
  throw new WorkersConfigError(line ? `${yamlPath}:${line}: ${msg}` : `${yamlPath}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

/**
 * Parse and fully validate a workers.yaml Document. Throws WorkersConfigError
 * naming `<path>:<line>` for anything wrong — an unknown provider referenced
 * by a class is a load error here, not a spawn-time surprise.
 */
export function parseWorkersYamlDocument(doc: Document, yamlPath: string): WorkersYamlData {
  const root = doc.toJS() ?? {};
  if (typeof root !== "object" || Array.isArray(root)) {
    throw new WorkersConfigError(`${yamlPath}: top level must be a mapping`);
  }
  const r = root as Record<string, unknown>;

  const providers: Record<string, WorkerProvider> = {};
  let nativeModels: WorkerProvider["models"] = { ...NATIVE_ANTHROPIC_MODELS };
  const providersRaw = r.providers;
  if (providersRaw !== undefined) {
    if (typeof providersRaw !== "object" || providersRaw === null || Array.isArray(providersRaw)) {
      withLine(doc, ["providers"], yamlPath, new WorkersConfigError("providers: must be a mapping of name → provider"));
    }
    for (const [name, raw] of Object.entries(providersRaw as Record<string, unknown>)) {
      try {
        if (name === ANTHROPIC_NATIVE) {
          nativeModels = parseBuiltinAnthropic(raw, `providers.${name}`);
        } else {
          providers[name] = parseProvider(name, yamlProviderToRaw(raw as Record<string, unknown>));
        }
      } catch (e) {
        withLine(doc, ["providers", name], yamlPath, e);
      }
    }
  }

  let classes: Record<string, ClassTarget> = {};
  if (r.classes !== undefined) {
    try {
      classes = parseClassesValue(r.classes, "classes");
    } catch (e) {
      withLine(doc, ["classes"], yamlPath, e);
    }
    // Cross-validate: every class must name a known provider (or "anthropic")
    // and, if it names a role, a capability that provider actually declares.
    // Unlike the JSON path (where a provider can be removed out from under a
    // class and the error surfaces at spawn time), workers.yaml catches this
    // at load time.
    for (const [cls, target] of Object.entries(classes)) {
      const provider = typeof target === "string" ? target.split("/")[0] : target.provider;
      const alias = typeof target === "string" ? target.split("/")[1] : undefined;
      if (provider !== undefined) {
        const native = provider === ANTHROPIC_NATIVE;
        if (!native && !providers[provider]) {
          withLine(
            doc,
            ["classes", cls],
            yamlPath,
            new WorkersConfigError(
              `classes.${cls}: no provider named "${provider}" (configured: ${Object.keys(providers).join(", ") || "(none)"})`
            )
          );
        }
        if (alias !== undefined) {
          if (!isModelCapability(alias)) {
            withLine(
              doc,
              ["classes", cls],
              yamlPath,
              new WorkersConfigError(
                `classes.${cls}: "${alias}" is not a valid capability name (must match ^[a-z][a-z0-9-]*$)`
              )
            );
          } else if (!native && providers[provider] && alias !== "default" && !providers[provider].models[alias]) {
            // the native provider has no configurable model slots — any
            // alias resolves through resolveModelCapability's own fallback
            withLine(
              doc,
              ["classes", cls],
              yamlPath,
              new WorkersConfigError(`classes.${cls}: provider "${provider}" has no "${alias}" model configured`)
            );
          }
        }
      }
    }
  }

  let capabilities: Record<string, string[]> = {};
  if (r.capabilities !== undefined) {
    try {
      capabilities = parseCapabilitiesValue(r.capabilities, "capabilities");
    } catch (e) {
      withLine(doc, ["capabilities"], yamlPath, e);
    }
  }

  let mcpSets: Record<string, string[]> = {};
  if (r.mcp_sets !== undefined) {
    try {
      mcpSets = parseMcpSetsValue(r.mcp_sets, "mcp_sets");
    } catch (e) {
      withLine(doc, ["mcp_sets"], yamlPath, e);
    }
  } else {
    mcpSets = parseMcpSetsValue(undefined, "mcp_sets");
  }

  const active = r.active === undefined || r.active === null ? null : String(r.active);
  if (active !== null && active !== ANTHROPIC_NATIVE && active !== "auto" && !providers[active]) {
    withLine(
      doc,
      ["active"],
      yamlPath,
      new WorkersConfigError(
        `active: no provider named "${active}" (configured: ${Object.keys(providers).join(", ") || "(none)"})`
      )
    );
  }

  return { active, providers, classes, capabilities, mcpSets, nativeModels };
}

/** Read + parse workers.yaml. Returns null if the file does not exist. */
export function readWorkersYaml(yamlPath: string): { doc: Document; data: WorkersYamlData } | null {
  if (!existsSync(yamlPath)) return null;
  let text: string;
  try {
    text = readFileSync(yamlPath, "utf8");
  } catch (e) {
    throw new WorkersConfigError(
      `Could not read ${yamlPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const doc = parseDocument(text);
  if (doc.errors.length) {
    throw new WorkersConfigError(`${yamlPath}: ${doc.errors[0].message}`);
  }
  const data = parseWorkersYamlDocument(doc, yamlPath);
  return { doc, data };
}

// ---------------------------------------------------------------------------
// Write (diff-based, comment-preserving)
// ---------------------------------------------------------------------------

function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A `key:` value as an explicit double-quoted YAML scalar. A key is an
 * opaque token, not YAML-authored text — plain-scalar auto-styling could
 * read one back as a number or boolean (an all-digit token, "true", "no", …)
 * if it were ever left unquoted, so every write forces the quoted form
 * regardless of what the plain style would otherwise pick.
 */
function quotedKeyNode(value: string): Scalar {
  const s = new Scalar(value);
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

/**
 * Apply the changes between `before` and `after` onto `doc`, touching only
 * the providers/classes/mcp_sets/active entries that actually differ. This is
 * what makes comment preservation possible: an untouched provider's node
 * (and any comment above it) is never revisited.
 */
function syncWorkersYamlDocument(doc: Document, before: WorkersYamlData, after: WorkersYamlData): void {
  // providers: add/update changed, remove gone (never touch the builtin anthropic block)
  for (const [name, p] of Object.entries(after.providers)) {
    const beforeP = before.providers[name];
    const changed = !beforeP || !shallowEqual(providerToYamlPlain(beforeP), providerToYamlPlain(p));
    if (changed) {
      // a fresh (or wholesale-replaced) provider entry is set in one shot as
      // a plain object — the yaml lib only turns it into real Map/Scalar
      // nodes lazily at stringify time, so a follow-up setIn/deleteIn into
      // the same not-yet-a-collection value would fail. Embedding the `key`
      // as an actual Scalar node here rides along: stringify leaves already-
      // Node values alone (see stringifyPair.js), quoting only that field.
      const y: Record<string, unknown> = providerToYamlPlain(p);
      if (typeof y.key === "string") y.key = quotedKeyNode(y.key);
      doc.setIn(["providers", name], y);
    }
  }
  for (const name of Object.keys(before.providers)) {
    if (!(name in after.providers)) doc.deleteIn(["providers", name]);
  }

  // classes: same add/update/remove diff
  for (const [cls, target] of Object.entries(after.classes)) {
    if (!shallowEqual(before.classes[cls], target)) {
      doc.setIn(["classes", cls], target);
    }
  }
  for (const cls of Object.keys(before.classes)) {
    if (!(cls in after.classes)) doc.deleteIn(["classes", cls]);
  }

  // capabilities: same add/update/remove diff
  for (const [cap, prefs] of Object.entries(after.capabilities)) {
    if (!shallowEqual(before.capabilities[cap], prefs)) {
      doc.setIn(["capabilities", cap], [...prefs]);
    }
  }
  for (const cap of Object.keys(before.capabilities)) {
    if (!(cap in after.capabilities)) doc.deleteIn(["capabilities", cap]);
  }

  // mcp_sets: same add/update/remove diff
  for (const [set, servers] of Object.entries(after.mcpSets)) {
    if (!shallowEqual(before.mcpSets[set], servers)) {
      doc.setIn(["mcp_sets", set], [...servers]);
    }
  }
  for (const set of Object.keys(before.mcpSets)) {
    if (!(set in after.mcpSets)) doc.deleteIn(["mcp_sets", set]);
  }

  // active
  if (before.active !== after.active) {
    if (after.active === null) doc.deleteIn(["active"]);
    else doc.setIn(["active"], after.active);
  }
}

/**
 * Write `after` into workers.yaml, preserving comments on everything that did
 * not change. Re-reads the file fresh (so the diff is against what is really
 * on disk, not a stale in-memory copy) and re-validates the result before
 * committing; on failure the previous bytes are left untouched.
 */
export function writeWorkersYaml(yamlPath: string, after: WorkersYamlData): void {
  const existing = readWorkersYaml(yamlPath);
  const doc = existing ? existing.doc : new Document({});
  const before: WorkersYamlData = existing
    ? existing.data
    : {
        active: null,
        providers: {},
        classes: {},
        capabilities: {},
        mcpSets: {},
        nativeModels: { ...NATIVE_ANTHROPIC_MODELS },
      };
  syncWorkersYamlDocument(doc, before, after);
  writeWorkersYamlText(yamlPath, String(doc));
}

/** Atomic write with a .bak-pai backup and a re-validate-or-restore guard.
 *  The file-I/O tail (backup, temp write at 0600, rename, chmod) is shared
 *  with every other PAI YAML file via writeYamlFileAtomic; only the
 *  workers.yaml-specific validation (parseWorkersYamlDocument) lives here. */
export function writeWorkersYamlText(yamlPath: string, text: string): void {
  // Validate before committing anything to disk.
  const probe = parseDocument(text);
  if (probe.errors.length) {
    throw new WorkersConfigError(`refusing to write ${yamlPath}: ${probe.errors[0].message} (previous file left unchanged)`);
  }
  try {
    parseWorkersYamlDocument(probe, yamlPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new WorkersConfigError(`refusing to write ${yamlPath}: ${msg} (previous file left unchanged)`);
  }

  try {
    writeYamlFileAtomic(yamlPath, text, { label: yamlPath });
  } catch (e) {
    throw new WorkersConfigError(e instanceof YamlStoreError ? e.message : String(e instanceof Error ? e.message : e));
  }
}

// ---------------------------------------------------------------------------
// Starter template, init, migrate
// ---------------------------------------------------------------------------

/** The exact commented starter shipped as examples/workers.yaml and by `init`. */
export function starterWorkersYamlText(): string {
  return `# PAI worker configuration.
# Providers PAI can run workers on, the model each role uses, and which
# provider every --class goes to. Edit by hand; \`pai worker providers\` shows
# the effective result. Comments are preserved when PAI writes this file.
#
# Per-user state, kept 0600: this file can hold API keys (\`key:\`, below).
# Never commit it or share it. \`key_file: <path>\` keeps a secret in its own
# 0600 file instead, if you'd rather not put it here.

active: anthropic          # provider for \`pai worker run\` without --provider or --class

providers:
  anthropic:
    builtin: true          # Claude Code's own login: no url, no key file
    models:
      default: ${NATIVE_ANTHROPIC_MODELS.default}
      fast: ${NATIVE_ANTHROPIC_MODELS.fast}
  glm:
    url: https://api.z.ai/api/anthropic
    key: "<your-api-key>"   # or key_file: <path to a 0600 file>
    tier: 3
    models:
      default: glm-5.3[1m]
      fast: glm-5.3-flash
      image: example-paint
  kimi:
    url: https://api.kimi.ai/coding/
    key: "<your-api-key>"   # or key_file: <path to a 0600 file>
    tier: 3
    models:
      default: k3[1m]
      fast: kimi-for-coding[1m]

# An \`engine: image\` provider does not spawn Claude — \`pai worker run
# --capability image\` POSTs straight to its OpenAI-compatible images API and
# writes the PNG it gets back. Uncomment and point it at a real provider
# (still nested under providers:, above) to enable \`--capability image\`:
#   pictures:
#     engine: image
#     url: https://api.example.com/v1
#     key: "<your-api-key>"
#     models:
#       default: example-image-model
#       image: example-image-model

# A class names a provider, or provider/role to pick a non-default model.
# Workers exist to parallelise and to save cost: the default is Sonnet,
# Haiku for the mechanical classes, and nothing here inherits the
# orchestrating session's model.
classes:
  implement: anthropic
  draft: anthropic
  research: anthropic
  complex: anthropic
  plan: anthropic
  review: anthropic
  spotcheck: anthropic/fast
  simple: anthropic/fast
  image: glm/image

# Cross-provider capability preference: which provider serves a --capability
# request, in order, when more than one declares it. Unlisted capabilities
# fall back to the active provider, then any provider that declares them.
# capabilities:
#   image: [pictures, glm]
#   fast: [anthropic]

mcp_sets:
  desktop: [clickr]
`;
}

/**
 * Build a workers.yaml document from real (migrated) data, keeping the same
 * header/section comments as the starter. Used by `pai worker config
 * migrate` — `init` writes the literal starter instead, since it has no data
 * to carry over.
 */
export function buildWorkersYamlText(data: WorkersYamlData): string {
  const lines: string[] = [];
  lines.push("# PAI worker configuration.");
  lines.push("# Providers PAI can run workers on, the model each role uses, and which");
  lines.push("# provider every --class goes to. Edit by hand; `pai worker providers` shows");
  lines.push("# the effective result. Comments are preserved when PAI writes this file.");
  lines.push("");
  lines.push(
    `active: ${data.active ?? "null"}` +
      "          # provider for `pai worker run` without --provider or --class"
  );
  lines.push("");
  lines.push("providers:");
  lines.push("  anthropic:");
  lines.push("    builtin: true          # Claude Code's own login: no url, no key file");
  lines.push("    models:");
  lines.push(`      default: ${data.nativeModels.default}`);
  if (data.nativeModels.fast) lines.push(`      fast: ${data.nativeModels.fast}`);
  if (data.nativeModels.image) lines.push(`      image: ${data.nativeModels.image}`);
  for (const [name, p] of Object.entries(data.providers)) {
    const y = providerToYamlPlain(p);
    lines.push(`  ${name}:`);
    for (const [k, v] of Object.entries(y)) {
      if (k === "models") continue;
      // a key is an opaque token, not YAML-authored text — always quoted so
      // it never round-trips as a number or boolean (see quotedKeyNode).
      lines.push(k === "key" ? `    key: ${JSON.stringify(String(v))}` : `    ${k}: ${yamlScalar(v)}`);
    }
    lines.push("    models:");
    for (const [k, v] of Object.entries(p.models)) lines.push(`      ${k}: ${yamlScalar(v)}`);
  }
  lines.push("");
  lines.push("# A class names a provider, or provider/role to pick a non-default model.");
  lines.push("# Workers exist to parallelise and to save cost: the default is Sonnet,");
  lines.push("# Haiku for the mechanical classes, and nothing here inherits the");
  lines.push("# orchestrating session's model.");
  const classEntries = Object.entries(data.classes);
  lines.push(classEntries.length ? "classes:" : "classes: {}");
  for (const [cls, target] of classEntries) {
    lines.push(`  ${cls}: ${typeof target === "string" ? target : yamlScalar(target)}`);
  }
  lines.push("");
  const capEntries = Object.entries(data.capabilities);
  if (capEntries.length) {
    lines.push("capabilities:");
    for (const [cap, prefs] of capEntries) lines.push(`  ${cap}: [${prefs.join(", ")}]`);
    lines.push("");
  }
  const mcpEntries = Object.entries(data.mcpSets);
  lines.push(mcpEntries.length ? "mcp_sets:" : "mcp_sets: {}");
  for (const [set, servers] of mcpEntries) {
    lines.push(`  ${set}: [${servers.join(", ")}]`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Minimal scalar formatter for buildWorkersYamlText's flat key: value lines. */
function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    // quote only when the plain form would be ambiguous YAML
    return /^[\w./~\[\]-]+$/.test(v) ? v : JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(yamlScalar).join(", ")}]`;
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Migration from the JSON `workers` section
// ---------------------------------------------------------------------------

export interface MigrateResult {
  yamlPath: string;
  yamlText: string;
  /** Path the pre-migration JSON `workers` section was backed up to; null on a dry run. */
  backupPath: string | null;
  dryRun: boolean;
}

/**
 * `pai worker config migrate`: reads the JSON `workers` section, writes
 * workers.yaml with the starter's comments, backs the JSON section up to
 * `workers.json.migrated-<date>` next to it, and strips providers/classes
 * (and the legacy `roles`)/mcpSets/active from the JSON. Idempotent: refuses
 * when workers.yaml already exists unless `force`. `dryRun` computes and
 * returns the would-be YAML text without touching either file.
 */
export function migrateWorkersToYaml(
  jsonPath: string,
  opts: { force?: boolean; dryRun?: boolean } = {}
): MigrateResult {
  const existing = workersYamlPath();
  if (existsSync(existing) && !opts.force) {
    throw new WorkersConfigError(
      `${existing} already exists — refusing to overwrite without --force`
    );
  }
  const yamlPath = writeTargetWorkersYamlPath();
  const raw = readJsonStrict(jsonPath, jsonPath);
  const workers = parseWorkersConfig(raw.workers);
  const data: WorkersYamlData = {
    active: workers.active,
    providers: workers.providers,
    classes: workers.classes,
    capabilities: workers.capabilities,
    mcpSets: workers.mcpSets,
    nativeModels: workers.nativeModels,
  };
  const yamlText = buildWorkersYamlText(data);

  if (opts.dryRun) {
    return { yamlPath, yamlText, backupPath: null, dryRun: true };
  }

  writeWorkersYamlText(yamlPath, yamlText);

  const stamp = new Date().toISOString().slice(0, 10);
  const backupPath = join(dirname(jsonPath), `workers.json.migrated-${stamp}`);
  writeFileSync(backupPath, JSON.stringify(raw.workers ?? {}, null, 2) + "\n", "utf8");

  const priorWorkers = (raw.workers as Record<string, unknown>) ?? {};
  const { providers: _p, classes: _c, roles: _r, mcpSets: _m, active: _a, ...rest } = priorWorkers;
  raw.workers = rest;
  writeJsonAtomic(jsonPath, raw, { label: jsonPath });

  return { yamlPath, yamlText, backupPath, dryRun: false };
}

/**
 * `pai worker config init`: write the literal commented starter (no data to
 * carry over — that is what `migrate` is for). Refuses if workers.yaml
 * already exists.
 */
export function initWorkersYaml(): string {
  const existing = workersYamlPath();
  if (existsSync(existing)) {
    throw new WorkersConfigError(
      `${existing} already exists — edit it directly, or run \`pai worker config migrate --force\` to regenerate it from the JSON config`
    );
  }
  const yamlPath = writeTargetWorkersYamlPath();
  writeWorkersYamlText(yamlPath, starterWorkersYamlText());
  return yamlPath;
}

// ---------------------------------------------------------------------------
// Relocating from an old location
// ---------------------------------------------------------------------------

export type RelocateResult = MigrateFileResult;

/** True when an old-location workers.yaml exists and nothing is at the new one yet. */
export function needsWorkersYamlRelocation(): boolean {
  return (
    !process.env.PAI_WORKERS_YAML &&
    !existsSync(defaultWorkersYamlPath()) &&
    [oldWorkersYamlPath(), legacyWorkersYamlPath()].some((p) => existsSync(p))
  );
}

/**
 * `pai worker config migrate` when workers.yaml is still at an old location
 * (~/.claude/workers.yaml or, older still, ~/.config/pai/workers.yaml): a
 * byte-for-byte copy to the new path (comments, keys, everything — this only
 * changes where the file lives), verified, then the old file is renamed
 * aside as workers.yaml.migrated-<YYYYMMDD> (never deleted). No JSON
 * involved, and no secrets are read or transformed beyond copying bytes.
 */
export function relocateWorkersYaml(opts: { force?: boolean; dryRun?: boolean } = {}): RelocateResult {
  const toPath = writeTargetWorkersYamlPath();
  const result = migratePaiFile(toPath, [oldWorkersYamlPath(), legacyWorkersYamlPath()], opts);
  if (!result.dryRun && result.fromPath) chmodSync(toPath, 0o600);
  return result;
}

// ---------------------------------------------------------------------------
// Inlining key_file contents as `key:`
// ---------------------------------------------------------------------------

export interface InlineKeysResult {
  yamlPath: string;
  inlined: { provider: string; keyFilePath: string }[];
  dryRun: boolean;
}

/**
 * `pai worker config inline-keys`: for every provider with a `key_file` and
 * no `key`, read the file, write its trimmed contents as a quoted `key:`,
 * and remove `key_file`. The key file itself is left on disk — this only
 * changes what workers.yaml reads from, never deletes a credential the
 * operator might still want. `dryRun` computes the plan (provider names and
 * key file paths only — never the key values) without writing anything.
 */
export function inlineWorkersYamlKeys(opts: { dryRun?: boolean } = {}): InlineKeysResult {
  const yamlPath = workersYamlPath();
  const existing = readWorkersYaml(yamlPath);
  if (!existing) {
    throw new WorkersConfigError(`${yamlPath} does not exist — run \`pai worker config init\` first`);
  }
  const { doc, data } = existing;
  const inlined: { provider: string; keyFilePath: string }[] = [];
  for (const [name, p] of Object.entries(data.providers)) {
    if (p.key || !p.keyFile) continue;
    const keyPath = expandHome(p.keyFile);
    let content: string;
    try {
      content = readFileSync(keyPath, "utf8");
    } catch (e) {
      throw new WorkersConfigError(
        `providers.${name}.key_file: could not read ${keyPath}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    const token = content.trim();
    if (!token) throw new WorkersConfigError(`providers.${name}.key_file: ${keyPath} is empty`);
    inlined.push({ provider: name, keyFilePath: p.keyFile });
    if (!opts.dryRun) {
      doc.setIn(["providers", name, "key"], quotedKeyNode(token));
      doc.deleteIn(["providers", name, "key_file"]);
    }
  }
  if (!opts.dryRun && inlined.length) {
    writeWorkersYamlText(yamlPath, String(doc));
  }
  return { yamlPath, inlined, dryRun: !!opts.dryRun };
}
