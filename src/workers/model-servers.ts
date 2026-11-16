/**
 * model-servers.ts — which local model servers are RUNNING, one entry per server.
 *
 * Several configs can share one port (gyro-l and gyro-m on 8035: only one runs at a
 * time), so the ps command-line signatures of `parseServers` list the same server
 * twice — the server.py parent and its engine child, each matched by its own tier.
 * The truth is the port: a model server runs where something LISTENS, one entry per
 * listening pid, named by what it actually serves (the first id GET /v1/models
 * reports, the way `pai models` names it). A port that answers HTTP with no listener
 * of its own still counts — the probe wins over lsof.
 */
import { execFileSync } from "node:child_process";
import { isLocalProvider, readWorkersSection } from "./config.js";
import { fetchServedModels, readLocalConfig, type LocalTier } from "./local-tiers.js";
import { workersYamlPath } from "./workers-config.js";

export interface ModelServerTarget {
  port: number;
  /** Config names of every provider/tier whose url or base port is this port (first = the tier's own provider). */
  names: string[];
}

export interface ModelServersDeps {
  listeners: (port: number) => number[];
  servedIds: (port: number) => Promise<string[] | null>;
}

/** Pids listening on a loopback TCP port (empty when none or lsof is missing). */
function realListeners(port: number): number[] {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const realDeps: ModelServersDeps = { listeners: realListeners, servedIds: (p) => fetchServedModels(p) };

/** Every port a loopback provider or a local tier claims, with the config names that share it. */
export function modelServerPorts(
  providers: Record<string, { baseUrl?: string }>,
  tiers: Pick<LocalTier, "port" | "provider">[],
): ModelServerTarget[] {
  const byPort = new Map<number, string[]>();
  const add = (port: number, name: string): void => {
    if (!port) return;
    const names = byPort.get(port) ?? [];
    if (!names.includes(name)) names.push(name);
    byPort.set(port, names);
  };
  for (const [name, p] of Object.entries(providers)) {
    if (!p.baseUrl || !isLocalProvider(p.baseUrl)) continue;
    let port = 0;
    try {
      port = Number(new URL(p.baseUrl).port);
    } catch {
      /* unparseable url: not a local server */
    }
    add(port, name);
  }
  for (const t of tiers) add(t.port, t.provider || `port ${t.port}`);
  return [...byPort.entries()].map(([port, names]) => ({ port, names }));
}

/** The running servers among `ports`: one per listening pid (or per answering port with no listener), named by the served id. */
export async function detectModelServers(ports: ModelServerTarget[], deps: ModelServersDeps = realDeps): Promise<{ pid: number; label: string }[]> {
  const out = await Promise.all(
    ports.map(async ({ port, names }): Promise<{ pid: number; label: string } | null> => {
      const ids = await deps.servedIds(port);
      if (!ids) return null; // nothing serves here: a configured model that is not running
      const pids = [...new Set(deps.listeners(port))].sort((a, b) => a - b);
      const served = ids[0]?.toLowerCase();
      const named = served ? names.find((n) => n.toLowerCase() === served) : undefined;
      const label = `${named ?? names[0] ?? `port ${port}`}:${port}${ids[0] && ids[0] !== named ? ` serving ${ids[0]}` : ""}`;
      if (pids.length) return { pid: pids[0], label };
      // answers HTTP but no listener was found (lsof missing, or another user's process): the probe still says it runs — a ps-signature pid is the best we have
      const { listServers } = await import("../cli/commands/worker-config.js");
      const live = listServers(readLocalConfig(workersYamlPath())).find((s) => s.port === port);
      return live ? { pid: live.pid, label } : null;
    }),
  );
  return out.filter((x): x is { pid: number; label: string } => x !== null);
}

/** The running local model servers, named by what they serve — `pai freeze`'s model list. */
export async function runningModelServers(): Promise<{ pid: number; label: string }[]> {
  const section = readWorkersSection().workers;
  return detectModelServers(modelServerPorts(section.providers ?? {}, Object.values(readLocalConfig(workersYamlPath()).tiers)));
}
