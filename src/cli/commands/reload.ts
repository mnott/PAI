/**
 * `pai reload` — make the long-running PAI processes run the code on disk:
 * daemon, router, worker pool host, in that order. The daemon is started when
 * it does not run (its service is installed); the router and pool host are
 * only restarted when they run.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { currentUid, resolveDaemonPid } from "../../daemon/daemon-pid.js";
import { loadConfig } from "../../daemon/config.js";
import { PaiClient } from "../../daemon/ipc-client.js";
import { routerPort } from "../../router/router.js";
import { restartRouter } from "../../router/restart.js";
import { probeRouter, routerRunningPid, routerSwapArgs, startHandover, spawnRouter } from "../../router/supervisor.js";
import { poolReloadLive } from "../../workers/pool-cli.js";
import { workersLogDir } from "../../workers/paths.js";
import { readWorkersSection } from "../../workers/config.js";
import { bundleBuildStamp } from "../../workers/pool.js";
import { cliVersion } from "../run.js";
import { daemonRestartCmd, daemonServiceFilePath, daemonServiceName } from "../impl/daemon.js";
import { serviceManagerAllowed } from "../../service-manager.js";
import { daemonLogPath } from "../../runtime-paths.js";
import { CliError, type CommandDef } from "../define.js";
import { dim, err, ok } from "../lib/utils.js";

export interface ReloadDeps {
  /** "v<version> built <stamp>" of the code on disk, which every restarted process now runs. */
  codeInfo: () => string;
  daemon: {
    pid: () => number | undefined;
    restart: () => number | undefined;
    /** True when the service is installed (its plist / unit file is on disk). */
    serviceInstalled: () => boolean;
    /** Kickstart the installed service; false when the service manager refuses. */
    kickstart: () => boolean;
    /** True once the daemon answers on its IPC socket. */
    socketUp: () => Promise<boolean>;
    /** The daemon's service log (the plist's StandardErrorPath), for the failure tail. */
    logPath: () => string;
  };
  router: { pid: () => number | undefined; restart: () => Promise<number | undefined> };
  pool: { reload: () => Promise<{ oldPid: number | undefined; newPid: number | undefined; builtAt: string | null; starting?: boolean } | null> };
}

export interface DaemonStartResult {
  ok: boolean;
  pid?: number;
  /** The last lines of the service log when the daemon did not come up. */
  logTail?: string[];
}

/**
 * The daemon is never skipped silently: a stopped daemon with an installed
 * service is kickstarted and waited for; one without a service is reported as
 * not running. A daemon that does not come up carries the log tail — a
 * crash-looping launchd job is exactly the case reload must not print
 * "skipped" for.
 */
export async function startStoppedDaemon(
  d: ReloadDeps["daemon"],
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<DaemonStartResult> {
  if (!d.serviceInstalled()) {
    return { ok: false, logTail: ["not running (no service installed; pai daemon install)"] };
  }
  if (!d.kickstart()) {
    // kickstart refuses when the service manager is not usable (see liveDeps)
    return { ok: false, logTail: ["kickstart failed"] };
  }
  // poll: sleep first, then probe — the daemon binds its IPC socket only once it is up.
  // Give up after timeoutMs and report the tail of the service log, so the failure
  // says why instead of "skipped": a crash-looping launchd job is exactly this case.
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  let waited = 0;
  while (waited < timeoutMs) {
    await sleep(pollMs);
    waited += pollMs;
    if (await d.socketUp()) {
      const pid = d.pid();
      return pid === undefined ? { ok: false, logTail: ["started but its pid is unknown"] } : { ok: true, pid };
    }
  }
  return { ok: false, logTail: lastErrorLines(d.logPath(), 5) };
}

/** The last `n` non-empty lines of the service log; [] when there is no log yet. */
export function lastErrorLines(path: string, n: number): string[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").slice(-n);
  } catch {
    return [];
  }
}

const pidText = (p: number | undefined): string => (p === undefined ? "none" : String(p));

