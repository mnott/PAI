/**
 * `pai router start|stop|status|run` — local model router on port 8790.
 * See src/router/router.ts.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRouter, ROUTER_PORT } from "../../router/router.js";
import { ok, err, dim } from "../utils.js";

const PID_FILE = join(homedir(), ".claude", "pai", "router.pid");
const LOG_FILE = join(homedir(), ".claude", "pai", "logs", "router.log");

function runningPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

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
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      const fd = openSync(LOG_FILE, "a");
      const child = spawn(process.execPath, [process.argv[1]!, "router", "run"], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      closeSync(fd);
      child.unref();
      console.log(ok(`router starting on 127.0.0.1:${ROUTER_PORT} (pid ${child.pid}), log ${LOG_FILE}`));
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
      console.log(pid ? ok(`router running (pid ${pid}, port ${ROUTER_PORT})`) : dim("router not running"));
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
