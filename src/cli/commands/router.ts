/**
 * `pai router start|stop|status|run|stats` — local model router on router.port.
 * See src/router/router.ts. Names, flags and stdout match the old CLI.
 */

import { parkConfigFrom, setParkConfigSource, sharedParker } from "../../router/parking.js";
import http from "node:http";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { startStallMonitor } from "../../router/stall.js";
import { routerHandler, routerPort } from "../../router/router.js";
import { defaultV1Guard, displayHost, resolveBindAddress, withCockpitToken, type CockpitHandler } from "../../router/cockpit-auth.js";
import { cachedRows, cachedSessionMap, cachedWorkerWindows, handleCockpit, setActionHooks, warmCockpit, setRuntimeSampler, setEndpointHealth } from "../../router/cockpit.js";
import { createEndpointHealth } from "../../workers/endpoint-health.js";
import { createRuntimeSampler, routerSamplerDeps, runtimeSampleSettings } from "../../router/runtime-samples.js";
import { LimitsCache } from "../../router/limits.js";
import { exportDefaultLayout } from "../../router/cockpit-layout-default.js";
import { cockpitProbeSettings } from "../../router/cockpit-layout.js";
import { listenRetry } from "../../router/listen.js";
import { drainServers } from "../../router/drain.js";
import { SystemMonitor } from "../../router/system.js";
import { readWorkersSection } from "../../workers/config.js";
import { aggregate, aggregateBySession, appendUsage, formatSessionStats, formatStats, parseSince, readUsage, type UsageRow } from "../../router/usage.js";
import { loadSessionMap, loadWorkerWindows, sessionDisplayName, withWorkerAttribution } from "../../router/sessions.js";
import { trackInflight } from "../../router/inflight.js";
import { routerSwapArgs, startHandover, routerHandoverFile, routerHandoverStatusFile, readHandoverStatus, routerLogFile, routerPidFile, routerRunningPid, spawnRouter, probeRouter } from "../../router/supervisor.js";
import { engineControlReader } from "../../workers/engine-control.js";
import { mirrorTo, schedConfigFrom, setSchedConfigSource, sharedScheduler, type SchedConfig } from "../../router/scheduler.js";
import { ledgerPath, workersLogDir } from "../../workers/paths.js";
import { appendLedger } from "../../workers/ledger.js";
import { loadConfig } from "../../daemon/config.js";
import { CliError, type CommandDef } from "../define.js";
import { dim, ok } from "../lib/utils.js";
import { routerRestartText, routerStartText, routerStatusText, routerStopText } from "../../router/service-control.js";
import { LOOPBACK_HOST } from "../../utils/loopback.js";
import { abortMessage, diagnoseSuccessor, preflightFirst, preflightUpstreams } from "../../router/preflight.js";

const out = (s: string) => void process.stdout.write(s + "\n");

const startCommand: CommandDef = {
  name: "start",
  summary: "Start the router in the background",
  description: "Starts the local model router (127.0.0.1:<router.port>). If it is already running, says so and does nothing.",
  examples: ["pai router start", "pai router status"],
  seeAlso: ["pai router stop", "pai router status"],
  run() {
    out(ok(routerStartText(process.argv[1]!)));
  },
};

const stopCommand: CommandDef = {
  name: "stop",
  summary: "Stop the router",
  description: "Stops the background router. If it is not running, says so.",
  examples: ["pai router stop", "pai router status"],
  seeAlso: ["pai router start"],
  run() {
    const text = routerStopText();
    out(text === "router not running" ? dim(text) : ok(text));
  },
};

const statusCommand: CommandDef = {
  name: "status",
  summary: "Show whether the router is running",
  description: "Says whether the router runs and whether the daemon restarts it when it is down.",
  examples: ["pai router status", "pai router start"],
  seeAlso: ["pai router start", "pai router stop"],
  run() {
    const text = routerStatusText();
    out(text.startsWith("router running") ? ok(text) : dim(text));
  },
};

