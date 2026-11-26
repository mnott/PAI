/**
 * runtime-autostart.ts — the daemon starts the local model runtimes marked
 * `models.runtimes.<name>.autostart: true` and keeps them up.
 *
 * Incident 2026-11-18 12:16–12:22: after a reboot gyro-l (port 8035) was not
 * running, nothing ever started it — no launchd job exists for it, and the
 * "idle loads on first request" path never fires because the router does not
 * route to a provider that is down. The routing hint read "local: none
 * running" and balanced mode sent every new worker to the cloud. The memory
 * guard also refused gyro-l at boot ("needs ~60 GB, free 25 GB") while only
 * ~24 GB was in use: it counted vm_stat FREE pages alone; available memory is
 * free + inactive + speculative + purgeable (see workers/local-memory.ts).
 * `pai models
 * start gyro-l` brought it up at once, so this runs exactly that path from
 * the daemon: on daemon start and afterwards every tick, an autostart runtime
 * that is not up is started through the same code path as `pai models start`
 * (the configured start command, output to logs/local/<runtime>.log, wait for
 * the configured readiness).
 *
 * The guards, in order per runtime:
 *   - a frozen machine (`pai freeze`) starts nothing at all;
 *   - up first: the runtime's readiness answers → nothing at all (2026-11-18
 *     13:46: gyro-l was already up and still got a skip-memory line, an alert
 *     and a failed start — the probe must be the FIRST word per runtime);
 *   - available memory next: below the provider's `memoryGb` from workers.yaml
 *     `local_tiers` the start is skipped with one clear log line; the operator
 *     alert fires only after a real failed start (see below), never for a skip
 *     alone (a skip is not a failure: no backoff, retried next tick);
 *   - failures back off every AUTOSTART_RETRY_MS (10 min) and stop after
 *     AUTOSTART_MAX_FAILURES (3) until the next daemon start.
 * A runtime that dies again later is restarted with the same backoff; its
 * failure count carries over, so a crash loop gives up too.
 * Two answers read success, not failure: `ok`, and an "already running"/
 * "already starting" refusal from the start path (the runtime IS up — 13:46:
 * `ollama serve` refused with "ollama is already running" and burned a failure
 * attempt). One operator alert goes out after the FIRST real failed start,
 * then at most once more per give-up; a memory skip alone never alerts.
 *
 * Busy is not down (incident 2026-11-18 19:48/20:27: gyro-l ran 3 of 3 slots at
 * GPU 98–100%, its /v1/models answered too slowly, and the prompt hint read
 * "local model down: starting ollama" — a runtime started for an engine that
 * was alive and working). A runtime counts ALIVE while its TCP port accepts a
 * connection or the router's local scheduler reports requests in flight for it;
 * an alive runtime whose readiness times out is busy — no start, no failure,
 * no alert. Down needs two refused liveness probes DOWN_CONFIRM_MS (10 s)
 * apart: one slow answer never starts a runtime.
 */

import { connect } from "node:net";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { readLocalConfig, healthUrl, type LocalTier } from "../workers/local-tiers.js";
import { paiHomeDir } from "../config/pai-home.js";
import type { LocalDownInfo } from "../workers/local-status.js";
import { exclusivePeers, isRuntimeStopped, readRuntimeCommands, readyIsUrl, liveRuntimeOpDeps, type RuntimeCommands } from "../workers/model-runtimes.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { freeMemoryGb } from "../workers/local-memory.js";
import { isFrozen } from "../workers/freeze.js";
import { deepfreezeHold } from "../workers/deepfreeze.js";
import { appendLedger } from "../workers/ledger.js";
import { guardedPailot } from "../workers/pailot-guard.js";
import { readSchedFile, type SchedSnapshot } from "../router/scheduler.js";
import { LOCAL_PROBE_TIMEOUT_MS } from "../utils/timeouts.js";
import { DOWN_CONFIRM_MS } from "../workers/local-status.js";

/** The ledger event of an autostart action. */
export const AUTOSTART_EVENT = "RUNTIME-AUTOSTART";

