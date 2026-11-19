/**
 * restart-health.ts — every dist rebuild that restarts the daemons is HEALTH-CHECKED,
 * and a failing check rolls back.
 *
 * The night of 2026-11-17/18: restarts after `pai worker merge` left the daemons
 * unable to come up again and the whole night was lost. "The daemon restarts
 * itself on the new build" was a promise, never a check. This makes the restart
 * safe by construction, around any rebuild of a running PAI's dist:
 *
 *   1. before the build, ONE generation back is kept — `dist.prev` beside dist —
 *      plus the previous daemon's start command (launchd's ProgramArguments, or
 *      systemd's ExecStart);
 *   2. after the restart, a bounded health check (default 60 s): the daemon pid is
 *      alive and answers its status call; the router answers GET /cockpit/data with
 *      200 on its configured bind AND on the loopback fallback; every local runtime
 *      that was up before is still reachable — or busy. Busy is not down (the
 *      engine at full slots whose readiness times out is working: its port accepts
 *      a connection, or the router's scheduler has requests in flight for it);
 *   3. a failing check restores dist.prev, restarts on it and checks again; the
 *      merge is marked reverted (a git revert commit) and the ledger line says
 *      `restart failed health check: <what>; rolled back to <old version>`; the
 *      owning session's mailbox gets the notice. The machine is never left without
 *      a running daemon and router.
 *
 * The same gate wraps `pai release`'s build step (src/release/release.ts) and is
 * what AIBroker's dist-watch self-restart is expected to satisfy before it
 * SIGTERMs itself (documented in the AIBroker repo; not changed here).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveBindAddress } from "../router/cockpit-auth.js";
import { LOOPBACK_HOST } from "../utils/loopback.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";
import { pidAlive } from "./status.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";
import { loadConfig } from "../daemon/config.js";
import { resolveDaemonPid, LAUNCHD_LABEL, currentUid } from "../daemon/daemon-pid.js";
import { PaiClient } from "../daemon/ipc-client.js";
import { routerPort } from "../router/router.js";
import { routerRunningPid } from "../router/supervisor.js";
import { readRuntimeCommands, readyIsUrl, liveRuntimeOpDeps } from "./model-runtimes.js";
import { readLocalConfig, healthUrl, type LocalTier } from "./local-tiers.js";
import { workersYamlPath } from "./workers-config.js";
import { runtimeAutostartConfig, liveRuntimeAlive } from "../daemon/runtime-autostart.js";
import { originFromEnv, aibrokerMessenger } from "./run-events.js";

/** The health check waits at most this long for each component to answer. */
export const RESTART_HEALTH_WINDOW_MS = 60_000;
const POLL_MS = 2_000;

