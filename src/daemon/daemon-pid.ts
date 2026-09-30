/**
 * daemon-pid.ts — the one way PAI finds the running daemon's PID.
 *
 * Never by command-line pattern: `pgrep -f` matches any process whose argv
 * mentions the text (a worker whose spec quotes it, an editor), and the caller
 * then signals the wrong process. The service manager knows the PID; when none
 * is in use (`pai daemon serve` in a container) the daemon's own pidfile does.
 */

import { readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { daemonPidPath } from "../runtime-paths.js";

const LAUNCHD_LABEL = "com.pai.pai-daemon";
const SYSTEMD_UNIT = "pai-daemon.service";

/** `pid = N` from `launchctl print gui/<uid>/<label>`; undefined when not running. */
export function parseLaunchctlPid(out: string): number | undefined {
  const m = /^\s*pid = (\d+)\s*$/m.exec(out);
  return m ? Number(m[1]) : undefined;
}

/** `MainPID=N` from `systemctl --user show -p MainPID`; 0 means not running. */
export function parseSystemdMainPid(out: string): number | undefined {
  const n = Number(/^MainPID=(\d+)\s*$/m.exec(out)?.[1]);
  return n > 0 ? n : undefined;
}

type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const run: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** Start time of a process (epoch ms) or undefined when it does not exist. */
function processStart(pid: number, sh: Run): number | undefined {
  const r = sh("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (r.status !== 0 || !r.stdout.trim()) return undefined;
  const t = Date.parse(r.stdout.trim());
  return Number.isNaN(t) ? undefined : t;
}

/**
 * PID from the pidfile, only if that process is alive and started no later
 * than the pidfile was written (ps start times have 1 s resolution). A process
 * that started after the file is a reused PID and is not the daemon.
 */
export function pidfilePid(path: string = daemonPidPath(), sh: Run = run): number | undefined {
  try {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    if (!(pid > 0)) return undefined;
    const started = processStart(pid, sh);
    if (started === undefined || started > statSync(path).mtimeMs + 2000) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/** The running daemon's PID: service manager first, pidfile second, else undefined. */
export function resolveDaemonPid(
  plat: NodeJS.Platform = process.platform,
  sh: Run = run,
  path: string = daemonPidPath(),
): number | undefined {
  if (plat === "darwin") {
    const uid = process.getuid?.() ?? userInfo().uid;
    const r = sh("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
    const pid = r.status === 0 ? parseLaunchctlPid(r.stdout) : undefined;
    if (pid) return pid;
  } else if (plat === "linux") {
    const r = sh("systemctl", ["--user", "show", "-p", "MainPID", SYSTEMD_UNIT]);
    const pid = r.status === 0 ? parseSystemdMainPid(r.stdout) : undefined;
    if (pid) return pid;
  }
  return pidfilePid(path, sh);
}

export function writeDaemonPidfile(path: string = daemonPidPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${process.pid}\n`, "utf8");
  } catch {
    // non-fatal: the service manager still knows the PID
  }
}

/** Remove the pidfile only if it is ours (a newer daemon may own it). */
export function removeDaemonPidfile(path: string = daemonPidPath()): void {
  try {
    if (parseInt(readFileSync(path, "utf8").trim(), 10) === process.pid) unlinkSync(path);
  } catch {
    // already gone
  }
}