/** One line per process, in restart order; the router and pool host are skipped when they do not run. */
export async function reloadAll(
  d: ReloadDeps,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ lines: string[]; daemonFailed: boolean }> {
  const lines: string[] = [];
  const code = d.codeInfo();
  const oldDaemon = d.daemon.pid();
  let daemonFailed = false;
  if (oldDaemon === undefined) {
    const started = await startStoppedDaemon(d.daemon, opts);
    if (started.ok) lines.push(`daemon: started pid ${pidText(started.pid)}, ${code}`);
    else {
      daemonFailed = true;
      lines.push(`daemon: FAILED to start — ${started.logTail?.[0] ?? "unknown"}`);
      for (const l of started.logTail?.slice(1) ?? []) lines.push(`  ${l}`);
    }
  } else lines.push(`daemon: pid ${oldDaemon} -> ${pidText(d.daemon.restart())}, ${code}`);

  const oldRouter = d.router.pid();
  if (oldRouter === undefined) lines.push("router: not running, skipped");
  else lines.push(`router: pid ${oldRouter} -> ${pidText(await d.router.restart())}, ${code}`);

  const pool = await d.pool.reload();
  if (!pool) lines.push("pool host: not running, skipped");
  else lines.push(`pool host: pid ${pidText(pool.oldPid)} -> ${pidText(pool.newPid)}, ${code}${pool.starting ? ", still starting (see pai worker pool status)" : ""}${pool.builtAt ? ` (bundle built ${pool.builtAt})` : ""}`);
  return { lines, daemonFailed };
}

function liveDeps(): ReloadDeps {
  const entry = process.argv[1]!;
  return {
    codeInfo: () => {
      let built = "build time unknown";
      try {
        built = `built ${bundleBuildStamp(statSync(entry).mtimeMs)}`;
      } catch {
        /* keep unknown */
      }
      return `v${cliVersion()} ${built}`;
    },
    daemon: {
      pid: resolveDaemonPid,
      restart: () => {
        // daemonRestartCmd prints its own line; reload prints one per process
        const log = console.log;
        console.log = () => undefined;
        try {
          if (daemonRestartCmd() !== 0) throw new CliError("daemon restart failed", "pai daemon status");
        } finally {
          console.log = log;
        }
        return resolveDaemonPid();
      },
      serviceInstalled: () => existsSync(daemonServiceFilePath()),
      kickstart: () => {
        // the one guard in front of every launchctl / systemctl call
        if (!serviceManagerAllowed("launchctl kickstart")) return false;
        if (process.platform === "linux") {
          return spawnSync("systemctl", ["--user", "start", daemonServiceName()], { encoding: "utf8" }).status === 0;
        }
        const uid = currentUid();
        if (uid === undefined) return false;
        return spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${daemonServiceName()}`], { encoding: "utf8" }).status === 0;
      },
      socketUp: async () => {
        try {
          const client = new PaiClient(loadConfig().socketPath);
          await client.status();
          return true;
        } catch {
          return false;
        }
      },
      logPath: daemonLogPath,
    },
    router: {
      pid: () => routerRunningPid() ?? undefined,
      restart: async () =>
        (await restartRouter({
          oldPid: routerRunningPid() ?? undefined,
          spawnNew: (old) => spawnRouter(entry, routerSwapArgs(old)),
          handover: (old) => startHandover(old),
          isUp: () => probeRouter(routerPort(), 500),
        })).newPid,
    },
    pool: { reload: () => poolReloadLive(workersLogDir(readWorkersSection().workers)) },
  };
}

export const reloadCommand: CommandDef = {
  name: "reload",
  summary: "Restart daemon, router and worker pool host onto the code on disk",
  description:
    "After a build the long-running processes keep the old code until restarted. This restarts the daemon — starting it through its installed service when it does not run — " +
    "then the router (no refused connections), then the worker pool host (busy slots finish their task first; idle spares are retired and recreated on the new code). " +
    "The router and pool host are only restarted when they run. Prints one line per process with old and new pid and the code it runs; a daemon that will not start is reported with the last lines of its log and a non-zero exit.",
  examples: ["pai reload"],
  seeAlso: ["pai daemon restart", "pai router restart", "pai worker pool status"],
  async run() {
    // a kickstarted daemon needs a moment to bind its socket before reload gives up
    const { lines, daemonFailed } = await reloadAll(liveDeps(), { timeoutMs: 10_000 });
    for (const l of lines) process.stdout.write((l.endsWith("skipped") ? dim(l) : l.startsWith("daemon: FAILED") ? err(l) : ok(l)) + "\n");
    if (daemonFailed) return 1;
  },
};