/** Retry at most every 10 minutes; never a tight loop. */
export const AUTOSTART_RETRY_MS = 10 * 60_000;
/** After this many failed starts: give up until the next daemon start. */
export const AUTOSTART_MAX_FAILURES = 3;
/** A stopped-on-purpose runtime is logged once when the stop is first seen, then at most once this often as a reminder (2026-11-24: the line repeated every scheduler pass — 1,114 copies in 60,000 daemon log lines). */
export const STOPPED_REMINDER_MS = 6 * 60 * 60_000;

export interface AutostartConfig {
  enabled: boolean;
  /** Two refused liveness probes this far apart decide down (default DOWN_CONFIRM_MS, 10 s). */
  downConfirmMs?: number;
  /** The runtime name → its commands (models.runtimes); only autostart:true entries act. */
  runtimes: Record<string, RuntimeCommands>;
  /** Memory need per provider name, GB (workers.yaml local_tiers memoryGb). */
  memoryGb: Record<string, number>;
  /** Autostart entries without a start command that name a workers.yaml local_tiers model (by tier or provider name): started as that tier. */
  tiers?: Record<string, LocalTier>;
}

/** The manager's config: the autostart runtimes and each one's memory need from its provider's tier. */
export function runtimeAutostartConfig(
  commands: Record<string, RuntimeCommands>,
  tiers: LocalTier[]
): AutostartConfig {
  const memoryGb: Record<string, number> = {};
  for (const t of tiers) {
    if (t.memoryGb === undefined) continue;
    if (!(t.provider in memoryGb)) memoryGb[t.provider] = t.memoryGb;
    if (!(t.tier in memoryGb)) memoryGb[t.tier] = t.memoryGb;
  }
  const runtimes: Record<string, RuntimeCommands> = {};
  const tierOf: Record<string, LocalTier> = {};
  for (const [name, c] of Object.entries(commands)) {
    if (c.autostart !== true) continue;
    // a local_tiers model (apple-fm, ...) needs no models.runtimes start command: the flag alone starts it as that tier
    const tier = c.start ? undefined : tiers.find((t) => t.tier === name || t.provider === name);
    if (!c.start && !tier) continue;
    runtimes[name] = c;
    if (tier) tierOf[name] = tier;
  }
  return { enabled: Object.keys(runtimes).length > 0, runtimes, memoryGb, tiers: tierOf };
}

/** The live config: models.runtimes + the local_tiers memory needs. */
export function liveRuntimeAutostartConfig(): AutostartConfig {
  let tiers: LocalTier[] = [];
  try {
    tiers = Object.values(readLocalConfig(workersYamlPath()).tiers);
  } catch {
    /* no local_tiers: the memory check has nothing to demand */
  }
  return runtimeAutostartConfig(readRuntimeCommands(), tiers);
}

/** What a tick decides per runtime; "up" needs no action. */
export type AutostartAction =
  | { kind: "start"; runtime: string }
  | { kind: "skip-memory"; runtime: string; needGb: number; freeGb: number };

export interface AutostartRuntimeState {
  attempts: number;
  lastAttempt: number;
  gaveUp: boolean;
  /** An operator alert went out for this runtime's failures (first failure, and once more at give-up). */
  alerted: boolean;
  /** epoch ms of the first liveness probe that found the port refusing; absent = alive (or never probed). Down needs a second refusal DOWN_CONFIRM_MS later. */
  suspectedDownAt?: number;
  /** The exclusive-group skip was logged (once per blocking episode). */
  exclusiveLogged?: boolean;
  /** The stopped-on-purpose line was logged (once per stopped episode; a reminder after STOPPED_REMINDER_MS). */
  stoppedLoggedAt?: number;
}

/** The autostart state of every configured runtime, including the ones that never needed a pass (up). */
export type AutostartStates = Map<string, AutostartRuntimeState>;

/** A runtime whose liveness holds (port accepts, or requests in flight) while its readiness times out: busy, never down, never started. */
export const isBusyRuntime = (st: AutostartRuntimeState | undefined): boolean => st !== undefined && st.suspectedDownAt === undefined;

