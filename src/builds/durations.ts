/**
 * durations.ts — how long each build key's jobs run, kept by the gate itself
 * (<builds dir>/durations.json: last KEEP run seconds per key) so the router
 * can tell a 30 s build from a 5 min one before parking a conversation.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEEP = 20;
const file = (dir: string): string => join(dir, "durations.json");

function read(dir: string): Record<string, number[]> {
  try {
    if (!existsSync(file(dir))) return {};
    const v = JSON.parse(readFileSync(file(dir), "utf8")) as Record<string, number[]>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Append one finished run (seconds) of `key`; best effort. */
export function recordDuration(dir: string, key: string | undefined, sec: number): void {
  if (!key || !(sec >= 0)) return;
  try {
    const all = read(dir);
    all[key] = [...(all[key] ?? []), Math.round(sec * 10) / 10].slice(-KEEP);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(dir) + ".tmp", JSON.stringify(all));
    renameSync(file(dir) + ".tmp", file(dir));
  } catch {
    /* history is advisory */
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** p50 seconds of `key`'s history; undefined without any. */
export function durationP50(dir: string, key: string): number | undefined {
  const xs = read(dir)[key];
  return xs?.length ? median(xs) : undefined;
}

/** Median of every key's p50 (the guess for a worker whose key is not known yet); undefined without history. */
export function overallP50(dir: string): number | undefined {
  const ps = Object.values(read(dir)).filter((x) => x.length).map(median);
  return ps.length ? median(ps) : undefined;
}
