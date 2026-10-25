import { execFileSync } from "node:child_process";

const HOUR_MS = 3_600_000;

/**
 * Seconds in a `ps etime` value (`[[dd-]hh:]mm:ss`); NaN when unreadable. The one
 * parseEtime: builds/reap.ts, workers/reaper.ts and daemon/leftovers.ts import this.
 * A day part is 86400 s (not 24 h worth of hours — the old reap.ts copy read it the same,
 * the old reaper.ts copy read "4" as 0 and the old leftovers.ts copy matched only the
 * four-field forms; this one takes the union of what they all accepted).
 */
export function parseEtime(v: string): number {
  const m = v.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return NaN;
  return (+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 3600 + +m[3]! * 60 + +m[4]!;
}

/**
 * Start time (ms epoch) from a zone-less `ps lstart` wall clock and the elapsed seconds. lstart names two instants an
 * hour apart inside the repeated autumn hour; the elapsed time says which. Outside it lstart is returned unchanged.
 */
export function resolveStart(lstart: string, elapsedSecs: number, now: number = Date.now()): number | undefined {
  const t = Date.parse(lstart.trim());
  if (Number.isNaN(t)) return undefined;
  if (Number.isNaN(elapsedSecs)) return t;
  return t + Math.round((now - elapsedSecs * 1000 - t) / HOUR_MS) * HOUR_MS;
}

/** Start time (ms epoch) of a process, undefined when it cannot be read. */
export function processStartMs(pid: number, now: number = Date.now()): number | undefined {
  try {
    const env = { ...process.env, LC_ALL: "C" };
    const ps = (key: string) => execFileSync("ps", ["-o", `${key}=`, "-p", String(pid)], { encoding: "utf8", env });
    return resolveStart(ps("lstart"), parseEtime(ps("etime")), now);
  } catch {
    return undefined;
  }
}
