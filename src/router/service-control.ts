/**
 * service-control.ts — start, stop, restart and status of the background router.
 *
 * One implementation for `pai router start|stop|restart|status` and the
 * router_service MCP tool. Each function returns the line the CLI prints.
 */

import { unlinkSync } from "node:fs";
import { loadConfig } from "../daemon/config.js";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { restartRouter } from "./restart.js";
import { routerPort } from "./router.js";
import { probeRouter, routerLogFile, routerPidFile, routerRunningPid, routerSwapArgs, spawnRouter, startHandover } from "./supervisor.js";

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

export async function routerRestartText(cliEntry: string): Promise<string> {
  const result = await restartRouter({
    oldPid: routerRunningPid() ?? undefined,
    spawnNew: (old) => spawnRouter(cliEntry, routerSwapArgs(old)),
    handover: (old) => startHandover(old),
    isUp: () => probeRouter(routerPort(), 500),
  });
  return `router restarted (new pid ${result.newPid}, old pid ${result.oldPid ?? "none"}, refused for ${result.gapMs ?? 0} ms)`;
}

export function routerStatusText(): string {
  const pid = routerRunningPid();
  const managed = loadConfig().router.enabled;
  const note = managed ? "daemon-managed: restarted if down" : "not daemon-managed (router.enabled is false)";
  return pid ? `router running (pid ${pid}, port ${routerPort()}); ${note}` : `router not running; ${note}`;
}
