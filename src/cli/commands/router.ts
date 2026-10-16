/**
 * `pai router start|stop|status|run` — local model router on port 8790.
 * See src/router/router.ts.
 */

import type { Command } from "commander";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRouter, ROUTER_PORT } from "../../router/router.js";
import { ROUTER_LOG_FILE, ROUTER_PID_FILE, routerRunningPid, spawnRouter } from "../../router/supervisor.js";
import { loadConfig } from "../../daemon/config.js";
import { ok, err, dim } from "../utils.js";

const PID_FILE = ROUTER_PID_FILE;
const LOG_FILE = ROUTER_LOG_FILE;
const runningPid = routerRunningPid;

export function registerRouterCommands(program: Command): void {
  const cmd = program
    .command("router")
    .description(
      `Local model router on 127.0.0.1:${ROUTER_PORT}: set ANTHROPIC_BASE_URL to it and /model picks the provider`
    );

  cmd
    .command("start")
    .description("Start the router in the background")
    .action(() => {
      const pid = runningPid();
      if (pid) return console.log(ok(`router already running (pid ${pid})`));
      const pid2 = spawnRouter(process.argv[1]!);
      console.log(ok(`router starting on 127.0.0.1:${ROUTER_PORT} (pid ${pid2}), log ${LOG_FILE}`));
    });

  cmd
    .command("stop")
    .description("Stop the router")
    .action(() => {
      const pid = runningPid();
      if (!pid) return console.log(dim("router not running"));
      process.kill(pid, "SIGTERM");
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* already gone */
      }
      console.log(ok(`router stopped (pid ${pid})`));
    });

  cmd
    .command("status")
    .description("Show whether the router is running")
    .action(() => {
      const pid = runningPid();
      const managed = loadConfig().router.enabled;
      const note = managed ? "daemon-managed: restarted if down" : "not daemon-managed (router.enabled is false)";
      console.log(
        pid ? ok(`router running (pid ${pid}, port ${ROUTER_PORT}); ${note}`) : dim(`router not running; ${note}`)
      );
    });

  cmd
    .command("run")
    .description("Run the router in the foreground")
    .action(() => {
      const server = createRouter();
      server.on("error", (e) => {
        console.error(err(`router: ${(e as Error).message}`));
        process.exit(1);
      });
      server.listen(ROUTER_PORT, "127.0.0.1", () => {
        mkdirSync(dirname(PID_FILE), { recursive: true });
        writeFileSync(PID_FILE, String(process.pid));
      });
      const bye = () => {
        try {
          unlinkSync(PID_FILE);
        } catch {
          /* ignore */
        }
        process.exit(0);
      };
      process.on("SIGTERM", bye);
      process.on("SIGINT", bye);
    });
}