/** The autostart answer for the local-status cache: what the hint line says while nothing runs. A busy runtime is not down: it yields no "starting", and nothing starts for it. */
export function autostartDownInfo(cfg: AutostartConfig, states: AutostartStates, stopped?: (runtime: string) => boolean): LocalDownInfo | undefined {
  if (!cfg.enabled) return { autostartOff: true };
  const down = [...states.keys()].filter((r) => !isBusyRuntime(states.get(r)));
  // stopped on purpose (the marker the tick honours) wins: autostart will not start it, so never "starting"
  const sp = down.find((r) => stopped?.(r));
  if (sp) return { stoppedOnPurpose: sp };
  const g = down.find((r) => states.get(r)?.gaveUp);
  if (g) return { gaveUp: g };
  const s = down[0];
  return s ? { starting: s } : undefined;
}

/** The autostart runtimes the cache reports busy: liveness alive, readiness not answering. */
export function autostartBusyRuntimes(states: AutostartStates): string[] {
  return [...states.keys()].filter((r) => isBusyRuntime(states.get(r)));
}

export interface AutostartDeps {
  /** The runtime answers its readiness (the same probe `pai models start` uses to refuse a duplicate). */
  isUp: (runtime: string) => Promise<boolean>;
  /** Liveness of the runtime's server, independent of how slow its health check is: its port accepts a TCP connection, or the router's local scheduler has requests in flight for it. A busy engine answers /v1/models too slowly yet stays alive — this is what separates busy from down. */
  alive: (runtime: string) => Promise<boolean>;
  /** The runtime was stopped on purpose (`pai models stop`) and not started since: autostart must not bring it back. */
  stopped?: (runtime: string) => boolean;
  /** The name of an up runtime in `runtime`'s exclusive group (autostart then starts nothing), else null. */
  exclusivePeerUp?: (runtime: string) => Promise<string | null>;
  /** True while the machine is frozen (`pai freeze`): nothing starts. */
  frozen: () => boolean;
  /** Available memory (reclaimable counted) after the reserve, GB; undefined = unmeasurable (a short-memory skip cannot be made). */
  freeGb: () => Promise<number | undefined>;
  /** The start through `pai models start`'s own path; resolves when ready or failed. */
  start: (runtime: string) => Promise<{ ok: boolean; message: string }>;
  /** One operator alert (guarded PAILot). */
  alert: (text: string) => Promise<void>;
  ledger: (event: string, kv: Record<string, string | number>) => void;
  log: (line: string) => void;
  now: () => number;
}

/** The start path refused because the runtime is already there: that IS success, not a failure attempt. */
export const isAlreadyUp = (message: string): boolean => /already (running|starting)/i.test(message);

const fmtGb = (n: number): number => Math.round(n * 10) / 10;

