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
 */

import { existsSync } from "node:fs";
import { readDualFormatConfigRaw } from "../config/main-config.js";
import { userWorkersYamlRaw } from "../config/shipped-defaults.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { workersYamlPath } from "./workers-config.js";

/** Top-level workers.yaml keys the runtime reads from the user file. */
export const WORKERS_YAML_READ_KEYS: readonly string[] = [
  "providers", "tiers", "capabilities", "active", "classes", "mcp_sets",
  "local_launcher", "local_tiers", "prices", "local", "orchestratorModel",
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
 */
export function workersConfigShadows(mainRaw: Record<string, unknown>, workersRaw: Record<string, unknown> | null): ConfigShadow[] {
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
    for (const k of MAIN_SHADOWED_BY_YAML) {
      if (mainWorkers[k] === undefined) continue;
      const yk = k === "mcpSets" ? "mcp_sets" : k;
      out.push({
        file: "config.yaml", key: `workers.${k}`, effective: `workers.yaml:${yk}`, value: mainWorkers[k],
        message: `config.yaml:workers.${k} is shadowed by workers.yaml — the routing tables are read from workers.yaml:${yk}`,
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
  return workersConfigShadows(main, existsSync(yamlPath) ? userWorkersYamlRaw(yamlPath) : null);
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