export interface RestartHealthDeps {
  /** The daemon's pid, undefined when nothing runs. */
  daemonPid: () => number | undefined;
  /** True while that pid is a live process. */
  pidAlive: (pid: number) => boolean;
  /** The daemon answers its status call (the same IPC `pai daemon status` uses). */
  daemonStatusOk: () => Promise<boolean>;
  /** GET url → true only on HTTP 200. */
  http200: (url: string) => Promise<boolean>;
  routerPort: () => number;
  /** The concrete address `router.bind` names (null = unresolved). Loopback is always probed too. */
  bindAddress: () => string | null;
  /** The running router's pid, or undefined. */
  routerPid: () => number | undefined;
  /** Readiness of a runtime that was up before the restart. */
  runtimeUp: (name: string) => Promise<boolean>;
  /** Liveness of that runtime: port accepts, or requests in flight — busy, not down. */
  runtimeAlive: (name: string) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HealthOutcome {
  ok: boolean;
  /** What failed, in order of first failure; empty when ok. */
  failures: string[];
  ms: number;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One component's verdict inside the window: true once its check answers true. */
async function awaitUp(what: () => Promise<boolean>, d: RestartHealthDeps, deadline: number): Promise<boolean> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? sleepReal;
  for (;;) {
    let up = false;
    try {
      up = await what();
    } catch {
      /* a failed probe reads not-up yet */
    }
    if (up) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * The post-restart health check: daemon, router (bind + loopback), and every runtime
 * that was up before — reachable or busy. Each component gets the whole window;
 * they are probed in parallel, so a healthy restart returns fast.
 */
export async function checkRestartHealth(runtimesUpBefore: string[], d: RestartHealthDeps): Promise<HealthOutcome> {
  const t0 = (d.now ?? Date.now)();
  const deadline = t0 + RESTART_HEALTH_WINDOW_MS;
  const port = d.routerPort();
  const bind = d.bindAddress();
  const routerUrl = (host: string): string => `http://${host}:${port}/cockpit/data`;
  const [daemonOk, bindOk, loopOk, ...runtimeStates] = await Promise.all([
    awaitUp(async () => {
      const pid = d.daemonPid();
      return pid !== undefined && d.pidAlive(pid) && (await d.daemonStatusOk());
    }, d, deadline),
    // the configured bind answers only when one is configured beyond loopback; "loopback"/unset resolves to 127.0.0.1 and needs no second probe
    awaitUp(async () => bind === null || bind === LOOPBACK_HOST || (await d.http200(routerUrl(bind))), d, deadline),
    awaitUp(async () => await d.http200(routerUrl(LOOPBACK_HOST)), d, deadline),
    ...runtimesUpBefore.map(async (name): Promise<string | null> => {
      const up = await awaitUp(() => d.runtimeUp(name), d, deadline);
      if (up) return null;
      // busy is not down: liveness alive (port accepts, scheduler in flight) while readiness is slow reads healthy
      const alive = await awaitUp(() => d.runtimeAlive(name), d, deadline);
      return alive ? null : `runtime ${name} is neither reachable nor busy`;
    }),
  ]);
  const failures: string[] = [];
  if (!daemonOk) {
    const pid = d.daemonPid();
    failures.push(pid === undefined ? "no daemon is running" : !d.pidAlive(pid) ? `daemon pid ${pid} is not alive` : "the daemon does not answer its status call");
  }
  const routerDown = !loopOk || !bindOk;
  if (routerDown) {
    const rpid = d.routerPid();
    failures.push(
      `the router does not answer GET /cockpit/data with 200 on ${bind && bind !== LOOPBACK_HOST ? `${bind} and ` : ""}${LOOPBACK_HOST}:${port}` +
        (rpid === undefined ? " (no router pid is running)" : "")
    );
  }
  for (const f of runtimeStates) if (f) failures.push(f);
  const ms = (d.now ?? Date.now)() - t0;
  d.log?.(`restart health check: ${failures.length ? `FAILED (${failures.join("; ")})` : "ok"} in ${Math.round(ms / 1000)}s`);
  return { ok: failures.length === 0, failures, ms };
}

// ---------------------------------------------------------------------------
// live deps
// ---------------------------------------------------------------------------

const httpStatus = async (url: string): Promise<number | undefined> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    return r.status;
  } catch {
    return undefined;
  }
};

/** The runtime's readiness probe — the same resolution the daemon's autostart uses. */
async function liveRuntimeUp(name: string): Promise<boolean> {
  const cmd = readRuntimeCommands()[name];
  let tiers: LocalTier[] = [];
  try {
    tiers = Object.values(readLocalConfig(workersYamlPath()).tiers);
  } catch {
    /* unreadable local_tiers: only a models.runtimes entry can be probed */
  }
  // the same resolution the autostart uses: a command-less entry is a local_tiers model (its ready URL may be a {port} template)
  const tier = !cmd?.start ? runtimeAutostartConfig(readRuntimeCommands(), tiers).tiers?.[name] : undefined;
  if (tier) return liveRuntimeOpDeps.getUrl(healthUrl(tier, tier.port));
  if (!cmd?.ready) {
    // no readiness configured: liveness is all there is to ask
    return liveRuntimeAlive(name);
  }
  // a models.runtimes entry has its own ready URL/command: no {port} template to expand there
  return readyIsUrl(cmd.ready) ? liveRuntimeOpDeps.getUrl(cmd.ready) : (await liveRuntimeOpDeps.runCmd(cmd.ready)) === 0;
}

/**
 * The runtimes that were UP before the restart — the set the check must find up or busy after it.
 * Probed once, before anything restarts (a restarted daemon does not know what was up before): a runtime
 * answers its readiness now, or is alive and working (its port accepts, or requests are in flight) —
 * busy is not down; a truly down autostart runtime is starting anyway and joins the demanded set.
 */
export async function runtimesUpBefore(): Promise<string[]> {
  let tiers: LocalTier[] = [];
  try {
    tiers = Object.values(readLocalConfig(workersYamlPath()).tiers);
  } catch {
    /* no readable local_tiers: the runtimes block alone decides */
  }
  const cfg = runtimeAutostartConfig(readRuntimeCommands(), tiers);
  if (!cfg.enabled) return [];
  const out: string[] = [];
  for (const name of Object.keys(cfg.runtimes)) {
    try {
      if (await liveRuntimeUp(name)) {
        out.push(name);
        continue;
      }
      // busy is not down: alive (port accepts, scheduler in flight) while readiness is slow means it was up and working
      if (await liveRuntimeAlive(name)) out.push(name);
    } catch {
      /* unreadable runtime: nothing to demand of it */
    }
  }
  return out;
}


/** The previous daemon's start command: launchd's ProgramArguments (macOS) or systemd's ExecStart (Linux); null when neither answers. */
export function previousDaemonStartCommand(platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === "darwin") {
    const uid = currentUid();
    if (uid === undefined) return null;
    const r = spawnSync("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const args = /program arguments = \(([\s\S]*?)\)/.exec(r.stdout ?? "")?.[1];
    if (!args) return null;
    const argv = args.split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
    return argv.length ? argv : null;
  }
  if (platform === "linux") {
    const r = spawnSync("systemctl", ["--user", "show", "-p", "ExecStart", "pai-daemon.service"], { encoding: "utf8" });
    const line = /^ExecStart=(.+)$/m.exec(r.stdout ?? "")?.[1]?.trim();
    return line ? line.split(/\s+/).filter(Boolean) : null;
  }
  return null;
}

export const liveRestartHealthDeps = (): RestartHealthDeps => ({
  // the router's handover starts its successor as a child of the running router, so this process can be the daemon itself: our own pid counts
  daemonPid: () => resolveDaemonPid() ?? process.pid,
  pidAlive,
  daemonStatusOk: async () => {
    try {
      await new PaiClient(loadConfig().socketPath).status();
      return true;
    } catch {
      return false;
    }
  },
  http200: async (url) => (await httpStatus(url)) === 200,
  routerPort: () => loadConfig().router.port,
  bindAddress: () => resolveBindAddress(loadConfig().router.bind),
  routerPid: () => routerRunningPid() ?? undefined,
  runtimeUp: liveRuntimeUp,
  runtimeAlive: (name) => liveRuntimeAlive(name),
});

// ---------------------------------------------------------------------------
// dist.prev — one generation back, kept before the build
// ---------------------------------------------------------------------------

/** The sibling `dist.prev` of a dist dir. */
export const distPrevPath = (distDir: string): string => `${distDir.replace(/\/+$/, "")}.prev`;

/**
 * Keep ONE generation back: dist.prev becomes the current dist, replacing whatever
 * prev held. Returns false when dist is missing or unreadable (nothing to keep).
 */
export function saveDistGeneration(distDir: string): boolean {
  try {
    if (!existsSync(distDir) || !statSync(distDir).isDirectory()) return false;
    const prev = distPrevPath(distDir);
    const staging = `${prev}.${process.pid}.tmp`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(dirname(prev), { recursive: true });
    cpSync(distDir, staging, { recursive: true });
    if (existsSync(prev)) rmSync(prev, { recursive: true, force: true });
    renameSync(staging, prev);
    return true;
  } catch {
    try {
      rmSync(`${distPrevPath(distDir)}.${process.pid}.tmp`, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

/** Restore dist.prev over dist (rename-swap). True when a prev existed and the swap happened. */
export function restoreDistGeneration(distDir: string): boolean {
  const prev = distPrevPath(distDir);
  try {
    if (!existsSync(prev)) return false;
    const old = `${distDir.replace(/\/+$/, "")}.rolled-back.${process.pid}`;
    if (existsSync(distDir)) renameSync(distDir, old);
    renameSync(prev, distDir);
    rmSync(old, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The version a build served (its package root's package.json), or "the previous build" when unreadable. */
export function buildVersion(packageRoot: string): string {
  try {
    const v = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))?.version;
    return typeof v === "string" && v ? `v${v}` : "the previous build";
  } catch {
    return "the previous build";
  }
}

/** The dist dir of a repo checkout (its package root's dist/). */
export const distDirOf = (repoRoot: string): string => join(repoRoot, "dist");

// ---------------------------------------------------------------------------
// the gate: keep prev → (caller builds) → health check → roll back on failure
// ---------------------------------------------------------------------------

export interface RestartGateDeps extends RestartHealthDeps {
  /** Keep one generation of dist back; false when nothing could be kept. */
  savePrev: (distDir: string) => boolean;
  /** Restore dist.prev over dist; true when the swap happened. */
  restoreDist: (distDir: string) => boolean;
  /** Force a daemon restart on whatever dist now holds (service manager). */
  forceRestart: () => boolean;
  /** The ledger append (event, kv). */
  ledger: (event: string, kv: Record<string, string | number>) => void;
  /** Notify the owning session's mailbox (mailbox-only deposit). */
  notify?: (text: string) => Promise<void>;
  /** The runtimes that were up before the restart, probed BEFORE anything restarted. Default: {@link runtimesUpBefore}. */
  runtimesUpBefore?: () => Promise<string[]>;
}

export interface GateResult {
  ok: boolean;
  /** The line the caller prints. */
  line: string;
  rolledBack?: boolean;
  failures?: string[];
}

/**
 * Before a rebuild: keep one generation of dist back (the running build lands in
 * dist.prev) AND record which runtimes are up now — both must be known before the
 * new code starts running. The pair feeds {@link gateRestartAfterBuild}.
 */
export interface GatePrepare {
  prevKept: boolean;
  runtimesUpBefore: string[];
}

export async function prepareRestartGate(distDir: string, d: RestartGateDeps): Promise<GatePrepare> {
  const prevKept = d.savePrev(distDir);
  let runtimes: string[] = [];
  try {
    runtimes = await (d.runtimesUpBefore ?? runtimesUpBefore)();
  } catch {
    /* unreadable runtimes: the check demands nothing of them */
  }
  return { prevKept, runtimesUpBefore: runtimes };
}

/**
 * The gate AFTER a rebuild and its restarts settled: health-check daemon, router
 * and the runtimes that were up before; on a failure restore dist.prev, force the
 * daemon onto it, re-check, and report `restart failed health check: <what>;
 * rolled back to <old version>`. The caller marks the merge reverted in git when
 * this returns rolledBack. `prepared` is {@link prepareRestartGate}'s answer taken before the build.
 */
export async function gateRestartAfterBuild(distDir: string, d: RestartGateDeps, prepared: GatePrepare): Promise<GateResult> {
  // the set of runtimes to demand was fixed BEFORE any restart happened (a restarted daemon does not know what was up before)
  const runtimes = prepared.runtimesUpBefore;
  const first = await checkRestartHealth(runtimes, d);
  if (first.ok) {
    const line = `restart health: ok (daemon and router answer${runtimes.length ? `, ${runtimes.length} local runtime(s) up or busy` : ""}, ${Math.round(first.ms / 1000)}s)`;
    d.ledger("RESTART-HEALTH", { result: "ok", ms: first.ms, dist_prev_kept: String(prepared.prevKept) });
    return { ok: true, line };
  }
  const what = first.failures.join("; ");
  const rolled = d.restoreDist(distDir);
  let recheck = { ok: !rolled, failures: first.failures as string[] };
  if (rolled) {
    // the old build is back on disk: make the daemon run it and prove the machine serves again
    try {
      d.forceRestart();
    } catch {
      /* the check below says what stands */
    }
    const second = await checkRestartHealth([], d);
    recheck = { ok: second.ok, failures: second.failures };
  }
  const version = buildVersion(dirname(distDir));
  const line = `restart failed health check: ${what}; rolled back to ${version}${recheck.ok ? " — daemon and router answer on it" : ` — WARNING: the rollback did not come up either (${recheck.failures.join("; ")}); run \`pai daemon restart\``}`;
  d.ledger("RESTART-HEALTH", { result: "rolled-back", reason: what.slice(0, 300), rolled_back: String(rolled), to: version, recheck_ok: String(recheck.ok) });
  try {
    await d.notify?.(line);
  } catch {
    /* the notice is best effort; the ledger line stands */
  }
  return { ok: false, line, rolledBack: rolled, failures: first.failures };
}

/** The live gate deps over the real machine. */
export function liveRestartGateDeps(logDir: string): RestartGateDeps {
  return {
    ...liveRestartHealthDeps(),
    savePrev: saveDistGeneration,
    restoreDist: restoreDistGeneration,
    forceRestart: () => {
      if (process.platform === "darwin") {
        const uid = currentUid() ?? 501;
        return spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { encoding: "utf8" }).status === 0;
      }
      if (process.platform === "linux") {
        return spawnSync("systemctl", ["--user", "restart", "pai-daemon.service"], { encoding: "utf8" }).status === 0;
      }
      return false;
    },
    ledger: (event, kv) => appendLedger(ledgerPath(logDir), event, kv),
    notify: async (text) => {
      await aibrokerMessenger(logDir).toSession(originFromEnv(), text);
    },
  };
}
