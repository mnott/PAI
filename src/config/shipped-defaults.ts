/**
 * shipped-defaults.ts — the shipped defaults files (src/config/defaults/
 * config.yaml and workers.yaml, copied into dist/config/defaults/ by the
 * build) that every config loads FIRST, deep-merged UNDER the user's files.
 *
 * Operator rule (2026-10-20): policy values — thresholds, limits, intervals,
 * lists, labels, mappings — live in configuration files, never as constants
 * in code. The code keeps only the types and this loader. The user's
 * ~/.pai/config.yaml (or config.json) and ~/.pai/workers.yaml win over the
 * shipped defaults: user values win, arrays replace, objects merge.
 *
 * Values that are computed at load time rather than policy — socketPath
 * (PAI_SOCKET_PATH), postgres.connectionString (per-user database name) —
 * stay in code (src/daemon/config.ts's computedDefaults()).
 *
 * `pai config get <key> --source` reports which file a value came from
 * (getConfigSourceOp in src/config/main-config-ops.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, parseDocument, isMap, isScalar, type Node } from "yaml";
import { readDualFormatConfigRaw } from "./main-config.js";

export class ShippedDefaultsError extends Error {}

// Deep-merge over yaml Nodes (not plain JS values) so the result keeps each
// node's range: an error the caller raises against the merged document can
// still name the USER file's line (`<path>:<line>`), not a line of the
// defaults file.
function mergeNode(base: Node | undefined, over: Node | undefined): Node | undefined {
  if (over === undefined) return base;
  if (base === undefined) return over;
  if (isMap(base) && isMap(over)) {
    // mutate the base map in place: its pairs keep their ranges (and the
    // defaults' comments), a user pair replaces its key's value node
    for (const item of over.items) {
      const bi = isScalar(item.key) ? base.get(item.key.value as never, true) : undefined;
      base.set(item.key, mergeNode(bi as Node | undefined, item.value as Node | undefined));
    }
    return base;
  }
  // arrays and scalars replace (deepMergeConfig semantics)
  return over;
}

/** The shipped defaults merged under a user YAML text, as a Document whose
 *  nodes still carry the user file's line ranges. */
export function mergeYamlUnderDefaults(defaultsText: string, userText: string): Document {
  const d = parseDocument(defaultsText);
  if (d.errors.length) throw new ShippedDefaultsError(`defaults: ${d.errors[0].message}`);
  const u = parseDocument(userText);
  if (u.errors.length) throw new ShippedDefaultsError(u.errors[0].message);
  const doc = new Document(undefined);
  doc.contents = mergeNode(d.contents as Node | undefined, u.contents as Node | undefined) ?? null;
  return doc;
}

/** The shipped defaults merged under a user YAML file: defaults first, the
 *  user's file deep-merged over them (user wins, arrays replace, objects
 *  merge), as a line-numbered Document. Missing user file → the defaults
 *  alone. */
export function effectiveWorkersYamlDoc(userPath: string): Document {
  if (!existsSync(userPath)) return parseDocument(readFileSync(shippedWorkersDefaultsPath(), "utf8"));
  return mergeYamlUnderDefaults(readFileSync(shippedWorkersDefaultsPath(), "utf8"), readFileSync(userPath, "utf8"));
}

/** The directory the shipped defaults files live in: src/config/defaults/
 *  under tsx/vitest, dist/config/defaults/ once built (tsdown keeps the
 *  module's directory). A standalone bundle (dist/hooks/*.mjs) finds them one
 *  level up in config/defaults; PAI_DEFAULTS_DIR names them explicitly (an
 *  esbuild test bundle sitting in a temp dir). */
export function shippedDefaultsDir(here: string = dirname(fileURLToPath(import.meta.url))): string {
  const candidates: string[] = [];
  if (process.env.PAI_DEFAULTS_DIR) candidates.push(process.env.PAI_DEFAULTS_DIR);
  candidates.push(
    join(here, "defaults"),
    join(here, "config", "defaults"), // bundled chunk at the dist root
    join(here, "..", "config", "defaults"),
  );
  // walk up from the module to the package root (the directory holding package.json)
  let root = here;
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
  if (existsSync(join(root, "package.json"))) {
    candidates.push(join(root, "dist", "config", "defaults"), join(root, "src", "config", "defaults"));
  }
  for (const dir of candidates) if (existsSync(join(dir, "workers.yaml"))) return dir;
  throw new ShippedDefaultsError(`Shipped defaults not found; tried: ${candidates.join(", ")}`);
}

/** The shipped defaults file for the main config. */
export function shippedMainDefaultsPath(): string {
  return join(shippedDefaultsDir(), "config.yaml");
}

/** The shipped defaults file for workers.yaml. */
export function shippedWorkersDefaultsPath(): string {
  return join(shippedDefaultsDir(), "workers.yaml");
}

/** Parse a YAML mapping file; missing or empty is `{}`. */
function readYamlMapping(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ShippedDefaultsError(`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ShippedDefaultsError(`${path}: ${doc.errors[0].message}`);
  const parsed = doc.toJS();
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ShippedDefaultsError(`${path}: top level must be a mapping`);
  }
  return parsed as Record<string, unknown>;
}

/** Deep-merge `over` onto `base`: user values win, arrays replace, objects
 *  merge recursively. `null` in `over` replaces the base value (it is a real
 *  YAML value, e.g. `active: null`); only `undefined` is skipped. */
export function deepMergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(over)) {
    const srcVal = over[key];
    if (srcVal === undefined) continue;
    const tgtVal = result[key];
    if (
      typeof srcVal === "object" &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMergeConfig(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/** The shipped main-config defaults (defaults/config.yaml). */
export function shippedMainDefaults(): Record<string, unknown> {
  return readYamlMapping(shippedMainDefaultsPath());
}

/** The shipped workers.yaml defaults (defaults/workers.yaml). */
export function shippedWorkersDefaults(): Record<string, unknown> {
  return readYamlMapping(shippedWorkersDefaultsPath());
}

/**
 * The shipped defaults merged under the user's main config: defaults first,
 * the user's config.yaml (or config.json) deep-merged over them. Missing user
 * file → the defaults alone. `path` overrides the user JSON location (tests).
 */
export function effectiveMainConfig(path: string): Record<string, unknown> {
  const defaults = shippedMainDefaults();
  const userPath = join(dirname(path), "config.yaml");
  const user = existsSync(userPath) || existsSync(path) ? readDualFormatConfigRaw(path) : {};
  return deepMergeConfig(defaults, user);
}

/**
 * The shipped defaults merged under the user's workers.yaml: defaults first,
 * the user's file deep-merged over them, as a plain mapping. Missing user
 * file → the defaults alone. Callers validate the result with their own
 * parser (parseWorkersYamlDocument) — this module stays free of workers/
 * imports so workers-config.ts can import it without a cycle.
 */
export function effectiveWorkersYamlRaw(userPath: string): Record<string, unknown> {
  return deepMergeConfig(shippedWorkersDefaults(), userWorkersYamlRaw(userPath));
}

/** The user's workers.yaml exactly as written — `{}` when the file is
 *  missing. `pai config get --source` needs the raw file to tell a
 *  user-set value from a defaults-only one. */
export function userWorkersYamlRaw(userPath: string): Record<string, unknown> {
  return existsSync(userPath) ? readYamlMapping(userPath) : {};
}