const runCommand: CommandDef = {
  name: "run",
  summary: "Run the router in the foreground",
  description:
    "Runs the router in this terminal until you press Ctrl-C. `pai router start` uses this to run it in the background.\n" +
    "A port other than the default never touches the pid file.",
  options: [
    { name: "port", type: "string", value: "PORT", default: String(routerPort()), summary: "Port to listen on" },
    { name: "replace", type: "string", value: "PID", summary: "After warming up, stop this router (SIGTERM) and take over its port (used by `pai router restart`)" },
    { name: "inherit-fds", type: "string", value: "FDS", summary: "Listen on already-open sockets (fd[,fd of the beyond-loopback listener]) handed over by a router that is being replaced; reports ready over IPC" },
    { name: "usage-file", type: "string", value: "PATH", summary: "Read the cockpit's accounting from this file and record nothing (second instances)" },
    { name: "wait-bind", type: "string", value: "SECONDS", summary: "Retry binding the port for up to this many seconds while another router still holds it (used by `pai router restart`)" },
  ],
  examples: ["pai router run", "pai router run --port 8791 --usage-file ./usage.jsonl"],
  seeAlso: ["pai router start"],
  run(ctx) {
    const port = Number(ctx.opts.port);
    const usageFile = ctx.opts["usage-file"] as string | undefined;
    const managed = port === routerPort();
    // router.bind: "loopback" (default) | "tailscale" | an explicit IPv4; 0.0.0.0 is never accepted.
    const bindName = loadConfig().router.bind ?? "loopback";
    const addr = resolveBindAddress(bindName);
    if (!addr) {
      throw new CliError(`cannot resolve router.bind "${bindName}" — use "loopback", "tailscale", or an IPv4 (never 0.0.0.0)`, "pai daemon status");
    }
    const remote = addr !== LOOPBACK_HOST;
    // Host-header perimeter (router.allowedHosts): every listener — loopback
    // included, the main DNS-rebinding target — must refuse a rebinding
    // client whose Host is an attacker's domain. hostAllowed already accepts
    // 127.0.0.1, localhost and [::1], so proxy traffic passes on loopback.
    const extraHosts = (loadConfig().router.allowedHosts ?? []).filter((h) => h.trim());
    const hosts = { bind: bindName || addr, extraHosts };
    if (remote && extraHosts.length === 0) {
      process.stderr.write("pai: router: router.allowedHosts is empty: the cockpit opened by tailnet hostname will be refused (403); add the name to router.allowedHosts\n");
    }
    const token = undefined as string | undefined; // no auth ceremony on the tailnet
    const replace = Number(ctx.opts.replace ?? 0);
    const inheritFds = String(ctx.opts["inherit-fds"] ?? "").split(",").filter(Boolean).map(Number);
    // A successor takes over only if it can itself reach the upstream: a process that cannot resolve api.anthropic.com
    // (lockout 2026-10-24) must never replace one that can. On failure the old router keeps serving.
    const preflight = async (): Promise<void> => {
      if (!replace && !inheritFds.length) return;
      const cloud = Object.values(readWorkersSection().workers.providers).filter((p) => p.enabled && !p.native && /^https:/.test(p.baseUrl ?? "")).map((p) => p.baseUrl);
      const { claude, others } = await preflightUpstreams(loadConfig().router.claudeUpstream, cloud);
      for (const o of others) if (!o.ok) process.stderr.write(`pai: router: preflight: cannot reach ${o.host}: ${o.code}\n`);
      if (claude.ok) return;
      const oldPid = replace || process.ppid;
      const diag = await diagnoseSuccessor(claude.host);
      process.stderr.write(`pai: router: preflight trace ${JSON.stringify({ ...claude.trace, processStart: Math.round(Date.now() - process.uptime() * 1000) })}\n`);
      const reason = abortMessage(claude.host, claude.code, oldPid, diag);
      process.stderr.write(`pai: router: ${reason}\n`);
      try {
        appendLedger(ledgerPath(workersLogDir(readWorkersSection().workers)), "ROUTER-PREFLIGHT-FAIL", { host: claude.host, code: claude.code ?? "unknown", diag: diag.replace(/\s+/g, "_"), trace: JSON.stringify({ ...claude.trace, processStart: Math.round(Date.now() - process.uptime() * 1000) }) });
      } catch {
        /* ledger is best effort */
      }
      if (process.send) process.send({ failed: true, reason: `successor cannot reach ${claude.host}: ${claude.code}`, diag });
      else if (managed) writeFileSync(routerHandoverStatusFile(), JSON.stringify({ oldPid, state: "failed", reason: `successor cannot reach ${claude.host}: ${claude.code}`, successorPid: process.pid, diag }));
      await new Promise((r) => setTimeout(r, 100)); // let the IPC message flush
      process.exit(1);
    };
    const guarded = (): Promise<void> =>
      preflight().catch((e: unknown) => {
        process.stderr.write(`pai: router: preflight error: ${(e as Error).message}\n`);
        process.exit(1);
      });
    return preflightFirst(guarded, () => {
      const rows = cachedRows(usageFile);
      let schedCache: { at: number; cfg: SchedConfig } | undefined;
      setSchedConfigSource(() => {
        if (!schedCache || Date.now() - schedCache.at > 10_000) {
          let cfg: SchedConfig;
          try {
            cfg = schedConfigFrom(loadConfig().router.scheduling);
          } catch {
            cfg = schedConfigFrom(undefined);
          }
          schedCache = { at: Date.now(), cfg };
        }
        return schedCache.cfg;
      });
      setParkConfigSource(() => {
        try {
          return parkConfigFrom(loadConfig().router.parking);
        } catch {
          return parkConfigFrom(undefined);
        }
      });
      // cockpit Models cards: the sampler's policy values (router.samples)
      const sampleCfg = (): ReturnType<typeof runtimeSampleSettings> => {
        try {
          return runtimeSampleSettings(loadConfig().router.samples);
        } catch {
          return runtimeSampleSettings(undefined);
        }
      };
      sharedParker().sweep();
      // per-worker priority and pause: read from the worker's status file at every admission
      sharedScheduler().control ??= engineControlReader(() => workersLogDir(readWorkersSection().workers));
      if (managed) mirrorTo(sharedScheduler(), () => workersLogDir(readWorkersSection().workers));
      // local-server probe policy (router.cockpit.probe), re-read per poll like the other config sources
      const limits = new LimitsCache({
        providers: () => readWorkersSection().workers.providers,
        rows,
        get probe() {
          return cockpitProbeSettings();
        },
      });
      const system = new SystemMonitor();
      system.startRing(); // the ring must not depend on an open cockpit page
      // cockpit Models cards: the 5 s ring of live readings per running runtime (runtime-samples.ts)
      const sampler = createRuntimeSampler(
        routerSamplerDeps(() => sharedScheduler().snapshot(), () => sampleCfg().engineStatusTimeoutMs),
        () => readWorkersSection().workers,
        () => workersLogDir(readWorkersSection().workers),
        () => {
          const c = system.cachedSample();
          return c && c.memUsed != null && c.memTotal ? (c.memUsed / c.memTotal) * 100 : null;
        },
        sampleCfg
      );
      sampler.start();
      setRuntimeSampler(sampler);
      // cockpit action endpoint: local server start/stop runs the same code path
      // as `pai worker local <tier>` / `off` (spawn + wait, detached from the request)
      setActionHooks({
        runLocalJob: async (kind, tier) => {
          const { startTier, stopAll } = await import("./worker-config.js");
          const { readLocalConfig } = await import("../../workers/local-tiers.js");
          const { workersYamlPath } = await import("../../workers/workers-config.js");
          const cfg = readLocalConfig(workersYamlPath());
          if (kind === "off") return void (await stopAll(cfg));
          const t = cfg.tiers[tier];
          if (!t) throw new Error(`no tier "${tier}"`);
          await startTier(cfg, tier, t);
        },
      });
      // built once: each holds its own TTL cache, so a new one per request would reread every status file on every poll
      const sessionMap = cachedSessionMap();
      const workerWindows = cachedWorkerWindows();
      warmCockpit(rows, sessionMap, workerWindows); // the first build walks every status file: before the port opens, not in a request
      const endpointHealth = createEndpointHealth(); // one probe cache for the router and the cockpit
      setEndpointHealth(endpointHealth);
      const serve: CockpitHandler = (req, res) => handleCockpit(req, res, limits, rows, sessionMap, system, workerWindows);
      const cockpit = token ? withCockpitToken(token, serve) : serve;
      const append = usageFile ? () => undefined : (row: UsageRow) => appendUsage(row);
      const inner = routerHandler(undefined, undefined, undefined, append, cockpit, { hosts, ...(remote ? { remoteAllowed: defaultV1Guard } : {}), isUp: limits.isUp, health: endpointHealth });
      const stalls = startStallMonitor({ thresholdMs: cockpitProbeSettings().stallLogMs, log: (l) => process.stderr.write(l + "\n") });
      const handler = stalls.wrap(inner);
      // backstop: a stray exception is logged, it does not take the proxy down
      process.on("uncaughtException", (e) => process.stderr.write(`pai: router: uncaught exception: ${(e as Error)?.stack ?? String(e)}\n`));
      return new Promise<number>(() => {
        // after SIGTERM the open keep-alive sockets stay served by this process, each reply tells its client to reconnect (to the new router)
        let draining = false;
        const inflight = trackInflight();
        const tracked = inflight.wrap(handler);
        const serving: typeof handler = (req, res) => {
          if (draining) res.setHeader("Connection", "close");
          return tracked(req, res);
        };
        const server = http.createServer(serving);
        const tail = remote ? http.createServer(serving) : undefined;
        const waitBindMs = Math.min(10, Number(ctx.opts["wait-bind"] ?? 0) || 0) * 1000;
        {
        // the old router keeps serving through this process's warm-up: it is stopped only now, so the port is refused for one retry interval
        if (replace > 0) {
          try {
            process.kill(replace, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        const claimPidFiles = () => {
          if (!managed) return;
          mkdirSync(dirname(routerPidFile()), { recursive: true });
          writeFileSync(routerPidFile(), String(process.pid));
          writeFileSync(routerHandoverFile(), String(process.pid));
        };
        const bound = inheritFds.length
          ? new Promise<void>((resolve) => server.listen({ fd: inheritFds[0]! }, resolve))
          : listenRetry(server, port, LOOPBACK_HOST, { waitMs: waitBindMs, intervalMs: 1 });
        bound.then(() => {
          claimPidFiles();
          process.send?.({ ready: true });
        }, (e: unknown) => {
          process.stderr.write(`pai: router: ${(e as Error).message}\n`);
          process.exit(1);
        });
        if (tail) {
          const tailBound = inheritFds.length > 1
            ? new Promise<void>((resolve) => tail.listen({ fd: inheritFds[1]! }, resolve))
            : listenRetry(tail, port, addr, { waitMs: waitBindMs, intervalMs: 1 });
          tailBound.then(async () => {
            out(ok(`cockpit beyond loopback: http://${await displayHost(addr)}:${port}/cockpit`));
          }, (e: unknown) => {
            process.stderr.write(`pai: router ${addr}: ${(e as Error).message}\n`);
            process.exit(1);
          });
        }
        }
        // a handover keeps the old router alive for its in-flight streams: bounded by router.handover.drainMaxSecs, then they end with a retryable error
        const bye = (handedOver = false) => {
          draining = true;
          const maxMs = handedOver ? (loadConfig().router.handover?.drainMaxSecs ?? 1800) * 1000 : loadConfig().router.drainMs;
          if (handedOver) {
            writeFileSync(routerHandoverStatusFile(), JSON.stringify({ oldPid: process.pid, state: "draining", inflight: inflight.count() }));
            process.stderr.write(`pai: router: handed over, finishing ${inflight.count()} in-flight request(s) (at most ${maxMs / 1000}s)\n`);
          }
          void drainServers(tail ? [server, tail] : [server], {
            timeoutMs: maxMs,
            idleGraceMs: 1500,
            onTimeout: () => {
              const n = inflight.endAll("router restarted, retry the request");
              if (n) process.stderr.write(`pai: router: drain limit reached, ended ${n} request(s) with a retryable error\n`);
            },
          }).then(() => {
            if (managed) {
              try {
                if (readFileSync(routerPidFile(), "utf8").trim() === String(process.pid)) unlinkSync(routerPidFile());
              } catch {
                /* ignore */
              }
            }
            process.exit(0);
          });
        };
        // SIGUSR2: spawn the successor on this router's listening sockets (inherited fds, so the accept queue is never closed), stop accepting once it is ready, drain, exit
        let handing = false;
        process.on("SIGUSR2", () => {
          if (handing || draining) return;
          const handles = [server, ...(tail ? [tail] : [])].map((s) => (s as unknown as { _handle?: { fd?: number } })._handle?.fd);
          if (handles.some((fd) => typeof fd !== "number" || fd < 0)) {
            process.stderr.write("pai: router: handover skipped, listening fd unavailable\n");
            return;
          }
          handing = true;
          mkdirSync(dirname(routerLogFile()), { recursive: true });
          const log = openSync(routerLogFile(), "a");
          const child = spawn(
            process.execPath,
            [process.argv[1]!, "router", "run", "--port", String(port), "--inherit-fds", handles.map((_, i) => 3 + i).join(","), ...(usageFile ? ["--usage-file", usageFile] : [])],
            { detached: true, stdio: ["ignore", log, log, ...(handles as number[]), "ipc"] }
          );
          closeSync(log);
          const giveUp = setTimeout(() => child.kill("SIGKILL"), 30_000);
          let failedReason: string | undefined;
          let failedDiag: string | undefined;
          child.once("exit", () => {
            clearTimeout(giveUp);
            if (handing) {
              handing = false;
              const reason = failedReason ?? "successor exited before taking over";
              process.stderr.write(`pai: router: ${reason}, still serving\n`);
              writeFileSync(routerHandoverStatusFile(), JSON.stringify({ oldPid: process.pid, state: "failed", reason, ...(failedDiag ? { diag: failedDiag } : {}) }));
            }
          });
          child.on("message", (m: { ready?: boolean; failed?: boolean; reason?: string; diag?: string }) => {
            if (m?.failed) {
              failedReason = m.reason;
              failedDiag = m.diag;
              return;
            }
            if (!m?.ready) return;
            clearTimeout(giveUp);
            child.removeAllListeners("exit");
            child.disconnect();
            child.unref();
            bye(true);
          });
        });
        process.on("SIGTERM", () => bye());
        process.on("SIGINT", () => bye());
      });
    });
  },
};

const restartCommand: CommandDef = {
  name: "restart",
  summary: "Restart the router without refusing connections",
  description: "Starts a new router that waits for the port, then stops the old one, which finishes its in-flight streams first. Prints the longest refused interval.",
  examples: ["pai router restart", "pai router status"],
  seeAlso: ["pai router start", "pai router stop"],
  async run() {
    try {
      out(ok(await routerRestartText(process.argv[1]!)));
    } catch (e) {
      throw new CliError((e as Error).message, "pai router status");
    }
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
  description: `A local router on ${LOOPBACK_HOST}:${routerPort()}: set ANTHROPIC_BASE_URL to it and /model picks the provider.`,
  examples: ["pai router status", "pai router stats --since 1d"],
  seeAlso: ["pai worker policy", "pai providers"],
  subcommands: [startCommand, stopCommand, restartCommand, statusCommand, runCommand, statsCommand],
};

const layoutExportCommand: CommandDef = {
  name: "export",
  summary: "Write the saved default cockpit layout to the repo's shipped defaults file",
  description: "Copies the layout the cockpit's \"save as default\" button saved (PAI_HOME/cockpit-layout-default.json) to src/config/defaults/cockpit-layout.json, which ships with the package and is what a new install's devices start from. Only runs on this command; commit the file afterwards.",
  options: [{ name: "to", type: "string", value: "FILE", summary: "Write here instead of the checkout's shipped file" }],
  examples: ["pai cockpit layout export"],
  seeAlso: ["pai router status"],
  run(ctx) {
    try {
      out(ok(`wrote ${exportDefaultLayout({ to: ctx.opts.to ? String(ctx.opts.to) : undefined })}`));
    } catch (e) {
      throw new CliError((e as Error).message, "pai cockpit layout export");
    }
  },
};

export const cockpitCommand: CommandDef = {
  name: "cockpit",
  summary: "The router's web cockpit: layout export",
  description: "Maintenance for the cockpit page served by the router.",
  examples: ["pai cockpit layout export"],
  seeAlso: ["pai router status"],
  subcommands: [{ name: "layout", summary: "The cockpit's default window layout", description: "The default layout new devices start from.", examples: ["pai cockpit layout export"], seeAlso: [], subcommands: [layoutExportCommand] }],
};
