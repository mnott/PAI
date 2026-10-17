/**
 * `pai router start|stop|status|run|stats` — local model router on port 8790.
 * See src/router/router.ts. Names, flags and stdout match the old CLI.
 */

import http from "node:http";
import { mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { routerHandler, ROUTER_PORT } from "../../router/router.js";
import { defaultV1Guard, displayHost, LOOPBACK, resolveBindAddress, withCockpitToken, type CockpitHandler } from "../../router/cockpit-auth.js";
import { cachedRows, cachedSessionMap, cachedWorkerWindows, handleCockpit } from "../../router/cockpit.js";
import { LimitsCache } from "../../router/limits.js";
import { listenRetry } from "../../router/listen.js";
import { drainServers } from "../../router/drain.js";
import { SystemMonitor } from "../../router/system.js";
import { readWorkersSection } from "../../workers/config.js";
import { aggregate, aggregateBySession, appendUsage, formatSessionStats, formatStats, parseSince, readUsage, type UsageRow } from "../../router/usage.js";
import { loadSessionMap, loadWorkerWindows, sessionDisplayName, withWorkerAttribution } from "../../router/sessions.js";
import { ROUTER_LOG_FILE, ROUTER_PID_FILE, routerRunningPid, spawnRouter, probeRouter } from "../../router/supervisor.js";
import { loadConfig } from "../../daemon/config.js";
import { CliError, type CommandDef } from "../define.js";
import { dim, ok } from "../lib/utils.js";
import { restartRouter } from "../../router/restart.js";

const out = (s: string) => void process.stdout.write(s + "\n");

const startCommand: CommandDef = {
  name: "start",
  summary: "Start the router in the background",
  description: "Starts the local model router (127.0.0.1:8790). If it is already running, says so and does nothing.",
  examples: ["pai router start", "pai router status"],
  seeAlso: ["pai router stop", "pai router status"],
  run() {
    const pid = routerRunningPid();
    if (pid) return void out(ok(`router already running (pid ${pid})`));
    const started = spawnRouter(process.argv[1]!);
    out(ok(`router starting on 127.0.0.1:${ROUTER_PORT} (pid ${started}), log ${ROUTER_LOG_FILE}`));
  },
};

const stopCommand: CommandDef = {
  name: "stop",
  summary: "Stop the router",
  description: "Stops the background router. If it is not running, says so.",
  examples: ["pai router stop", "pai router status"],
  seeAlso: ["pai router start"],
  run() {
    const pid = routerRunningPid();
    if (!pid) return void out(dim("router not running"));
    process.kill(pid, "SIGTERM");
    try {
      unlinkSync(ROUTER_PID_FILE);
    } catch {
      /* already gone */
    }
    out(ok(`router stopped (pid ${pid})`));
  },
};

const statusCommand: CommandDef = {
  name: "status",
  summary: "Show whether the router is running",
  description: "Says whether the router runs and whether the daemon restarts it when it is down.",
  examples: ["pai router status", "pai router start"],
  seeAlso: ["pai router start", "pai router stop"],
  run() {
    const pid = routerRunningPid();
    const managed = loadConfig().router.enabled;
    const note = managed ? "daemon-managed: restarted if down" : "not daemon-managed (router.enabled is false)";
    out(pid ? ok(`router running (pid ${pid}, port ${ROUTER_PORT}); ${note}`) : dim(`router not running; ${note}`));
  },
};

const runCommand: CommandDef = {
  name: "run",
  summary: "Run the router in the foreground",
  description:
    "Runs the router in this terminal until you press Ctrl-C. `pai router start` uses this to run it in the background.\n" +
    "A port other than the default never touches the pid file.",
  options: [
    { name: "port", type: "string", value: "PORT", default: String(ROUTER_PORT), summary: "Port to listen on" },
    { name: "usage-file", type: "string", value: "PATH", summary: "Read the cockpit's accounting from this file and record nothing (second instances)" },
    { name: "wait-bind", type: "string", value: "SECONDS", summary: "Retry binding the port for up to this many seconds while another router still holds it (used by `pai router restart`)" },
  ],
  examples: ["pai router run", "pai router run --port 8791 --usage-file ./usage.jsonl"],
  seeAlso: ["pai router start"],
  run(ctx) {
    const port = Number(ctx.opts.port);
    const usageFile = ctx.opts["usage-file"] as string | undefined;
    const managed = port === ROUTER_PORT;
    // router.bind: "loopback" (default) | "tailscale" | an explicit IPv4; 0.0.0.0 is never accepted.
    const bindName = loadConfig().router.bind ?? "loopback";
    const addr = resolveBindAddress(bindName);
    if (!addr) {
      throw new CliError(`cannot resolve router.bind "${bindName}" — use "loopback", "tailscale", or an IPv4 (never 0.0.0.0)`, "pai daemon status");
    }
    const remote = addr !== LOOPBACK;
    const token = undefined as string | undefined; // no auth ceremony on the tailnet
    const rows = cachedRows(usageFile);
    const limits = new LimitsCache({ providers: () => readWorkersSection().workers.providers, rows });
    const system = new SystemMonitor();
    const serve: CockpitHandler = (req, res) => handleCockpit(req, res, limits, rows, cachedSessionMap(), system, cachedWorkerWindows());
    const cockpit = token ? withCockpitToken(token, serve) : serve;
    const append = usageFile ? () => undefined : (row: UsageRow) => appendUsage(row);
    const handler = routerHandler(undefined, undefined, undefined, append, cockpit, { ...(remote ? { remoteAllowed: defaultV1Guard } : {}), isUp: limits.isUp });
    return new Promise<number>(() => {
      const server = http.createServer(handler);
      const tail = remote ? http.createServer(handler) : undefined;
      const waitBindMs = Math.min(10, Number(ctx.opts["wait-bind"] ?? 0) || 0) * 1000;
      listenRetry(server, port, "127.0.0.1", { waitMs: waitBindMs }).then(() => {
        if (!managed) return;
        mkdirSync(dirname(ROUTER_PID_FILE), { recursive: true });
        writeFileSync(ROUTER_PID_FILE, String(process.pid));
      }, (e: unknown) => {
        process.stderr.write(`pai: router: ${(e as Error).message}\n`);
        process.exit(1);
      });
      if (tail) {
        listenRetry(tail, port, addr, { waitMs: waitBindMs }).then(async () => {
          out(ok(`cockpit beyond loopback: http://${await displayHost(addr)}:${port}/cockpit`));
        }, (e: unknown) => {
          process.stderr.write(`pai: router ${addr}: ${(e as Error).message}\n`);
          process.exit(1);
        });
      }
      const bye = () => {
        void drainServers(tail ? [server, tail] : [server], { timeoutMs: 120000 }).then(() => {
          if (managed) {
            try {
              if (readFileSync(ROUTER_PID_FILE, "utf8").trim() === String(process.pid)) unlinkSync(ROUTER_PID_FILE);
            } catch {
              /* ignore */
            }
          }
          process.exit(0);
        });
      };
      process.on("SIGTERM", bye);
      process.on("SIGINT", bye);
    });
  },
};

const restartCommand: CommandDef = {
  name: "restart",
  summary: "Restart the router without refusing connections",
  description: "Starts a new router that waits for the port, then stops the old one, which finishes its in-flight streams first. Prints the longest refused interval.",
  examples: ["pai router restart"],
  seeAlso: ["pai router start", "pai router stop"],
  async run() {
    const result = await restartRouter({
      oldPid: routerRunningPid() ?? undefined,
      spawnNew: () => spawnRouter(process.argv[1]!, ["--wait-bind", "10"]),
      signalOld: (pid) => process.kill(pid, "SIGTERM"),
      isUp: () => probeRouter(ROUTER_PORT, 500)
    });
    out(ok(`router restarted (new pid ${result.newPid}, old pid ${result.oldPid ?? "none"}, refused for ${result.gapMs ?? 0} ms)`));
  },
};

const statsCommand: CommandDef = {
  name: "stats",
  summary: "Token and cache totals per provider and model",
  description: "Reads the router's usage log and prints totals, grouped by provider (default) or by session.",
  options: [
    { name: "since", type: "string", value: "SPAN", summary: "Only the last span, e.g. 30m, 1h, 2d" },
    { name: "by", type: "string", value: "KEY", default: "provider", summary: "Group by provider or session" },
  ],
  examples: ["pai router stats", "pai router stats --since 2d --by session"],
  seeAlso: ["pai router status"],
  run(ctx) {
    let since: number | undefined;
    try {
      since = ctx.opts.since ? parseSince(String(ctx.opts.since)) : undefined;
    } catch (e) {
      throw new CliError((e as Error).message, "pai router stats --since 1h");
    }
    if (ctx.opts.by === "session") {
      const rows = readUsage();
      const map = withWorkerAttribution(loadSessionMap(), rows, loadWorkerWindows());
      out(formatSessionStats(aggregateBySession(rows, since, Date.now(), (id) => sessionDisplayName(id, map))));
    } else out(formatStats(aggregate(readUsage(), since)));
  },
};

export const routerCommand: CommandDef = {
  name: "router",
  summary: "Local model router: start, stop, restart, status, run, stats",
  description: `A local router on 127.0.0.1:${ROUTER_PORT}: set ANTHROPIC_BASE_URL to it and /model picks the provider.`,
  examples: ["pai router status", "pai router stats --since 1d"],
  seeAlso: ["pai worker policy", "pai providers"],
  subcommands: [startCommand, stopCommand, restartCommand, statusCommand, runCommand, statsCommand],
};
