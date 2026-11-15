/**
 * The status line's "workers: ..." label. A pinned/env/fallback resolution
 * names its provider; global routing has none, so the label is the default
 * tier's serving entry (route-table: routeRows + servingChip via tierFlow,
 * the value `pai worker route` prints). Liveness probes of local providers
 * sit behind a 30 s file cache under the workers log dir. Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkersConfig } from "../config.js";
import type { WorkersResolution } from "../session-profile.js";
import { routeRows, tierFlow } from "../route-table.js";

export const ROUTE_LABEL_TTL_MS = 30_000;

export const routeLabelCachePath = (logDir: string): string => join(logDir, "status-route-label.json");

export function readRouteLabelCache(path: string, now: number = Date.now()): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const j = JSON.parse(readFileSync(path, "utf8")) as { label?: unknown; at?: unknown };
    if (typeof j.at !== "number" || now - j.at > ROUTE_LABEL_TTL_MS || typeof j.label !== "string") return undefined;
    return j.label;
  } catch {
    return undefined;
  }
}

export function writeRouteLabelCache(path: string, label: string, now: number = Date.now()): void {
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, JSON.stringify({ label, at: now }), "utf8");
  } catch {
    // best effort
  }
}

/** The default tier's serving entry ("local gyro-m"), or "none available". */
export async function defaultTierLabel(workers: WorkersConfig, logDir: string): Promise<string | undefined> {
  const tier = workers.tiers.find((t) => t.default);
  if (!tier) return undefined;
  const rows = await routeRows({ ...workers, tiers: [tier] }, { logDir });
  return tierFlow(rows)[0]?.resolved ?? "none available";
}

/** "provider[/model]" for a pinned resolution, the default tier's label under global routing; undefined: no label. */
export async function workersLabel(
  r: Pick<WorkersResolution, "provider" | "model">,
  workers: WorkersConfig,
  logDir: string,
  compute: (w: WorkersConfig, d: string) => Promise<string | undefined> = defaultTierLabel,
  now: number = Date.now()
): Promise<string | undefined> {
  if (r.provider) return `${r.provider}${r.model && r.model !== "default" ? `/${r.model}` : ""}`;
  try {
    const path = routeLabelCachePath(logDir);
    const hit = readRouteLabelCache(path, now);
    if (hit) return hit;
    const label = await compute(workers, logDir);
    if (label) writeRouteLabelCache(path, label, now);
    return label;
  } catch {
    return undefined;
  }
}
