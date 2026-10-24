/**
 * Keeps `pai router` running under the daemon: probe the port each tick and
 * start the router when it is down. Opt-in via `router.enabled` (config).
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";
import { dirname } from "node:path";
import { connect } from "node:net";
import { pidAlive } from "../workers/status.js";
import { routerPort } from "./router.js";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";

export const routerPidFile = (): string => paiHomePath("router.pid");
export const routerLogFile = (): string => paiHomePath("logs", "router.log");

/** Written by a router that can hand its listening socket to a successor on SIGUSR2; holds that router's pid. */
export const routerHandoverFile = (): string => paiHomePath("router.handover");

/** Written by a router that handed its sockets over (or failed to): the restarter reads how the swap went and how many requests the old one is still finishing. */
export const routerHandoverStatusFile = (): string => paiHomePath("router.handover-status");

export interface HandoverStatus {
  oldPid: number;
  state: "draining" | "failed";
  inflight?: number;
  reason?: string;
}

export function readHandoverStatus(oldPid: number): HandoverStatus | undefined {
  try {
    const st = JSON.parse(readFileSync(routerHandoverStatusFile(), "utf8")) as HandoverStatus;
    return st.oldPid === oldPid ? st : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gapless swap: ask the running router to spawn its successor with the listening socket.
 * Returns null when `oldPid` predates handover (SIGUSR2 would kill it), else resolves with the successor's pid
 * once it has taken over the pid file.
 */
export function startHandover(oldPid: number, timeoutMs = 30000): Promise<number | undefined> | null {
  try {
    if (readFileSync(routerHandoverFile(), "utf8").trim() !== String(oldPid)) return null;
    rmSync(routerHandoverStatusFile(), { force: true });
    process.kill(oldPid, "SIGUSR2");
  } catch {
    return null;
  }
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
      const pid = parseInt(existsSync(routerPidFile()) ? readFileSync(routerPidFile(), "utf8") : "", 10);
      if (pid && pid !== oldPid) {
        // the old router records what it is still finishing right after the successor's ready message
        for (let i = 0; i < 50 && readHandoverStatus(oldPid) === undefined; i++) await new Promise((r) => setTimeout(r, 20));
        return pid;
      }
      const st = readHandoverStatus(oldPid);
      if (st?.state === "failed") throw new Error(`router ${oldPid} kept serving: ${st.reason ?? "successor did not start"} (see ${routerLogFile()})`);
    }
    throw new Error(`router ${oldPid} did not hand over within ${timeoutMs}ms`);
  })();
}

export function routerRunningPid(): number | null {
  if (!existsSync(routerPidFile())) return null;
  const pid = parseInt(readFileSync(routerPidFile(), "utf8"), 10);
  if (!pid) return null;
  return pidAlive(pid) ? pid : null;
}

/** Args for a router that replaces `oldPid`: it warms up first, then SIGTERMs the old one and binds the port the moment it frees. */
export function routerSwapArgs(oldPid: number | undefined): string[] {
  return ["--wait-bind", "10", ...(oldPid === undefined ? [] : ["--replace", String(oldPid)])];
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
export function probeRouter(port = routerPort(), timeoutMs = LOCAL_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: LOOPBACK_HOST, port });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * True when the running router predates the current build: the router writes
 * its pid file once it is bound, so an entry file newer than that means it
 * still serves old code.
 */
export function routerIsStale(cliEntry: string): boolean {
  try {
    return statSync(cliEntry).mtimeMs > statSync(routerPidFile()).mtimeMs;
  } catch {
    return false;
  }
}

export interface RouterTickDeps {
  probe: () => Promise<boolean>;
  start: () => void;
  /** Optional: true when the answering router predates the current build. */
  stale?: () => boolean;
  /** Required with `stale`: gapless swap (new router waits for the port, old one drains). */
  restart?: () => Promise<void>;
}

/** One health check: starts the router when down, swaps it gaplessly when the build changed. */
export async function runRouterTick(deps: RouterTickDeps): Promise<"up" | "started" | "restarted"> {
  if (await deps.probe()) {
    if (!deps.stale?.() || !deps.restart) return "up";
    await deps.restart();
    return "restarted";
  }
  deps.start();
  return "started";
}
