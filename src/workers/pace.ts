/**
 * pace.ts — the pace of a usage window and the cloud-under-pace rule.
 *
 * pace = elapsed share of the window (0-100). While the weekly window of the
 * cloud provider is used less than ratio x pace, balanced mode leads t2 with
 * the cloud; above (ratio + hysteresis) x pace it goes back to local first.
 * A leaf: reads router-limits-last.json and workers.yaml `budget.cloudUnderPace`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { paiHomePath } from "../config/pai-home.js";
import { cachedParse } from "../config/parse-cache.js";
import { readLastGood } from "../router/limits.js";
import { workersYamlPath } from "./workers-config.js";

export const WINDOW_MS: Record<string, number> = { "5h": 5 * 3_600_000, "7d": 7 * 86_400_000 };

/** Elapsed share of a window in percent (0-100), null when the window has no reset time or unknown length. */
export function paceOf(name: string, resetAt: number | undefined, now: number): number | null {
  const len = WINDOW_MS[name];
  if (!len || !resetAt) return null;
  const p = (1 - (resetAt - now) / len) * 100;
  return Math.max(0, Math.min(100, p));
}

export interface PaceConfig { enabled: boolean; ratio: number; hysteresis: number; classes: string[] }
export const DEFAULT_PACE: PaceConfig = { enabled: true, ratio: 0.8, hysteresis: 0.1, classes: ["orchestrate", "plan"] };

export function readPaceConfig(yamlPath: string = workersYamlPath()): PaceConfig {
  // parsed once per file change (mtime/size): the /cockpit/limits poller hits this every second
  return cachedParse(yamlPath, () => readPaceConfigUncached(yamlPath), "pace");
}

function readPaceConfigUncached(yamlPath: string): PaceConfig {
  try {
    if (!existsSync(yamlPath)) return DEFAULT_PACE;
    const c = parseDocument(readFileSync(yamlPath, "utf8")).getIn(["budget", "cloudUnderPace"]) as { toJSON?: () => unknown } | null;
    const j = (c && typeof c.toJSON === "function" ? c.toJSON() : c) as Partial<PaceConfig> | null;
    if (!j || typeof j !== "object") return DEFAULT_PACE;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    const classes = Array.isArray(j.classes) ? j.classes.filter((x) => typeof x === "string") : DEFAULT_PACE.classes;
    return { enabled: j.enabled !== false, ratio: num(j.ratio, DEFAULT_PACE.ratio), hysteresis: num(j.hysteresis, DEFAULT_PACE.hysteresis), classes };
  } catch {
    return DEFAULT_PACE;
  }
}

export interface PaceDecision { cloud: boolean; reason: string; classes: string[] }

/** The switch with hysteresis: cloud below ratio x pace, stays cloud until used reaches (ratio + hysteresis) x pace. */
export function decidePace(used: number, pace: number, cfg: PaceConfig, wasCloud: boolean): PaceDecision {
  const low = cfg.ratio * pace;
  const high = (cfg.ratio + cfg.hysteresis) * pace;
  const r = (n: number) => Math.round(n);
  if (used < low) return { cloud: true, reason: `cloud: under pace ${r(used)} % < ${cfg.ratio} x ${r(pace)} %`, classes: cfg.classes };
  if (wasCloud && used < high) return { cloud: true, reason: `cloud: under pace ${r(used)} % < ${+(cfg.ratio + cfg.hysteresis).toFixed(2)} x ${r(pace)} % (hysteresis)`, classes: cfg.classes };
  return { cloud: false, reason: `local: used ${r(used)} % >= ${wasCloud ? +(cfg.ratio + cfg.hysteresis).toFixed(2) : cfg.ratio} x pace ${r(pace)} %`, classes: cfg.classes };
}

const stateFile = (): string => paiHomePath("logs", "pace-state.json");

/** The decision now from the last-good weekly anthropic reading; null = rule off or no window (no change). */
export function currentPace(now: number = Date.now(), opts: { cfg?: PaceConfig; limits?: ReturnType<typeof readLastGood>; persist?: boolean; wasCloud?: boolean } = {}): (PaceDecision & { used: number; pace: number }) | null {
  const cfg = opts.cfg ?? readPaceConfig();
  if (!cfg.enabled) return null;
  const w = (opts.limits ?? readLastGood()).anthropic?.windows.find((x) => x.name === "7d");
  if (!w) return null;
  const pace = paceOf("7d", w.resetAt, now);
  if (pace === null) return null;
  let was = opts.wasCloud;
  if (was === undefined) {
    try { was = (JSON.parse(readFileSync(stateFile(), "utf8")) as { cloud?: boolean }).cloud === true; } catch { was = false; }
  }
  const d = decidePace(w.percent, pace, cfg, was);
  if (opts.persist !== false && d.cloud !== was) {
    try { writeFileSync(stateFile(), JSON.stringify({ cloud: d.cloud, at: now })); } catch { /* best effort */ }
  }
  return { ...d, used: w.percent, pace };
}

/** Reason notes per loaded config, read by the route decision. */
export const paceNotes = new WeakMap<object, string>();
