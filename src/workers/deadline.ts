/**
 * deadline.ts — the time gate of a worker run: resolving --max-minutes /
 * --deadline / workers.defaultMaxMinutes into one absolute deadline, the
 * prompt line that tells the worker, the ps label, and the timer that stops
 * the child (SIGTERM, then SIGKILL after a grace period).
 */

import { LOW_POWER_SAMPLE_SEC, lowPowerActive, lowPowerFactor } from "../daemon/low-power.js";
import type { WorkerStatus } from "./status.js";

export interface RunLimit {
  /** Epoch ms the run is stopped at. */
  deadlineAt: number;
  /** Minutes from launch to the deadline. */
  minutes: number;
  /** Set for --deadline HH:MM: a wall-clock time, so waits do not move it. */
  absolute?: true;
}

/** Slide a minutes-based limit by time spent waiting (queue); an absolute one stays. */
export function extendLimit(limit: RunLimit, waitedMs: number): RunLimit {
  return limit.absolute || waitedMs <= 0 ? limit : { ...limit, deadlineAt: limit.deadlineAt + waitedMs };
}

/**
 * Low Power Mode stretches a minutes-based deadline: while it is on, every
 * tick adds the elapsed wall time minus the fraction it counts as (1/factor),
 * so 30 min in low power at factor 2 push a 60-min deadline 15 min later. An
 * absolute --deadline stays fixed: a wall-clock time is not stretched.
 */
export function stretchDeadline(
  limit: RunLimit,
  active: boolean,
  factor: number,
  elapsedMs: number,
  now: number = Date.now()
): RunLimit {
  if (limit.absolute || !active || factor <= 1 || elapsedMs <= 0) return limit;
  return { ...limit, deadlineAt: limit.deadlineAt + elapsedMs * (1 - 1 / factor), minutes: Math.max(1, Math.round((limit.deadlineAt + elapsedMs - now) / 60_000)) };
}

/** The deadline timer's low-power options; the live pmset/config readers are the default. */
export interface LowPowerOpts {
  /** Whether macOS is currently in Low Power Mode (cached, sampled ≤ once per 30 s). */
  active?: () => Promise<boolean>;
  /** The stretch factor (power.lowPower.factor). */
  factor?: () => number;
}

/** Local HH:MM → epoch ms: today, or tomorrow when already past. */
export function parseDeadline(hhmm: string, now: Date = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`--deadline: expected HH:MM (local time, 00:00-23:59), got "${hhmm}"`);
  }
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The run's limit, or null when disabled (--max-minutes 0 / default 0). */
export function resolveLimit(
  flags: { maxMinutes?: number; deadline?: string },
  defaultMinutes: number,
  now: Date = new Date()
): RunLimit | null {
  if (flags.maxMinutes !== undefined && flags.deadline !== undefined) {
    throw new Error("--max-minutes and --deadline are mutually exclusive");
  }
  if (flags.deadline !== undefined) {
    const deadlineAt = parseDeadline(flags.deadline, now);
    return { deadlineAt, minutes: Math.max(1, Math.round((deadlineAt - now.getTime()) / 60_000)), absolute: true };
  }
  const minutes = flags.maxMinutes ?? defaultMinutes;
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`--max-minutes: expected a non-negative number, got ${minutes}`);
  return minutes === 0 ? null : { deadlineAt: now.getTime() + minutes * 60_000, minutes };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The one line injected into the worker's system prompt. */
export function deadlinePromptLine(limit: RunLimit): string {
  const d = new Date(limit.deadlineAt);
  const stretch = limit.absolute
    ? ""
    : " While macOS Low Power Mode is on this deadline moves later (minutes there count as 1/factor).";
  return (
    `Hard deadline ${pad(d.getHours())}:${pad(d.getMinutes())} (${limit.minutes} min). ` +
    "Finish and report before it; at the deadline the run is stopped and whatever you have is salvaged." +
    stretch
  );
}

/** ps column: "36s left", "12m left", "1h05m left" for running; "OVERDUE ..." for overdue; "timed out" for stopped; null otherwise. */
export function deadlineLabel(
  s: Pick<WorkerStatus, "state" | "deadlineAt" | "timedOut">,
  now: number = Date.now()
): string | null {
  if (s.timedOut) return "timed out";
  if (s.state !== "running" || !s.deadlineAt) return null;
  const secs = Math.abs(s.deadlineAt - now) / 1_000;
  let label: string;
  if (secs < 60) {
    label = `${Math.floor(secs)}s`;
  } else if (secs < 3600) {
    label = `${Math.floor(secs / 60)}m`;
  } else {
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    label = `${hours}h${String(mins).padStart(2, "0")}m`;
  }
  return s.deadlineAt >= now ? `${label} left` : `OVERDUE ${label}`;
}

/** Grace between SIGTERM and SIGKILL. */
export const DEADLINE_GRACE_MS = 10_000;

/**
 * Stop `proc` at the deadline: `onFire`, SIGTERM, SIGKILL after `graceMs`
 * when it is still alive. Returns the disarm function.
 */
export function armDeadline(
  proc: { kill(sig?: NodeJS.Signals): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null },
  limit: RunLimit,
  onFire: () => void,
  graceMs: number = DEADLINE_GRACE_MS,
  /** ms the run spent blocked (build-gate waits) so far; they push the deadline out. Absolute limits ignore it. */
  blocked: () => number = () => 0,
  now: () => number = Date.now,
  /** Low Power Mode stretch (minutes-based limits only); the live pmset/config readers by default. */
  lp: LowPowerOpts = {}
): () => void {
  let kill: NodeJS.Timeout | null = null;
  let t: NodeJS.Timeout;
  let cur = limit;
  /** Last stretch sample: wall ms and whether low power was on then. */
  let lastAt = now();
  let lastActive = false;
  const left = (): number => cur.deadlineAt + (cur.absolute ? 0 : blocked()) - now();
  const arm = (): void => {
    clearTimeout(t);
    t = setTimeout(fire, Math.max(0, left()));
  };
  const fire = (): void => {
    // a wait or a low-power tick moved the deadline since the timer was set
    if (left() > 0) return arm();
    onFire();
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    kill = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, graceMs);
    kill.unref();
  };
  // one stretch tick: add elapsed*(1-1/factor) while low power is on; the
  // cached lowPowerActive() samples at most once per 30 s
  const tick = async (): Promise<void> => {
    if (!cur.absolute) {
      try {
        const active = await (lp.active ?? lowPowerActive)();
        const at = now();
        if (active && lastActive) {
          cur = stretchDeadline(cur, true, (lp.factor ?? lowPowerFactor)(), at - lastAt, at);
        }
        lastAt = at;
        lastActive = active;
      } catch {
        /* a failing pmset or config read: no stretch */
      }
    }
    if (left() > 0) arm();
  };
  arm();
  const timer = setInterval(() => void tick(), LOW_POWER_SAMPLE_SEC * 1000);
  timer.unref();
  return () => {
    clearTimeout(t);
    if (kill) clearTimeout(kill);
    clearInterval(timer);
  };
}
