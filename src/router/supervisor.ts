/**
 * Keeps `pai router` running under the daemon: probe the port each tick and
 * start the router when it is down. Opt-in via `router.enabled` (config).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { dirname } from "node:path";
import { connect } from "node:net";
import { pidAlive } from "../workers/status.js";
import { ROUTER_PORT } from "./router.js";

export const routerPidFile = (): string => paiHomePath("router.pid");
export const routerLogFile = (): string => paiHomePath("logs", "router.log");

export function routerRunningPid(): number | null {
  if (!existsSync(routerPidFile())) return null;
  const pid = parseInt(readFileSync(routerPidFile(), "utf8"), 10);
  if (!pid) return null;
  return pidAlive(pid) ? pid : null;
}

/** Spawn `<cli> router run` detached, logging to the router log. Returns the child pid. */
export function spawnRouter(cliEntry: string, extraArgs: string[] = []): number | undefined {
  mkdirSync(dirname(routerLogFile()), { recursive: true });
  const fd = openSync(routerLogFile(), "a");
  const child = spawn(process.execPath, [cliEntry, "router", "run", ...extraArgs], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  child.unref();
  return child.pid;
}

/** True when something accepts TCP connections on the router port. */
export function probeRouter(port = ROUTER_PORT, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export interface RouterTickDeps {
  probe: () => Promise<boolean>;
  start: () => void;
}

/** One health check: starts the router when down, never replaces a live router. */
export async function runRouterTick(deps: RouterTickDeps): Promise<"up" | "started"> {
  if (await deps.probe()) {
    return "up";
  }
  deps.start();
  return "started";
}
