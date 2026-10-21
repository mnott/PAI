/**
 * local-instances.ts — the running instances of local models.
 *
 * An instance is one server process of a catalogue model (a `local_tiers:`
 * entry) on its own port. The source of truth is the running processes
 * (`parseServers`); `<logDir>/local-instances.json` adds what ps cannot know
 * (start time, log, failure). Processes win: `reconcileInstances` drops a row
 * whose pid is gone and adopts a catalogue server that has no row.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseServers, resolveModelPath, type LocalConfig, type RunningServer } from "./local-tiers.js";

export type InstanceState = "starting" | "ready" | "failed" | "stopping";

/** What an endpoint is good for; every field optional, declared in workers.yaml for registered endpoints. */
export interface InstanceCharacteristics {
  classes?: string[];
  contextTokens?: number;
  tags?: string[];
}

export interface LocalInstance {
  /** `<model>#<n>` for managed instances, the provider name for registered ones */
  id: string;
  /** catalogue name (the `local_tiers:` key), or the provider name for a registered endpoint */
  model: string;
  provider: string;
  /** http://host:port — managed instances are loopback, registered ones may be on another machine */
  url: string;
  /** managed: PAI started it here (has a pid); registered: a provider entry with a url, health by probe */
  origin: "managed" | "registered";
  port: number;
  /** managed only */
  pid?: number;
  state: InstanceState;
  /** epoch ms */
  startedAt: number;
  log: string;
  error?: string;
  characteristics?: InstanceCharacteristics;
}

export const localInstancesPath = (logDir: string): string => join(logDir, "local-instances.json");

export function readInstances(logDir: string): LocalInstance[] {
  const path = localInstancesPath(logDir);
  if (!existsSync(path)) return [];
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(j) ? (j as LocalInstance[]).filter((r) => r && typeof r.id === "string" && typeof r.model === "string") : [];
  } catch {
    return [];
  }
}

/** Atomic write (tmp + rename). */
export function writeInstances(logDir: string, rows: LocalInstance[]): void {
  const path = localInstancesPath(logDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Router / scheduler engine key: n=1 keeps the bare provider name, later copies are `<provider>#<n>`. */
export function engineKey(provider: string, n: number): string {
  return n <= 1 ? provider : `${provider}#${n}`;
}

/** The n of an instance id `<model>#<n>` (1 when it carries none). */
export function instanceNumber(id: string): number {
  const m = /#(\d+)$/.exec(id);
  return m ? Number(m[1]) : 1;
}

export function instanceEngineKey(i: Pick<LocalInstance, "id" | "provider">): string {
  return engineKey(i.provider, instanceNumber(i.id));
}

/** vllm-mlx servers on a port no tier names (a second copy): the tier is the one whose model path the command serves. */
function vllmByModelPath(psOut: string, cfg: LocalConfig, selfPid: number, byPath: Map<string, string>): RunningServer[] {
  const out: RunningServer[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === selfPid) continue;
    const cmd = m[3];
    const sv = /\bserve\s+(\S+)/.exec(cmd);
    const pm = /--port\s+(\d+)/.exec(cmd);
    if (!sv || !pm || !cmd.includes(cfg.launcher.processMatch)) continue;
    const tier = byPath.get(sv[1]);
    if (!tier) continue;
    out.push({ pid: Number(m[1]), rssKb: Number(m[2]), port: Number(pm[1]), tier, provider: cfg.tiers[tier].provider });
  }
  return out;
}

/** Servers of catalogue models, one per (model, port): the engine child of a Strata server is folded into its server. */
export function instancesFromProcesses(
  psOut: string,
  cfg: LocalConfig,
  listeners: Record<number, number[]> = {},
  selfPid = process.pid,
): RunningServer[] {
  const seen = new Set<string>();
  const out: RunningServer[] = [];
  const byPath = new Map<string, string>();
  for (const t of Object.values(cfg.tiers)) if (t.engine === "vllm-mlx") byPath.set(resolveModelPath(t.model), t.tier);
  for (const s of [...parseServers(psOut, cfg, selfPid, listeners), ...vllmByModelPath(psOut, cfg, selfPid, byPath)]) {
    if (!s.tier || s.port === null) continue;
    const key = `${s.tier}:${s.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Join state rows with the live servers. A row follows its pid, else its
 * port; a live server without a row is adopted as `ready` under the smallest
 * free `<model>#<n>`. Rows with no live server are dropped, except `failed`
 * ones (kept until the next start dismisses them).
 */
export function reconcileInstances(
  rows: LocalInstance[],
  servers: RunningServer[],
  cfg: LocalConfig,
  now = Date.now(),
): LocalInstance[] {
  const out: LocalInstance[] = [];
  const used = new Set<string>();
  const claimed = new Set<RunningServer>();
  for (const r of rows) {
    if (r.origin === "registered") continue;
    if (r.state === "failed") {
      out.push(r);
      used.add(r.id);
      continue;
    }
    const s = servers.find((x) => !claimed.has(x) && x.tier === r.model && (x.pid === r.pid || x.port === r.port));
    if (!s) continue;
    claimed.add(s);
    out.push({ ...r, pid: s.pid, port: s.port ?? r.port });
    used.add(r.id);
  }
  for (const s of servers) {
    if (claimed.has(s) || !s.tier || s.port === null) continue;
    const tier = cfg.tiers[s.tier];
    if (!tier) continue;
    let n = 1;
    while (used.has(`${s.tier}#${n}`)) n++;
    const id = `${s.tier}#${n}`;
    used.add(id);
    out.push({ id, model: s.tier, provider: tier.provider, url: `http://127.0.0.1:${s.port}`, origin: "managed", port: s.port, pid: s.pid, state: "ready", startedAt: now, log: "" });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model) || instanceNumber(a.id) - instanceNumber(b.id));
}

export interface RegisteredProvider {
  url?: string;
  characteristics?: InstanceCharacteristics;
}

/**
 * Endpoints declared in workers.yaml `providers:` with a url that no catalogue
 * model launches: no pid, health is a probe (state `ready` until one says
 * otherwise). Loopback or another machine alike.
 */
export function registeredInstances(providers: Record<string, RegisteredProvider>, cfg: LocalConfig): LocalInstance[] {
  const launched = new Set(Object.values(cfg.tiers).map((t) => t.provider));
  const out: LocalInstance[] = [];
  for (const [name, p] of Object.entries(providers)) {
    if (!p.url || launched.has(name)) continue;
    const port = /:(\d+)(?:\/|$)/.exec(p.url)?.[1];
    out.push({
      id: name, model: name, provider: name, url: p.url.replace(/\/+$/, ""), origin: "registered",
      port: port ? Number(port) : 0, state: "ready", startedAt: 0, log: "",
      ...(p.characteristics ? { characteristics: p.characteristics } : {}),
    });
  }
  return out;
}
