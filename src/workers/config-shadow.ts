/**
 * config-shadow.ts — where each `workers` setting is really read from.
 *
 * Merge order (readWorkersSection in config.ts):
 *   1. shipped defaults/workers.yaml `workers:` block   (defaultWorkersConfig)
 *   2. config.yaml `workers:` block over it             (parseWorkersConfig)
 *   3. workers.yaml supplies ONLY the routing tables: providers, tiers,
 *      capabilities, active, classes, mcp_sets — it replaces what config.yaml
 *      holds for those keys.
 * So a non-provider setting (pool, pane, routing, …) has exactly one source,
 * config.yaml; anything else in workers.yaml is never read. And the routing
 * tables have exactly one source, workers.yaml. This module reports every
 * key written in the wrong file (or nowhere read) so validate can name it.
 *
 * One exception: `writeWorkersSection` mirrors `tiers` into config.yaml's
 * `workers.tiers` on every write, so a config.yaml routing key equal to the
 * effective workers.yaml value is that deliberate mirror, not a shadow — only
 * a differing value is reported (naming both, and which one is effective).
 */

import { existsSync } from "node:fs";
import { deepEqualJson } from "../config/yaml-store.js";
import { readDualFormatConfigRaw } from "../config/main-config.js";
import { effectiveWorkersYamlRaw, shippedWorkersDefaults, userWorkersYamlRaw } from "../config/shipped-defaults.js";
import { paiConfigFilePath } from "../daemon/config.js";
import {
  ANTHROPIC_NATIVE,
  isLocalProvider,
  parseCapabilitiesValue,
  parseClassesValue,
  parseMcpSetsValue,
  parseModelsBlock,
  parseProvider,
} from "./config.js";
import { parseTiersValue } from "./route-lists.js";
import { workersYamlPath } from "./workers-config.js";

/** Top-level workers.yaml keys the runtime reads from the user file. */
export const WORKERS_YAML_READ_KEYS: readonly string[] = [
  "providers", "tiers", "capabilities", "active", "classes", "mcp_sets",
  "local_launcher", "local_tiers", "prices", "local", "orchestratorModel",
  // workers.priority.sessions: queue admission priority per named session
  // (readWorkersSection parses it; `pai worker priority` writes it)
  "workers",
];

/** config.yaml `workers.<key>` entries that workers.yaml replaces when it exists. */
const MAIN_SHADOWED_BY_YAML: readonly string[] = ["providers", "tiers", "capabilities", "active", "classes", "mcpSets"];

export interface ConfigShadow {
  /** the file holding the ineffective value */
  file: "config.yaml" | "workers.yaml";
  /** dotted key inside that file */
  key: string;
  /** where the effective value lives, as file:key */
  effective: string;
  /** the ineffective value (an edit that changes it is refused by the editor) */
  value: unknown;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function leaves(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isObj(v) && Object.keys(v).length) for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  else if (prefix) out.set(prefix, v);
}

/** A provider map as the runtime sees it: the builtin `anthropic` block is
 *  native models, not a provider entry; a malformed entry compares as written
 *  (validate reports it through its own loader). */
function effectiveProviders(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isObj(raw)) return out;
  for (const [name, p] of Object.entries(raw)) {
    if (name === ANTHROPIC_NATIVE) {
      try {
        const builtin = isObj(p) ? p : {};
        out[name] = { builtin: true, models: builtin.models === undefined ? {} : parseModelsBlock(`providers.${name}.models`, builtin.models) };
      } catch {
        out[name] = p;
      }
      continue;
    }
    try {
      out[name] = parseProvider(name, p);
    } catch {
      out[name] = p;
    }
  }
  return out;
}

/** The effective value of a config.yaml routing key — what workers.yaml
 *  supplies at read time: the shipped defaults merged under the user file,
 *  parsed the way the reader parses (so a mirrored copy written by
 *  writeWorkersSection compares equal to the file it mirrors). Classes and
 *  mcpSets stand from config.yaml when workers.yaml names none, exactly as
 *  readWorkersSection applies them. */
function effectiveRoutingValue(key: string, mainWorkers: Record<string, unknown>, merged: Record<string, unknown>, yamlPath: string): unknown {
  const local = (): string | null =>
    Object.entries(effectiveProviders(merged.providers)).find(([, p]) => isObj(p) && p.enabled === true && p.engine !== "image" && isLocalProvider(String(p.baseUrl ?? "")))?.[0] ?? null;
  try {
    switch (key) {
      case "providers":
        return effectiveProviders(merged.providers);
      case "tiers":
        return parseTiersValue(merged.tiers, "tiers", local());
      case "capabilities":
        return parseCapabilitiesValue(merged.capabilities, "capabilities");
      case "active":
        return merged.active === undefined || merged.active === null ? null : String(merged.active);
      case "classes": {
        const c = parseClassesValue(merged.classes, "classes");
        return Object.keys(c).length ? c : mainWorkers.classes;
      }
      case "mcpSets": {
        const s = parseMcpSetsValue(merged.mcp_sets, "mcp_sets");
        return Object.keys(s).length ? s : mainWorkers.mcpSets;
      }
      default:
        return undefined;
    }
  } catch {
    // a workers.yaml value that fails to parse is the file's own load error;
    // compare against the raw merged value instead
    return key === "mcpSets" ? merged.mcp_sets : merged[key];
  }
}