/** One tick over the autostart runtimes; mutates `states` (the daemon's per-runtime bookkeeping). */
export async function runtimeAutostartTick(cfg: AutostartConfig, states: AutostartStates, d: AutostartDeps): Promise<AutostartAction[]> {
  const actions: AutostartAction[] = [];
  if (!cfg.enabled) return actions;
  // a frozen machine starts nothing — not even the probes
  if (d.frozen()) return actions;
  let avail: number | undefined;
  for (const [runtime, cmd] of Object.entries(cfg.runtimes)) {
    if (!cmd.start && !cfg.tiers?.[runtime]) continue;
    const st = states.get(runtime) ?? { attempts: 0, lastAttempt: -Infinity, gaveUp: false, alerted: false };
    states.set(runtime, st);
    // the readiness probe FIRST: an up runtime gets no memory check, no start and no alert (13:46: gyro-l answered 200 on its ready URL and was still skipped + alerted)
    let up = false;
    try {
      up = await d.isUp(runtime);
    } catch {
      /* a failed probe reads down: the guards below decide whether that means a start */
    }
    if (up) {
      // back up: a runtime that came up on its own resets its failure count
      st.attempts = 0;
      st.gaveUp = false;
      st.alerted = false;
      delete st.suspectedDownAt;
      continue;
    }
    // busy is not down (2026-11-18: gyro-l at 3 of 3 slots, GPU 98–100%, its readiness timing out read "local model down: starting ollama").
    // While the port accepts connections or the scheduler has requests in flight, the engine is alive and working: no start, no failure, no alert.
    let alive = false;
    try {
      alive = await d.alive(runtime);
    } catch {
      /* a failed liveness probe reads not-alive: the confirm below decides */
    }
    if (alive) {
      delete st.suspectedDownAt;
      continue; // busy: its health answers slowly while it works
    }
    // down needs two refused probes 10 s apart: one slow or transient answer never starts a runtime
    const confirmMs = cfg.downConfirmMs ?? DOWN_CONFIRM_MS;
    // two refused probes decide down. The first refusal only opens the window; a runtime already inside its start backoff is confirmed down (its earlier probes refused too), and an injected 0 window confirms at once.
    if (st.suspectedDownAt === undefined) {
      st.suspectedDownAt = d.now();
      d.log(`autostart ${runtime}: health not answering, port refuses — confirming down in ${Math.round(confirmMs / 1000)} s`);
    }
    const secondRefusal = st.attempts > 0 || confirmMs === 0;
    if (!secondRefusal && d.now() - st.suspectedDownAt < confirmMs) continue; // still inside the window: wait, start nothing
    if (st.gaveUp) continue;
    if (d.stopped?.(runtime)) {
      // once per stopped episode, then a reminder at most every STOPPED_REMINDER_MS: the daemon ticks every minute and the line used to repeat on every pass
      if (st.stoppedLoggedAt === undefined || d.now() - st.stoppedLoggedAt >= STOPPED_REMINDER_MS) {
        st.stoppedLoggedAt = d.now();
        d.log(`autostart ${runtime}: stopped on purpose (pai models stop), not starting; \`pai models start ${runtime}\` lifts it`);
      }
      continue;
    }
    st.stoppedLoggedAt = undefined; // the stop lifted: a future stop logs again
    const blocker = await d.exclusivePeerUp?.(runtime).catch(() => null);
    if (blocker) {
      if (!st.exclusiveLogged) d.log(`autostart ${runtime}: not starting, ${blocker} is running in exclusive group ${cmd.exclusive}; use switch`);
      st.exclusiveLogged = true;
      continue;
    }
    st.exclusiveLogged = false;
    const needGb = cfg.memoryGb[runtime] ?? 0;
    if (needGb > 0 && avail === undefined) avail = await d.freeGb();
    if (avail !== undefined && avail < needGb) {
      // not enough memory: skip and keep trying on later ticks — a skip is not a failure, and it never alerts by itself
      actions.push({ kind: "skip-memory", runtime, needGb, freeGb: avail });
      d.log(`autostart ${runtime}: skipped, needs ~${needGb} GB, available ${fmtGb(avail)} GB`);
      continue;
    }
    const since = d.now() - st.lastAttempt;
    if (st.attempts > 0 && since < AUTOSTART_RETRY_MS) continue;
    actions.push({ kind: "start", runtime });
    st.attempts += 1;
    st.lastAttempt = d.now();
    let r: { ok: boolean; message: string };
    try {
      r = await d.start(runtime);
    } catch (e) {
      r = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    // "already running" from the start command means the runtime is up: success, not a failure attempt
    const success = r.ok || isAlreadyUp(r.message);
    if (success) delete st.suspectedDownAt; // a runtime that came up resets its down-confirmation window
    d.ledger(AUTOSTART_EVENT, { runtime, result: success ? "ok" : `error: ${r.message.slice(0, 200)}`, attempt: st.attempts });
    if (success) {
      d.log(`autostart ${runtime}: up (${r.message})`);
      st.attempts = 0;
      continue;
    }
    d.log(`autostart ${runtime}: start failed (attempt ${st.attempts}/${AUTOSTART_MAX_FAILURES}): ${r.message}`);
    // the operator alert only after a REAL failed start: once at the first failure, once more at the give-up
    if (!st.alerted) {
      st.alerted = true;
      try {
        await d.alert(`PAI autostart: local model ${runtime} is down and its start failed (${r.message.slice(0, 200)}); needs ~${needGb} GB, available ${avail === undefined ? "?" : fmtGb(avail)} GB — retried every ${AUTOSTART_RETRY_MS / 60_000} min.`);
      } catch {
        /* the alert is best effort; the log line stands */
      }
    }
    if (st.attempts >= AUTOSTART_MAX_FAILURES) {
      st.gaveUp = true;
      d.log(`autostart ${runtime}: giving up until the next daemon start`);
      if (st.alerted) {
        try {
          await d.alert(`PAI autostart: local model ${runtime} failed to start ${AUTOSTART_MAX_FAILURES} times — giving up until the next daemon start.`);
        } catch {
          /* best effort */
        }
      }
    }
  }
  return actions;
}

/** The per-runtime state of a fresh manager (a daemon start resets every failure count). */
export const freshAutostartStates = (): AutostartStates => new Map();

/** The live deps: the daemon's own paths, no real sleeps anywhere. */
export function liveAutostartDeps(): AutostartDeps {
  let workers: ReturnType<typeof readWorkersSection>["workers"] | null = null;
  const workersCfg = (): ReturnType<typeof readWorkersSection>["workers"] => (workers ??= readWorkersSection().workers);
  const logDir = (): string => workersLogDir(workersCfg());
  return {
    async isUp(runtime) {
      const cmd = readRuntimeCommands()[runtime];
      const tier = !cmd?.start && !cmd?.ready ? liveRuntimeAutostartConfig().tiers?.[runtime] : undefined;
      if (tier) return liveRuntimeOpDeps.getUrl(healthUrl(tier, tier.port));
      if (!cmd?.ready) return false; // no readiness configured: a start is attempted once per backoff, the ledger tells
      return readyIsUrl(cmd.ready) ? liveRuntimeOpDeps.getUrl(cmd.ready) : (await liveRuntimeOpDeps.runCmd(cmd.ready)) === 0;
    },
    alive: (runtime) => liveRuntimeAlive(runtime),
    stopped: (runtime) => isRuntimeStopped(paiHomeDir(), runtime),
    async exclusivePeerUp(runtime) {
      const all = readRuntimeCommands();
      for (const peer of exclusivePeers(runtime, all)) {
        const ready = all[peer]?.ready;
        if (ready && (readyIsUrl(ready) ? await liveRuntimeOpDeps.getUrl(ready) : (await liveRuntimeOpDeps.runCmd(ready)) === 0)) return peer;
      }
      return null;
    },
    frozen: () => isFrozen() || deepfreezeHold(),
    // no reserve here: the skip compares the measured AVAILABLE (reclaimable counted) against the tier's memoryGb as the brief demands
    freeGb: () => freeMemoryGb(0),
    async start(runtime) {
      if (!readRuntimeCommands()[runtime]?.start) {
        // a local_tiers model: the same start path as `pai worker config start` / the cockpit's local.start
        const { readLocalConfig: rl } = await import("../workers/local-tiers.js");
        const { startInstance } = await import("../cli/commands/worker-config.js");
        const cfg = rl(workersYamlPath());
        const tier = Object.values(cfg.tiers).find((t) => t.tier === runtime || t.provider === runtime);
        if (!tier) return { ok: false, message: `no start command or local_tiers model for ${runtime}` };
        try {
          const i = await startInstance(cfg, tier.tier);
          return { ok: true, message: `${i.id} up on :${i.port}` };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      }
      const { defaultDeps, runtimeStartStop } = await import("../router/cockpit-actions.js");
      return runtimeStartStop(runtime, "start", defaultDeps(), { caller: "daemon-autostart" });
    },
    alert: async (text) => {
      const { callAiBroker } = await import("../cli/lib/aibroker-client.js");
      await guardedPailot(logDir(), text, async (t) => {
        try {
          await callAiBroker("pailot_send", { text: t }, 8_000);
          return true;
        } catch {
          return false;
        }
      });
    },
    ledger: (event, kv) => appendLedger(`${logDir()}/ledger.log`, event, kv),
    log: (l) => process.stderr.write(`[pai-daemon] ${l}\n`),
    now: () => Date.now(),
  };
}

/** The live singleton state the local-status refresher reads for its hint line. */
let current: { cfg: AutostartConfig; states: AutostartStates } | null = null;

/** What the local-status cache says about why the tier reads down (undefined: no autostart manager ran). A busy runtime never yields "starting". */
export function currentAutostartDownInfo(): LocalDownInfo | undefined {
  if (!current) return undefined;
  return autostartDownInfo(current.cfg, current.states, (r) => isRuntimeStopped(paiHomeDir(), r));
}

/** The autostart runtimes the live manager reports busy (liveness alive, readiness slow): the cache's `busy` list. */
export function currentAutostartBusy(): string[] {
  if (!current) return [];
  return autostartBusyRuntimes(current.states);
}

/** The port a runtime's server listens on: its ready URL when one names a port, else its local_tiers base port; null = nothing to probe. */
function runtimePort(cmd: RuntimeCommands | undefined, tier: LocalTier | undefined): number | null {
  if (cmd?.ready && readyIsUrl(cmd.ready)) {
    // the ready URL may carry the {port} template of a local_tiers model: expand it against the tier's base port
    try {
      const p = Number(new URL(cmd.ready.replaceAll("{port}", String(tier?.port ?? 0))).port);
      if (Number.isFinite(p) && p > 0) return p;
    } catch {
      /* an unparsable ready URL: the tier's base port decides */
    }
  }
  return tier?.port ?? null;
}

/** Whether something accepts a TCP connection on host:port within timeoutMs (a hung-but-listening server counts as alive). */
export function tcpConnectAlive(host: string, port: number, timeoutMs = LOCAL_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ host, port });
    const done = (v: boolean): void => {
      s.destroy();
      res(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Requests the router's local scheduler has in flight for a provider (its instances are engine keys `<provider>` / `<provider>#<n>`). In flight means the engine is working: busy, never down. */
export function schedulerInflightFor(snap: SchedSnapshot | null, provider: string): number {
  if (!snap) return 0;
  let n = 0;
  for (const [key, e] of Object.entries(snap.engines)) {
    if (key !== provider && !key.startsWith(`${provider}#`)) continue;
    if (e.inflight) n += 1;
  }
  return n;
}

/** The live liveness answer: the runtime's port accepts a TCP connection, or the router's local scheduler reports requests in flight for it. */
export function liveRuntimeAlive(runtime: string): Promise<boolean> {
  const cmd = readRuntimeCommands()[runtime];
  // the same tier resolution isUp uses: a command-less ready URL is a local_tiers template
  const tier = !cmd?.start && !cmd?.ready ? liveRuntimeAutostartConfig().tiers?.[runtime] : undefined;
  // the scheduler first: requests in flight prove the engine is working, whatever its health check does
  const prov = tier?.provider ?? runtime;
  if (schedulerInflightFor(readSchedFile(workersLogDir(readWorkersSection().workers)), prov) > 0) return Promise.resolve(true);
  const port = runtimePort(cmd, tier);
  if (port === null) return Promise.resolve(false); // no port to probe: liveness cannot say alive
  return tcpConnectAlive("127.0.0.1", port);
}

/** Start the autostart supervision: one pass at daemon start (after boot), then every tick.
 *  Reads its config once — a config change needs a daemon restart, like every other start* here. */
export function startRuntimeAutostart(
  cfg: AutostartConfig = liveRuntimeAutostartConfig(),
  deps: AutostartDeps = liveAutostartDeps(),
  tickMs = 60_000
): void {
  if (!cfg.enabled) {
    current = { cfg, states: freshAutostartStates() };
    deps.log("Runtime autostart: disabled (no models.runtimes entry has autostart: true)");
    return;
  }
  const states = freshAutostartStates();
  current = { cfg, states };
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runtimeAutostartTick(cfg, states, deps)
      .catch((e) => deps.log(`Runtime autostart tick error: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = false;
      });
  };
  // after boot: the first pass lands shortly after start, when launchd's own jobs have had a moment to bind their ports
  const first = setTimeout(tick, 5_000);
  if (first.unref) first.unref();
  const timer = setInterval(tick, tickMs);
  if (timer.unref) timer.unref();
  deps.log(`Runtime autostart: ${Object.keys(cfg.runtimes).join(", ")} (every ${Math.round(tickMs / 1000)}s, retry every ${AUTOSTART_RETRY_MS / 60_000} min, give up after ${AUTOSTART_MAX_FAILURES})`);
}
