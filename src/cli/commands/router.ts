/**
 * `pai router start|stop|status|run` — local model router on port 8790.
 * See src/router/router.ts.
 */

import type { Command } from "commander";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { routerHandler, ROUTER_PORT } from "../../router/router.js";
import http from "node:http";
import {
  cockpitTokenFile,
  defaultV1Guard,
  displayHost,
  LOOPBACK,
  readOrCreateCockpitToken,
  resolveBindAddress,
  withCockpitToken,
  type CockpitHandler,
} from "../../router/cockpit-auth.js";
import { cachedRows, cachedSessionMap, handleCockpit } from "../../router/cockpit.js";
import { LimitsCache } from "../../router/limits.js";
import { SystemMonitor } from "../../router/system.js";
import { readWorkersSection } from "../../workers/config.js";
import type { UsageRow } from "../../router/usage.js";
import { aggregate, aggregateBySession, appendUsage, formatSessionStats, formatStats, parseSince, readUsage } from "../../router/usage.js";
import { loadSessionMap, sessionDisplayName } from "../../router/sessions.js";
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
    .option("--port <port>", "listen port (a non-default port never touches the pid file)", String(ROUTER_PORT))
    .option("--usage-file <path>", "read the cockpit's accounting from this file and record nothing (second instances)")
    .action((opts: { port: string; usageFile?: string }) => {
      const port = Number(opts.port);
      const managed = port === ROUTER_PORT;
      // router.bind: "loopback" (default) | "tailscale" | an explicit IPv4.
      // Beyond loopback a second listener serves the cockpit from the
      // tailnet/LAN address while /v1 stays loopback+tailnet and the cockpit
      // needs its token; 0.0.0.0 is never accepted.
      const bindName = loadConfig().router.bind ?? "loopback";
      const addr = resolveBindAddress(bindName);
      if (!addr) {
        console.error(
          err(`router: cannot resolve router.bind "${bindName}" — use "loopback", "tailscale", or an IPv4 (never 0.0.0.0)`)
        );
        process.exit(1);
      }
      const remote = addr !== LOOPBACK;
      const token = remote ? readOrCreateCockpitToken() : undefined;
      const rows = cachedRows(opts.usageFile);
      const limits = new LimitsCache({ providers: () => readWorkersSection().workers.providers, rows });
      const system = new SystemMonitor();
      const serve: CockpitHandler = (req: http.IncomingMessage, res: http.ServerResponse) =>
        handleCockpit(req, res, limits, rows, cachedSessionMap(), system);
      const cockpit = token ? withCockpitToken(token, serve) : serve;
      const append = opts.usageFile ? () => undefined : (row: UsageRow) => appendUsage(row);
      const handler = routerHandler(
        undefined,
        undefined,
        undefined,
        append,
        cockpit,
        remote ? { remoteAllowed: defaultV1Guard } : undefined
      );
      const server = http.createServer(handler);
      server.on("error", (e) => {
        console.error(err(`router: ${(e as Error).message}`));
        process.exit(1);
      });
      const tail = remote ? http.createServer(handler) : undefined;
      tail?.on("error", (e) => {
        console.error(err(`router ${addr}: ${(e as Error).message}`));
        process.exit(1);
      });
      server.listen(port, "127.0.0.1", () => {
        if (!managed) return;
        mkdirSync(dirname(PID_FILE), { recursive: true });
        writeFileSync(PID_FILE, String(process.pid));
      });
      tail?.listen(port, addr, async () => {
        const host = await displayHost(addr);
        console.log(ok(`cockpit beyond loopback: http://${host}:${port}/cockpit?token=${token} (token: ${cockpitTokenFile()})`));
      });
      const bye = () => {
        if (managed) {
          try {
            unlinkSync(PID_FILE);
          } catch {
            /* ignore */
          }
        }
        process.exit(0);
      };
      process.on("SIGTERM", bye);
      process.on("SIGINT", bye);
    });

  cmd
    .command("stats")
    .description("Token and cache totals per provider/model from the router usage log")
    .option("--since <span>", "only the last span, e.g. 30m, 1h, 2d")
    .option("--by <key>", "group by provider (default) or session", "provider")
    .action((opts: { since?: string; by: string }) => {
      let since: number | undefined;
      try {
        since = opts.since ? parseSince(opts.since) : undefined;
      } catch (e) {
        console.error(err((e as Error).message));
        process.exit(1);
      }
      if (opts.by === "session") {
        const map = loadSessionMap();
        console.log(formatSessionStats(aggregateBySession(readUsage(), since, Date.now(), (id) => sessionDisplayName(id, map))));
      } else console.log(formatStats(aggregate(readUsage(), since)));
    });
}
