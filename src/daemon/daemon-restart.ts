/**
 * daemon-restart.ts — restart the running daemon and PROVE it happened.
 *
 * The 2026-11-16 incident: `pai worker merge` rebuilt dist and printed "the daemon
 * restarts itself on the new build", but the watcher missed the build and the old
 * daemon kept serving until someone ran `pai daemon restart` by hand. A promise is
 * not a verification: after a build the merge now waits for the daemon's pid (or its
 * process start time) to actually change, and when it does not within the window it
 * performs the restart itself — launchd/systemd, never a pattern-matched kill.
 */

import { spawnSync } from "node:child_process";
import { currentUid, resolveDaemonPid, LAUNCHD_LABEL } from "./daemon-pid.js";

export const RESTART_VERIFY_WINDOW_MS = 60_000;
const POLL_MS = 2_000;

/** The daemon's identity for the watcher: pid + process start time (epoch ms); undefined when nothing runs. */
export type DaemonIdentity = { pid: number; startMs?: number } | undefined;

export interface RestartVerifyDeps {
  /** The daemon's current identity, or undefined when it is not running. */
  identity: () => DaemonIdentity;
  /** ms sleep between polls. */
  sleep: (ms: number) => void;
  now: () => number;
  /** Force a restart through the service manager. */
  forceRestart: () => boolean;
  log?: (line: string) => void;
}

const sameIdentity = (a: DaemonIdentity, b: DaemonIdentity): boolean =>
  a?.pid === b?.pid && (a?.startMs === undefined || b?.startMs === undefined || a.startMs === b.startMs);

export const realRestartVerifyDeps = (): RestartVerifyDeps => ({
  identity: () => {
    const pid = resolveDaemonPid();
    if (!pid) return undefined;
    try {
      const out = (spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
      const t = Date.parse(out);
      return { pid, startMs: Number.isNaN(t) ? undefined : t };
    } catch {
      return { pid };
    }
  },
  sleep: (ms) => spawnSync("sleep", [String(ms / 1000)]), // blocking wait without a busy loop
  now: () => Date.now(),
  forceRestart: forceDaemonRestart,
});

/** Real implementation of {@link waitForDaemonRestart}: the running daemon before the call, then verified. */
export function waitForDaemonRestart(
  deps: RestartVerifyDeps = realRestartVerifyDeps(),
  windowMs = RESTART_VERIFY_WINDOW_MS
): { restarted: boolean; forced: boolean; detail: string } {
  const before = deps.identity();
  if (before === undefined) return { restarted: false, forced: false, detail: "no daemon is running — nothing to restart" };
  const deadline = deps.now() + windowMs;
  for (;;) {
    const now = deps.identity();
    if (now === undefined || !sameIdentity(before, now)) {
      return { restarted: true, forced: false, detail: `daemon pid ${before.pid} -> ${now?.pid ?? "down"} on the new build` };
    }
    if (deps.now() >= deadline) break;
    deps.sleep(POLL_MS);
  }
  deps.log?.("watcher did not restart the daemon within the window; restarting it now");
  const forced = deps.forceRestart();
  // after a forced restart the identity must change too — one more bounded look, then report what we see
  const after = deps.identity();
  const changed = after !== undefined && !sameIdentity(before, after);
  return {
    restarted: changed,
    forced: true,
    detail: changed
      ? `watcher missed the build; restarted by hand: pid ${before.pid} -> ${after?.pid ?? "down"}`
      : `watcher missed the build and the forced restart did not take (pid still ${before.pid})`,
  };
}

/** Restart through the service manager (launchd kickstart on macOS, systemctl --user restart on Linux). */
export function forceDaemonRestart(): boolean {
  if (process.platform === "darwin") {
    const uid = currentUid() ?? 501;
    const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: "utf8" });
    return r.status === 0;
  }
  if (process.platform === "linux") {
    const r = spawnSync("systemctl", ["--user", "restart", "pai-daemon.service"], { encoding: "utf8" });
    return r.status === 0;
  }
  return false;
}
