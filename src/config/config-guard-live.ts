/**
 * config-guard-live.ts — the real proof, reload and notice behind config-guard.ts
 * (kept apart so the guard core stays testable with injected deps).
 */

import http from "node:http";
import { loadConfig } from "../daemon/config.js";
import { readWorkersSection } from "../workers/config.js";
import { paiHomeDir } from "./pai-home.js";
import type { GuardFile, ProofDeps } from "./config-guard.js";

function httpStatus(port: number, path: string, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}

/** The proof against the live daemon, router and runtimes. */
export function liveProofDeps(): ProofDeps {
  return {
    // the same read path the daemon and router load with: main config, then the workers section (throws on a bad provider)
    load: () => {
      loadConfig();
      readWorkersSection();
    },
    daemonHealth: async () => {
      const { PaiClient } = await import("../daemon/ipc-client.js");
      await new PaiClient().status();
      return true;
    },
    routerHealth: async () => {
      const { probeRouter } = await import("../router/supervisor.js");
      return probeRouter();
    },
    routerGet: async (path) => {
      const { routerPort } = await import("../router/router.js");
      return httpStatus(routerPort(), path);
    },
    unreachableRuntimes: async () => {
      const { liveRuntimeAutostartConfig, liveRuntimeAlive } = await import("../daemon/runtime-autostart.js");
      const { isRuntimeStopped } = await import("../workers/model-runtimes.js");
      const down: string[] = [];
      for (const name of Object.keys(liveRuntimeAutostartConfig().runtimes)) {
        if (isRuntimeStopped(paiHomeDir(), name)) continue; // stopped on purpose, not "running"
        if (!(await liveRuntimeAlive(name))) down.push(name);
      }
      return down;
    },
  };
}

/** After a restore: the router re-reads what it holds in memory (config changes take effect on a router swap). */
export async function liveReload(_files: GuardFile[]): Promise<void> {
  const { routerRunningPid } = await import("../router/supervisor.js");
  if (routerRunningPid() === null) return;
  const { restartRouter } = await import("../router/restart.js");
  const { routerRestartDeps } = await import("../router/service-control.js");
  const { cliEntry } = await import("../daemon/pass-priority.js");
  await restartRouter(routerRestartDeps(cliEntry()));
}

/** One notice on PAI's operator alert path (PAILot), no router and no session in the way. */
export async function liveNotify(text: string): Promise<void> {
  const { guardedPailot } = await import("../workers/pailot-guard.js");
  const { workersLogDir } = await import("../workers/paths.js");
  await guardedPailot(workersLogDir(readWorkersSection().workers), text, async (t) => {
    try {
      const { callAiBroker } = await import("../cli/lib/aibroker-client.js");
      await callAiBroker("pailot_send", { text: t }, 8_000);
      return true;
    } catch {
      return false;
    }
  });
}
