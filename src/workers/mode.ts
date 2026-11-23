/**
 * mode.ts — the speed | balanced | budget switch (`pai worker mode`).
 *
 * One word in workers.yaml (`mode:`, top level) picks how the delegation tiers
 * are used. It is applied as an override on top of the loaded tiers (applyMode),
 * never by rewriting the user's `tiers:`:
 *
 *   balanced  today's behaviour: t2 = local first, cloud on takeover; L1 = sonnet
 *   speed     t2 = anthropic/sonnet first, children of an L1 = anthropic/haiku, no local model
 *   budget    t2 = local only; cloud only as L1 and as takeover (the tier above) after a failed retry
 *
 * An open session urgency window (`/now`, urgency_set) acts as `speed` for that
 * session (effectiveMode). A leaf apart from the yaml helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { Document, parseDocument } from "yaml";
import { currentPace, paceNotes } from "./pace.js";
import { readUrgency } from "./urgency.js";
import { entryProvider, findTier, type TierDef } from "./route-lists.js";
import { WorkersConfigError, isLocalProvider } from "./config.js";
import { workersYamlPath, writeWorkersYamlText } from "./workers-config.js";

export const WORK_MODES = ["speed", "balanced", "budget"] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export const DEFAULT_WORK_MODE: WorkMode = "balanced";

/** What each mode means, one line each (help text, the MCP tool, `pai worker mode`). */
export const MODE_SUMMARY: Record<WorkMode, string> = {
  speed: "t2 = anthropic/sonnet first, L1 children = anthropic/haiku, no local model",
  balanced: "t2 = local first, anthropic/sonnet on takeover; L1 = anthropic/sonnet (default)",
  budget: "t2 = local only; cloud only as L1 and as takeover after a failed retry",
};

export const isWorkMode = (v: unknown): v is WorkMode => typeof v === "string" && (WORK_MODES as readonly string[]).includes(v);

/** The persisted mode of workers.yaml; balanced when unset. A bad value is an error naming the file. */
export function readMode(yamlPath: string = workersYamlPath()): WorkMode {
  if (!existsSync(yamlPath)) return DEFAULT_WORK_MODE;
  const doc = parseDocument(readFileSync(yamlPath, "utf8"));
  const v = doc.get("mode");
  if (v === undefined || v === null) return DEFAULT_WORK_MODE;
  if (!isWorkMode(v)) throw new WorkersConfigError(`${yamlPath}: mode must be ${WORK_MODES.join(", ")} (got "${String(v)}")`);
  return v;
}

/** Persist the mode (comment-preserving; balanced is written explicitly too, so the file shows the choice). */
export function writeMode(mode: WorkMode, yamlPath: string = workersYamlPath()): void {
  if (!isWorkMode(mode)) throw new WorkersConfigError(`mode must be ${WORK_MODES.join(", ")} (got "${String(mode)}")`);
  const doc = existsSync(yamlPath) ? parseDocument(readFileSync(yamlPath, "utf8")) : new Document({});
  if (doc.errors.length) throw new WorkersConfigError(`${yamlPath}: ${doc.errors[0].message}`);
  const before = String(doc);
  doc.set("mode", mode);
  if (existsSync(yamlPath) && String(doc) === before) return;
  writeWorkersYamlText(yamlPath, String(doc));
}

/** The mode in force: an open (non-local) urgency window of the calling session is `speed`, else the persisted one. */
export function effectiveMode(env: NodeJS.ProcessEnv = process.env, yamlPath?: string): { mode: WorkMode; source: "urgency" | "config" } {
  const u = readUrgency(env);
  if (u && !u.where) return { mode: "speed", source: "urgency" };
  return { mode: readMode(yamlPath), source: "config" };
}

export interface ModeCtx {
  /** Does this tier entry name a local (loopback) model? */
  isLocal: (entry: string) => boolean;
  /** The run is a child of an L1 (orchestrate) worker. */
  underOrchestrator?: boolean;
  /** balanced only: the weekly window is under pace, so t2 leads with the cloud (pace.ts). */
  cloudFirst?: boolean;
}

const SONNET = "anthropic/sonnet";
const HAIKU = "anthropic/haiku";

/** The tiers as `mode` sees them. Pure: returns new tier objects, the input is untouched. */
export function applyMode(tiers: TierDef[], mode: WorkMode, ctx: ModeCtx): TierDef[] {
  const worker = findTier(tiers, "implement");
  if (mode === "balanced") {
    if (!ctx.cloudFirst || !worker || !worker.models.includes(SONNET) || worker.models[0] === SONNET) return tiers;
    return tiers.map((t) => (t.id === worker.id && !t.session ? { ...t, models: [SONNET, ...t.models.filter((e) => e !== SONNET)] } : t));
  }
  return tiers.map((t) => {
    if (t.session) return t;
    const isWorker = worker !== undefined && t.id === worker.id;
    if (mode === "budget") {
      if (!isWorker) return t;
      const locals = t.models.filter(ctx.isLocal);
      return locals.length ? { ...t, models: locals } : t;
    }
    // speed: no local model in any non-session chain; the worker tier leads with sonnet (haiku under an L1)
    const cloud = t.models.filter((e) => !ctx.isLocal(e));
    if (!isWorker) return cloud.length ? { ...t, models: cloud } : t;
    const first = ctx.underOrchestrator ? HAIKU : SONNET;
    return { ...t, models: [first, ...cloud.filter((e) => e !== first)] };
  });
}

/** `pai worker mode` / status-line text: "mode: balanced (t2 = …)". */
export function modeLine(mode: WorkMode, source: "urgency" | "config" = "config"): string {
  return `mode: ${mode}${source === "urgency" ? " (urgency window)" : ""} — ${MODE_SUMMARY[mode]}`;
}

/**
 * Apply the mode in force to a loaded config's tiers, in place (the run's own copy). The session's
 * explicit route rows are applied after this, so they still win. Returns the mode used.
 */
export function applyModeToConfig(
  config: { tiers: TierDef[]; providers: Record<string, { baseUrl: string }> },
  env: NodeJS.ProcessEnv = process.env
): WorkMode {
  const { mode } = effectiveMode(env);
  const pace = mode === "balanced" ? currentPace() : null;
  if (pace) paceNotes.set(config, pace.reason);
  config.tiers = applyMode(config.tiers, mode, {
    cloudFirst: pace?.cloud === true,
    isLocal: (e) => isLocalProvider(config.providers[entryProvider(e)]?.baseUrl ?? ""),
    underOrchestrator: env.PAI_WORKER_ORCHESTRATOR === "1",
  });
  return mode;
}
