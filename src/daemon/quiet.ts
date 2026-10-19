/**
 * Daemon quiet mode: for benchmark and overnight runs, defer every maintenance
 * job (registry scan, index/embed passes, triple extraction, the nightly
 * cycle, disk-scanning housekeeping) and run each deferred kind once when
 * quiet ends. Session notes, summaries and the context handover are never
 * gated: compaction needs them.
 *
 * State lives in config.yaml as `quiet: { on: true, until?: <ISO> }`, so the
 * CLI and the daemon share it without IPC. Jobs ask `deferIfQuiet(kind)` at
 * their dispatch point; `flushDeferredIfEnded` (polled by the daemon) runs the
 * registered runner of each deferred kind once.
 */

import { readMainConfigRaw, writeMainConfigRaw } from "./config.js";

export type DeferredKind = "registry-scan" | "index" | "embed" | "triple-extraction" | "maintenance" | "obsidian-sync";

export interface QuietState {
  on: boolean;
  /** Epoch ms when quiet ends by itself; undefined = until `quiet off`. */
  until?: number;
}

/** How often the daemon checks whether quiet has ended. */
export const QUIET_POLL_MS = 30_000;

/** Parse the `quiet` config value. An expired `until` reads as off. */
export function parseQuiet(raw: unknown, now = Date.now()): QuietState {
  if (!raw || typeof raw !== "object") return { on: false };
  const q = raw as { on?: unknown; until?: unknown };
  if (q.on !== true) return { on: false };
  if (q.until === undefined || q.until === null) return { on: true };
  const until = typeof q.until === "number" ? q.until : Date.parse(String(q.until));
  if (Number.isNaN(until)) return { on: true };
  return until > now ? { on: true, until } : { on: false };
}

/** Next local time-of-day HH:MM strictly after `now`. Throws on bad input. */
export function nextOccurrence(hhmm: string, now = Date.now()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`--until expects HH:MM (00:00-23:59), got "${hhmm}"`);
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

type QuietSource = () => unknown;
let source: QuietSource = () => readMainConfigRaw()["quiet"];

/** Tests only: replace where the quiet config value is read from. */
export function setQuietSourceForTests(s: QuietSource | null): void {
  source = s ?? (() => readMainConfigRaw()["quiet"]);
}

/** Current state, read fresh from config; an unreadable config reads as not quiet. */
export function readQuiet(now = Date.now()): QuietState {
  try {
    return parseQuiet(source(), now);
  } catch {
    return { on: false };
  }
}

/** CLI side: persist quiet on (optionally until `until` epoch ms) or off. */
export function writeQuiet(on: boolean, until?: number): void {
  const raw = readMainConfigRaw();
  if (on) raw["quiet"] = until === undefined ? { on: true } : { on: true, until: new Date(until).toISOString() };
  else delete raw["quiet"];
  writeMainConfigRaw(raw);
}

/** One-line description for `pai daemon quiet status` and `pai daemon status`. */
export function describeQuiet(s: QuietState): string {
  if (!s.on) return "off";
  return s.until === undefined ? "on (until `pai daemon quiet off`)" : `on until ${new Date(s.until).toLocaleString()}`;
}

const deferred = new Set<DeferredKind>();
const runners = new Map<DeferredKind, () => Promise<void> | void>();

/** What to run (once) for a kind when quiet ends. */
export function registerQuietRunner(kind: DeferredKind, run: () => Promise<void> | void): void {
  runners.set(kind, run);
}

/** Record `kind` as deferred without the quiet check (caller already knows). */
export function markDeferred(kind: DeferredKind): void {
  deferred.add(kind);
}

/** True (and the kind is remembered for later) while quiet; false = run now. */
export function deferIfQuiet(kind: DeferredKind, now = Date.now()): boolean {
  if (!readQuiet(now).on) return false;
  if (!deferred.has(kind)) process.stderr.write(`[pai-daemon] quiet: deferring ${kind}.\n`);
  deferred.add(kind);
  return true;
}

export function deferredKinds(): DeferredKind[] {
  return [...deferred];
}

/**
 * When quiet is over, run each deferred kind once, in a fixed order. Returns
 * the kinds run. A runner that throws is logged and not retried.
 */
export async function flushDeferredIfEnded(now = Date.now()): Promise<DeferredKind[]> {
  if (readQuiet(now).on || deferred.size === 0) return [];
  const order: DeferredKind[] = ["registry-scan", "index", "maintenance", "embed", "triple-extraction", "obsidian-sync"];
  const kinds = order.filter((k) => deferred.has(k));
  deferred.clear();
  for (const kind of kinds) {
    try {
      await runners.get(kind)?.();
    } catch (e) {
      process.stderr.write(`[pai-daemon] quiet: deferred ${kind} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.stderr.write(`[pai-daemon] quiet ended: ran deferred ${kinds.join(", ")}.\n`);
  return kinds;
}

/** Daemon side: poll for the end of quiet. */
export function startQuietWatcher(): void {
  const timer = setInterval(() => void flushDeferredIfEnded(), QUIET_POLL_MS);
  if (timer.unref) timer.unref();
}

/** Tests only. */
export function resetQuietForTests(): void {
  deferred.clear();
  runners.clear();
}
