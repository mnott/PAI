/**
 * One router per port. After a gapless swap the old router drains for at most router.handover.drainMaxSecs;
 * one still alive past that window is a leftover (stuck in-flight requests) and is stopped by its exact pid.
 * Only processes whose command line is `... router run ... --port <same>` are ever candidates.
 */

import { execFileSync } from "node:child_process";
import { appendLedger } from "../workers/ledger.js";

export interface RouterProc {
  pid: number;
  /** seconds since the process started */
  ageSec: number;
  command: string;
}

/** `ps -axo pid=,etime=,command=` output -> router processes for `port` (`defaultPort` is the port of a router started without --port). */
export function parseRouterProcs(psOut: string, port: number, defaultPort = port): RouterProc[] {
  const out: RouterProc[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(?:(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+))\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[6]!;
    if (!/^(\S*\/)?(node|bun|pai)\s/.test(cmd) || !/\s+router\s+run(\s|$)/.test(cmd)) continue;
    const p = /--port[= ](\d+)/.exec(cmd);
    if ((p ? Number(p[1]) : defaultPort) !== port) continue;
    const ageSec = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4]) * 60 + Number(m[5]);
    out.push({ pid: Number(m[1]), ageSec, command: cmd });
  }
  return out;
}

/**
 * The pids to stop: every router for the port other than the one that serves (`servingPid` when it is among them,
 * else the newest), and only those started before it and older than the drain window (`graceSec`):
 * a swap's old router is legitimately alive while it drains.
 */
export function duplicatesToStop(procs: RouterProc[], servingPid: number | undefined, graceSec: number): { keep?: number; stop: number[] } {
  if (procs.length < 2) return { keep: procs[0]?.pid, stop: [] };
  const serving = procs.find((p) => p.pid === servingPid) ?? [...procs].sort((a, b) => a.ageSec - b.ageSec)[0]!;
  const stop = procs.filter((p) => p.pid !== serving.pid && p.ageSec > serving.ageSec && p.ageSec > graceSec).map((p) => p.pid);
  return { keep: serving.pid, stop };
}

export interface DuplicateDeps {
  ps: () => string;
  kill: (pid: number) => void;
  ledger: (pid: number, kept: number | undefined, port: number) => void;
}

export const realDuplicateDeps = (logLedger: string): DuplicateDeps => ({
  ps: () => execFileSync("ps", ["-axo", "pid=,etime=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 }),
  kill: (pid) => process.kill(pid, "SIGTERM"),
  ledger: (pid, kept, port) => appendLedger(logLedger, "ROUTER-DUPLICATE-STOPPED", { pid, kept: kept ?? "?", port }),
});

/** Stops the leftover routers for `port`; returns the pids stopped. Never throws. */
export function stopDuplicateRouters(port: number, servingPid: number | undefined, graceSec: number, deps: DuplicateDeps, defaultPort = port): number[] {
  const stopped: number[] = [];
  try {
    const { keep, stop } = duplicatesToStop(parseRouterProcs(deps.ps(), port, defaultPort), servingPid, graceSec);
    for (const pid of stop) {
      try {
        deps.kill(pid);
        stopped.push(pid);
        deps.ledger(pid, keep, port);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* ps failed: try again next tick */
  }
  return stopped;
}
