/**
 * sleep-clock.ts — the machine's sleep, subtracted from every progress clock.
 *
 * macOS: Date.now() advances through system sleep (clamshell close, darkwake
 * cycles), while performance.now()/process.hrtime() (mach_absolute_time) does
 * not. So a wall-vs-monotonic gap IS sleep: the gap is how long the machine
 * stood still. Supervision clocks that judge a worker's progress must not
 * count it — a worker asleep for 20 min is not a worker idle for 20 min
 * (2026-11-24: workers killed for "no progress in its 20-min allowance" and
 * "no convergence: 25m without commit or green check" while the Mac slept).
 *
 * The spans are recorded once per gap by whoever ticks first (the daemon
 * supervision tick, the router's stall monitor, a worker's own blockedMsOf
 * read) into ~/.pai/state/sleep.json = { spans: [[from,to],…] } — machine
 * wide, like the freeze accounts. Every clock then subtracts them exactly the
 * way it subtracts freeze spans: sleep is not work.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { paiHomePath } from "../config/pai-home.js";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";

/** A gap this far below the tick's own drift is noise, not sleep. */
const SLEEP_TOLERANCE_MS = 2_000;
/** Spans older than this are history; the file stays bounded. */
const SPAN_RETENTION_MS = 7 * 86_400_000;

/** PAI_SLEEP_FILE moves the span file (and its ledger target): isolated proofs and tests never touch the real one. */
export const sleepStatePath = (): string => process.env.PAI_SLEEP_FILE ?? paiHomePath("state", "sleep.json");

interface SleepFile {
  spans: Array<[number, number]>;
}

function readSpans(): Array<[number, number]> {
  try {
    const j = JSON.parse(readFileSync(sleepStatePath(), "utf8")) as Partial<SleepFile>;
    return Array.isArray(j.spans) ? j.spans.filter((s) => Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1])) : [];
  } catch {
    return [];
  }
}

function writeSpans(spans: Array<[number, number]>): void {
  const path = sleepStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ spans }), "utf8");
    renameSync(tmp, path);
  } catch {
    // accounting must never break a tick
  }
}

/** The wall clock every progress clock runs on. */
export const wallNow = (): number => Date.now();
/** The monotonic clock: stands still while the machine sleeps. */
export const monoNow = (): number => performance.now();

/**
 * The sleep spans covering [from, to], merged and sorted, read from the span
 * file. A clock subtracts these the way it subtracts freeze spans.
 */
export function sleepSpansBetween(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of readSpans()) {
    if (a < to && b > from) out.push([Math.max(from, a), Math.min(to, b)]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }
  return merged;
}

/** ms of the wall interval [from, to] that ran while the machine slept. */
export function sleepMsBetween(from: number, to: number): number {
  let ms = 0;
  for (const [a, b] of sleepSpansBetween(from, to)) ms += Math.max(0, b - a);
  return ms;
}

/**
 * One detection tick: compare the wall gap since the last tick with the
 * monotonic gap. A wall gap beyond the monotonic gap (plus tolerance) is
 * system sleep: record the span [lastWall, nowWall] and return it. Returns
 * null when nothing slept. `logDir` (optional) writes the ledger line
 * `MACHINE-SLEEP from=<t> to=<t> seconds=<n>` once per gap — whoever ticks
 * first owns the line, so the daemon tick, the router monitor and a worker's
 * own clock read never double-write it.
 */
export function detectSleepGap(nowWall: number, nowMono: number, logDir?: string): { from: number; to: number; ms: number } | null {
  const prev = lastTick;
  lastTick = { wall: nowWall, mono: nowMono };
  if (!prev) return null;
  const wallGap = nowWall - prev.wall;
  const monoGap = nowMono - prev.mono;
  const slept = wallGap - monoGap;
  if (slept <= SLEEP_TOLERANCE_MS) return null;
  const from = prev.wall;
  const to = nowWall;
  const spans = readSpans().filter(([a, b]) => b > nowWall - SPAN_RETENTION_MS);
  spans.push([from, to]);
  spans.sort((x, y) => x[0] - y[0]);
  writeSpans(spans);
  if (logDir) {
    try {
      appendLedger(ledgerPath(logDir), "MACHINE-SLEEP", { from, to, seconds: Math.round(slept / 1000) });
    } catch {
      /* the ledger line is a courtesy */
    }
  }
  return { from, to, ms: slept };
}

let lastTick: { wall: number; mono: number } | null = null;

/** Test seam: forget the last tick (a fresh process starts with none anyway). */
export function resetSleepTick(): void {
  lastTick = null;
}
