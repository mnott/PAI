import type { LocalConfig, LocalTier } from "../workers/local-tiers.js";

export interface RegistryInstanceRow {
  id: string;
  model: string;
  port: number;
  pid?: number;
  state: string;
  inflight: number;
}

export interface RegistryModel {
  name: string;
  file: string;
  engine: string;
  port: number;
  tier: string;
  state: "running" | "starting" | "failed" | "stopping" | "stopped";
  instances: Array<{ id: string; pid?: number; port: number; inflight: number }>;
  maxInstances: number;
}

/** What the entry serves: the model file itself (Strata config, serve script or model path). Two tiers on one engine differ here. */
export function modelFile(t: LocalTier): string {
  return t.config ?? t.start ?? t.model;
}

function stateOf(rows: RegistryInstanceRow[]): RegistryModel["state"] {
  for (const s of ["ready", "starting", "stopping", "failed"] as const) {
    if (rows.some((r) => r.state === s)) return s === "ready" ? "running" : s;
  }
  return "stopped";
}

/**
 * One entry per registry model, stopped ones included. An instance belongs to
 * the entry whose model FILE equals the file of the instance's own tier; the
 * engine is only a badge (gyro-m and iq3s share the Strata engine).
 */
export function registryModels(cfg: LocalConfig, instances: RegistryInstanceRow[]): RegistryModel[] {
  return Object.values(cfg.tiers).map((t) => {
    const file = modelFile(t);
    const mine = instances.filter((i) => {
      const own = cfg.tiers[i.model];
      return own ? modelFile(own) === file : false;
    });
    return {
      name: t.tier,
      file,
      engine: t.engine,
      port: t.port,
      tier: t.tier,
      state: stateOf(mine),
      instances: mine.map((i) => ({ id: i.id, ...(i.pid !== undefined ? { pid: i.pid } : {}), port: i.port, inflight: i.inflight })),
      maxInstances: t.maxInstances,
    };
  });
}
