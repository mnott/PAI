/**
 * `pai reload` — make the long-running PAI processes run the code on disk:
 * daemon, router, worker pool host, in that order, each only if it runs.
 */

import { statSync } from "node:fs";
import { resolveDaemonPid } from "../../daemon/daemon-pid.js";
import { ROUTER_PORT } from "../../router/router.js";
import { restartRouter } from "../../router/restart.js";
import { probeRouter, routerRunningPid, spawnRouter } from "../../router/supervisor.js";
import { poolReloadLive } from "../../workers/pool-cli.js";
import { workersLogDir } from "../../workers/paths.js";
import { readWorkersSection } from "../../workers/config.js";
import { bundleBuildStamp } from "../../workers/pool.js";
import { cliVersion } from "../run.js";
import { daemonRestartCmd } from "../impl/daemon.js";
import { CliError, type CommandDef } from "../define.js";
import { dim, ok } from "../lib/utils.js";

export interface ReloadDeps {
  /** "v<version> built <stamp>" of the code on disk, which every restarted process now runs. */
  codeInfo: () => string;
  daemon: { pid: () => number | undefined; restart: () => number | undefined };
  router: { pid: () => number | undefined; restart: () => Promise<number | undefined> };
  pool: { reload: () => Promise<{ oldPid: number | undefined; newPid: number | undefined; builtAt: string | null } | null> };
}

const pidText = (p: number | undefined): string => (p === undefined ? "none" : String(p));

/** One line per process, in restart order; a process that is not running is skipped, not started. */
export async function reloadAll(d: ReloadDeps): Promise<string[]> {
  const lines: string[] = [];
  const code = d.codeInfo();
  const oldDaemon = d.daemon.pid();
  if (oldDaemon === undefined) lines.push("daemon: not running, skipped");
  else lines.push(`daemon: pid ${oldDaemon} -> ${pidText(d.daemon.restart())}, ${code}`);

  const oldRouter = d.router.pid();
  if (oldRouter === undefined) lines.push("router: not running, skipped");
  else lines.push(`router: pid ${oldRouter} -> ${pidText(await d.router.restart())}, ${code}`);

  const pool = await d.pool.reload();
  if (!pool) lines.push("pool host: not running, skipped");
  else lines.push(`pool host: pid ${pidText(pool.oldPid)} -> ${pidText(pool.newPid)}, ${code}${pool.builtAt ? ` (bundle built ${pool.builtAt})` : ""}`);
  return lines;
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
    },
    router: {
      pid: () => routerRunningPid() ?? undefined,
      restart: async () =>
        (await restartRouter({
          oldPid: routerRunningPid() ?? undefined,
          spawnNew: () => spawnRouter(entry, ["--wait-bind", "10"]),
          signalOld: (pid) => process.kill(pid, "SIGTERM"),
          isUp: () => probeRouter(ROUTER_PORT, 500),
        })).newPid,
    },
    pool: { reload: () => poolReloadLive(workersLogDir(readWorkersSection().workers)) },
  };
}

export const reloadCommand: CommandDef = {
  name: "reload",
  summary: "Restart daemon, router and worker pool host onto the code on disk",
  description:
    "After a build the long-running processes keep the old code until restarted. This restarts the daemon, then the router (no refused connections), then the worker pool host " +
    "(busy slots finish their task first; idle spares are retired and recreated on the new code). Only processes that run are restarted. Prints one line per process with old and new pid and the code it runs.",
  examples: ["pai reload"],
  seeAlso: ["pai daemon restart", "pai router restart", "pai worker pool status"],
  async run() {
    for (const l of await reloadAll(liveDeps())) process.stdout.write((l.endsWith("skipped") ? dim(l) : ok(l)) + "\n");
  },
};