function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split(".")) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Shadowed / unused keys given the two files as written. `workersRaw` null =
 * no workers.yaml on disk (nothing in it to shadow, nothing shadowing config.yaml).
 * `yamlPath` is the workers.yaml the effective routing values are read from
 * (the shipped defaults merged under it); defaults stand when it is absent.
 */
export function workersConfigShadows(
  mainRaw: Record<string, unknown>,
  workersRaw: Record<string, unknown> | null,
  yamlPath: string = workersYamlPath(),
): ConfigShadow[] {
  const out: ConfigShadow[] = [];
  const mainWorkers = isObj(mainRaw.workers) ? mainRaw.workers : {};
  if (workersRaw) {
    const l = new Map<string, unknown>();
    leaves(workersRaw.workers, "", l);
    for (const [path, value] of l) {
      const full = `workers.${path}`;
      const inMain = getPath(mainWorkers, path) !== undefined;
      out.push({
        file: "workers.yaml", key: full, effective: `config.yaml:${full}`, value,
        message: `workers.yaml:${full} is ignored — the runtime reads ${full} from config.yaml${inMain ? " (which also sets it and wins)" : ""}; set it there (pai config set ${full} <value>)`,
      });
    }
    for (const [k, value] of Object.entries(workersRaw)) {
      if (k === "workers" || WORKERS_YAML_READ_KEYS.includes(k)) continue;
      out.push({
        file: "workers.yaml", key: k, effective: "(none)", value,
        message: `workers.yaml:${k} is unused — nothing reads a top-level "${k}" block${k === "pool" ? "; the session pool is config.yaml:workers.pool (enabled, maxSlots, idleSecs, …)" : ""}`,
      });
    }
    // The effective routing tables: shipped defaults merged under the user file.
    // The user file is re-read from `yamlPath` when it exists (the caller's raw
    // may be a candidate text, not the file on disk); `{}` when it does not.
    const merged = existsSync(yamlPath)
      ? effectiveWorkersYamlRaw(yamlPath)
      : { ...shippedWorkersDefaults(), ...workersRaw };
    for (const k of MAIN_SHADOWED_BY_YAML) {
      if (mainWorkers[k] === undefined) continue;
      const yk = k === "mcpSets" ? "mcp_sets" : k;
      // a value equal to the effective one is the mirror writeWorkersSection
      // writes on every save — noise, not a shadow; only a differing value warns
      if (deepEqualJson(mainWorkers[k], effectiveRoutingValue(k, mainWorkers, merged, yamlPath))) continue;
      out.push({
        file: "config.yaml", key: `workers.${k}`, effective: `workers.yaml:${yk}`, value: mainWorkers[k],
        message: `config.yaml:workers.${k} differs from workers.yaml:${yk} — workers.yaml:${yk} is effective (config.yaml holds ${JSON.stringify(mainWorkers[k])}, workers.yaml holds ${JSON.stringify(effectiveRoutingValue(k, mainWorkers, merged, yamlPath))})`,
      });
    }
  }
  return out;
}

/** The live pair of files (paths resolve like the runtime's). Unreadable config.yaml counts as empty. */
export function liveWorkersConfigShadows(mainPath: string = paiConfigFilePath(), yamlPath: string = workersYamlPath()): ConfigShadow[] {
  let main: Record<string, unknown> = {};
  try {
    main = readDualFormatConfigRaw(mainPath);
  } catch {
    /* a damaged main config is reported by its own loader */
  }
  return workersConfigShadows(main, existsSync(yamlPath) ? userWorkersYamlRaw(yamlPath) : null, yamlPath);
}

let loggedOnce = false;

/** Daemon start: one stderr line per shadowed key, at most once per process. */
export function logWorkersConfigShadowsOnce(write: (line: string) => void = (l) => process.stderr.write(l)): void {
  if (loggedOnce) return;
  loggedOnce = true;
  try {
    for (const s of liveWorkersConfigShadows()) write(`[pai-daemon] config warning: ${s.message}\n`);
  } catch {
    /* diagnostics must never stop the daemon */
  }
}

export function resetWorkersConfigShadowLogForTest(): void {
  loggedOnce = false;
}
