/**
 * runtime-autostart.ts — the daemon starts the local model runtimes marked
 * `models.runtimes.<name>.autostart: true` and keeps them up.
 *
 * Incident 2026-11-18 12:16–12:22: after a reboot gyro-l (port 8035) was not
 * running, nothing ever started it — no launchd job exists for it, and the
 * "idle loads on first request" path never fires because the router does not
 * route to a provider that is down. The routing hint read "local: none
 * running" and balanced mode sent every new worker to the cloud. `pai models
 * start gyro-l` brought it up at once, so this runs exactly that path from
 * the daemon: on daemon start and afterwards every tick, an autostart runtime
 * that is not up is started through the same code path as `pai models start`
 * (the configured start command, output to logs/local/<runtime>.log, wait for
 * the configured readiness).
 *
 * The guards, in order per runtime:
 *   - a frozen machine (`pai freeze`) starts nothing at all;
 *   - free memory first: below the provider's `memoryGb` from workers.yaml
 *     `local_tiers` the start is skipped with one clear log line and ONE
 *     operator alert (a skip is not a failure: no backoff, retried next tick);
 *   - failures back off every AUTOSTART_RETRY_MS (10 min) and stop after
 *     AUTOSTART_MAX_FAILURES (3) until the next daemon start.
 * A runtime that dies again later is restarted with the same backoff; its
 * failure count carries over, so a crash loop gives up too.
 */

import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { readLocalConfig, type LocalTier } from "../workers/local-tiers.js";
import { readRuntimeCommands, readyIsUrl, liveRuntimeOpDeps, type RuntimeCommands } from "../workers/model-runtimes.js";
import { workersYamlPath } from "../workers/workers-config.js";
import { freeMemoryGb } from "../workers/local-memory.js";
import { isFrozen } from "../workers/freeze.js";
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
}

/** The manager's config: the autostart runtimes and each one's memory need from its provider's tier. */
export function runtimeAutostartConfig(
  commands: Record<string, RuntimeCommands>,
  tiers: LocalTier[]
): AutostartConfig {
  const memoryGb: Record<string, number> = {};
  for (const t of tiers) if (t.memoryGb !== undefined && !(t.provider in memoryGb)) memoryGb[t.provider] = t.memoryGb;
  const runtimes: Record<string, RuntimeCommands> = {};
  for (const [name, c] of Object.entries(commands)) if (c.autostart === true) runtimes[name] = c;
  return { enabled: Object.keys(runtimes).length > 0, runtimes, memoryGb };
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
  memoryAlerted: boolean;
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
  /** Free memory after the reserve, GB; undefined = unmeasurable (a short-memory skip cannot be made). */
  freeGb: () => Promise<number | undefined>;
  /** The start through `pai models start`'s own path; resolves when ready or failed. */
  start: (runtime: string) => Promise<{ ok: boolean; message: string }>;
  /** One operator alert (guarded PAILot). */
  alert: (text: string) => Promise<void>;
  ledger: (event: string, kv: Record<string, string | number>) => void;
  log: (line: string) => void;
  now: () => number;
}

/** One tick over the autostart runtimes; mutates `states` (the daemon's per-runtime bookkeeping). */
export async function runtimeAutostartTick(cfg: AutostartConfig, states: AutostartStates, d: AutostartDeps): Promise<AutostartAction[]> {
  const actions: AutostartAction[] = [];
  if (!cfg.enabled) return actions;
  // a frozen machine starts nothing — not even the probes
  if (d.frozen()) return actions;
  let free: number | undefined;
  for (const [runtime, cmd] of Object.entries(cfg.runtimes)) {
    if (!cmd.start) continue;
    const st = states.get(runtime) ?? { attempts: 0, lastAttempt: -Infinity, gaveUp: false, memoryAlerted: false };
    states.set(runtime, st);
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
      st.memoryAlerted = false;
      continue;
    }
    if (st.gaveUp) continue;
    const needGb = cfg.memoryGb[runtime] ?? 0;
    if (needGb > 0 && free === undefined) free = await d.freeGb();
    if (free !== undefined && free < needGb) {
      // not enough memory: skip, alert once, and keep trying on later ticks (a skip is not a failure)
      actions.push({ kind: "skip-memory", runtime, needGb, freeGb: free });
      d.log(`autostart ${runtime}: skipped, needs ~${needGb} GB, free ${Math.round(free * 10) / 10} GB`);
      if (!st.memoryAlerted) {
        st.memoryAlerted = true;
        try {
          await d.alert(`PAI autostart: local model ${runtime} is down and needs ~${needGb} GB, only ${Math.round(free * 10) / 10} GB free — not started (retried each tick until memory frees).`);
        } catch {
          /* the alert is best effort; the log line stands */
        }
      }
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
    d.ledger(AUTOSTART_EVENT, { runtime, result: r.ok ? "ok" : `error: ${r.message.slice(0, 200)}`, attempt: st.attempts });
    if (r.ok) {
      d.log(`autostart ${runtime}: up (${r.message})`);
      st.attempts = 0;
      continue;
    }
    d.log(`autostart ${runtime}: start failed (attempt ${st.attempts}/${AUTOSTART_MAX_FAILURES}): ${r.message}`);
    if (st.attempts >= AUTOSTART_MAX_FAILURES) {
      st.gaveUp = true;
      d.log(`autostart ${runtime}: giving up until the next daemon start`);
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
      if (!cmd?.ready) return false; // no readiness configured: a start is attempted once per backoff, the ledger tells
      return readyIsUrl(cmd.ready) ? liveRuntimeOpDeps.getUrl(cmd.ready) : (await liveRuntimeOpDeps.runCmd(cmd.ready)) === 0;
    },
    frozen: () => isFrozen(),
    freeGb: () => freeMemoryGb(),
    async start(runtime) {
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
