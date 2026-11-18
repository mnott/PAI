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
 */

import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { readLocalConfig, healthUrl, type LocalTier } from "../workers/local-tiers.js";
import { readRuntimeCommands, readyIsUrl, liveRuntimeOpDeps, type RuntimeCommands } from "../workers/model-runtimes.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { freeMemoryGb } from "../workers/local-memory.js";
import { isFrozen } from "../workers/freeze.js";
import { deepfreezeHold } from "../workers/deepfreeze.js";
import { appendLedger } from "../workers/ledger.js";
import { guardedPailot } from "../workers/pailot-guard.js";

/** The ledger event of an autostart action. */
export const AUTOSTART_EVENT = "RUNTIME-AUTOSTART";

/** Retry at most every 10 minutes; never a tight loop. */
export const AUTOSTART_RETRY_MS = 10 * 60_000;
/** After this many failed starts: give up until the next daemon start. */
export const AUTOSTART_MAX_FAILURES = 3;

export interface AutostartConfig {
  enabled: boolean;
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
}

/** The autostart state of every configured runtime, including the ones that never needed a pass (up). */
export type AutostartStates = Map<string, AutostartRuntimeState>;

/** The autostart answer for the local-status cache: what the hint line says while nothing runs. */
export function autostartDownInfo(cfg: AutostartConfig, states: AutostartStates): { starting?: string; gaveUp?: string; autostartOff?: boolean } | undefined {
  if (!cfg.enabled) return { autostartOff: true };
  const down = [...states.keys()];
  const g = down.find((r) => states.get(r)?.gaveUp);
  if (g) return { gaveUp: g };
  const s = down[0];
  return s ? { starting: s } : undefined;
}

export interface AutostartDeps {
  /** The runtime answers its readiness (the same probe `pai models start` uses to refuse a duplicate). */
  isUp: (runtime: string) => Promise<boolean>;
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
      continue;
    }
    if (st.gaveUp) continue;
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
      return runtimeStartStop(runtime, "start", defaultDeps());
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

/** What the local-status cache says about why the tier reads down (undefined: no autostart manager ran). */
export function currentAutostartDownInfo(): { starting?: string; gaveUp?: string; autostartOff?: boolean } | undefined {
  if (!current) return undefined;
  return autostartDownInfo(current.cfg, current.states);
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
