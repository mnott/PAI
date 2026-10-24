/**
 * service-control.ts — start, stop, restart and status of the background router.
 *
 * One implementation for `pai router start|stop|restart|status` and the
 * router_service MCP tool. Each function returns the line the CLI prints.
 */

import { rmSync, unlinkSync } from "node:fs";
import { PaiClient } from "../daemon/ipc-client.js";
import { loadConfig } from "../daemon/config.js";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { pidAlive } from "../workers/status.js";
import { restartRouter } from "./restart.js";
import { checkUpstream, restarterLookup } from "./preflight.js";
import { routerPort } from "./router.js";
import { abortedHost, abortedText, probeRouter, readHandoverStatus, routerHandoverStatusFile, routerLogFile, routerPidFile, routerRunningPid, routerSwapArgs, spawnRouter, startHandover } from "./supervisor.js";

export function routerStartText(cliEntry: string): string {
  const pid = routerRunningPid();
  if (pid) return `router already running (pid ${pid})`;
  const started = spawnRouter(cliEntry);
  return `router starting on ${LOOPBACK_HOST}:${routerPort()} (pid ${started}), log ${routerLogFile()}`;
}

export function routerStopText(): string {
  const pid = routerRunningPid();
  if (!pid) return "router not running";
  process.kill(pid, "SIGTERM");
  try {
    unlinkSync(routerPidFile());
  } catch {
    /* already gone */
  }
  return `router stopped (pid ${pid})`;
}

/** Deps shared by every restarter (CLI, daemon): the successor's own preflight decides, an exited successor aborts the restart. */
export function routerRestartDeps(cliEntry: string): Parameters<typeof restartRouter>[0] {
  return {
    oldPid: routerRunningPid() ?? undefined,
    spawnNew: (old) => {
      rmSync(routerHandoverStatusFile(), { force: true });
      return spawnRouter(cliEntry, routerSwapArgs(old));
    },
    handover: (old) => startHandover(old),
    isUp: () => probeRouter(routerPort(), 500),
    preflight: () => checkUpstream(loadConfig().router.claudeUpstream),
    settled: (n) => n === undefined || routerRunningPid() === n || !pidAlive(n),
    aborted: async (old, n) => {
      const st = readHandoverStatus(old);
      if (!st || (st.successorPid !== undefined && st.successorPid !== n)) return undefined;
      return abortedText(st, st.diag ? await restarterLookup(abortedHost(st)) : undefined);
    },
  };
}

/** True when a daemon answers on its socket. */
async function daemonUp(): Promise<boolean> {
  try {
    await new PaiClient(loadConfig().socketPath).status();
    return true;
  } catch {
    return false;
  }
}

/**
 * `pai router restart`: through the daemon when it runs, so the daemon (not the calling session) is the successor's parent
 * and a session's environment cannot taint it; directly only when there is no daemon.
 */
export async function routerRestartText(cliEntry: string, via: { daemonUp: () => Promise<boolean>; call: (method: string) => Promise<string> } = { daemonUp, call: async (m) => String(await new PaiClient(loadConfig().socketPath).call(m, {}, 60_000)) }): Promise<string> {
  if (await via.daemonUp()) {
    try {
      return await via.call("router_restart");
    } catch (e) {
      if (!/Unknown method/.test(String((e as Error).message))) throw e; // a daemon from before this method: restart directly
    }
  }
  return routerRestartDirect(cliEntry);
}

export async function routerRestartDirect(cliEntry: string): Promise<string> {
  const result = await restartRouter(routerRestartDeps(cliEntry));
  const st = result.oldPid !== undefined ? readHandoverStatus(result.oldPid) : undefined;
  const finishing = st?.state === "draining" && st.inflight ? `, old router still finishing ${st.inflight} in-flight request(s)` : "";
  return `router restarted (new pid ${result.newPid}, old pid ${result.oldPid ?? "none"}, refused for ${result.gapMs ?? 0} ms${finishing})`;
}

export function routerStatusText(): string {
  const pid = routerRunningPid();
  const managed = loadConfig().router.enabled;
  const note = managed ? "daemon-managed: restarted if down" : "not daemon-managed (router.enabled is false)";
  return pid ? `router running (pid ${pid}, port ${routerPort()}); ${note}` : `router not running; ${note}`;
}
