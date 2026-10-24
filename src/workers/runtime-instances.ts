/**
 * runtime-instances.ts — `pai models start|stop <runtime>` keep the managed
 * instance registry (local-instances.json, the cockpit Endpoints card and the
 * router's endpoints) in step. Only a runtime that is also a workers.yaml
 * provider with a loopback url is an endpoint (ollama and the like are not).
 */

import { portListeners, readInstances, writeInstances, type LocalInstance } from "./local-instances.js";
import { runtimeLogFile } from "./model-runtimes.js";

export interface RuntimeInstanceDeps {
  logDir: string;
  home: string;
  /** the runtime's provider url (workers.yaml), absent when the runtime is no provider */
  providerUrl?: string;
  /** pid listening on a port; default lsof */
  listenerPid?: (port: number) => number | undefined;
  now?: () => number;
}

const portOf = (url: string | undefined): number | null => {
  if (!url || !URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
  const p = Number(u.port);
  return p > 0 ? p : null;
};

/** Record the outcome of a runtime op: a successful start writes `<runtime>#1` (replacing whatever row held its port), a stop removes the runtime's row. */
export function syncRuntimeInstance(runtime: string, op: "start" | "stop", ok: boolean, d: RuntimeInstanceDeps): void {
  const port = portOf(d.providerUrl);
  if (port === null) return;
  const rows = readInstances(d.logDir);
  const id = `${runtime}#1`;
  if (op === "stop") {
    if (!ok) return;
    const kept = rows.filter((r) => !(r.origin === "managed" && r.model === runtime));
    if (kept.length !== rows.length) writeInstances(d.logDir, kept);
    return;
  }
  if (!ok) return;
  const pid = (d.listenerPid ?? ((p) => portListeners(p)[0]))(port);
  const row: LocalInstance = {
    id, model: runtime, provider: runtime, url: `http://127.0.0.1:${port}`, origin: "managed", port,
    ...(pid ? { pid } : {}), state: "ready", startedAt: (d.now ?? Date.now)(), log: runtimeLogFile(d.home, runtime),
  };
  const kept = rows.filter((r) => !(r.origin === "managed" && (r.id === id || r.port === port)));
  writeInstances(d.logDir, [...kept, row].sort((a, b) => a.model.localeCompare(b.model)));
}
