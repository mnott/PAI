/**
 * watch.ts — `pai worker watch <id>...`: one line per piece of evidence about
 * workers, meant to run under a monitor. Reads the same statuses `pai worker ps`
 * shows (reconcileStatuses + loadStatuses); keeps no state of its own on disk.
 *
 *   STATE <id> [provider] <old> -> <new> (turns N)   every state change
 *   STALL <id> ...                                    turns did not grow for --stall
 *   DENIED <id> ...                                   guard denials grew
 *   SERVER DOWN <provider> <url>                      the provider's health URL stopped answering
 *   PROGRESS turns:<id>:<n>...                        every --beat
 *   ALL TERMINAL                                      every id finished
 */

import { readWorkersSection } from "./config.js";
import { probeEndpointUrl } from "./endpoint-health.js";
import { isTerminal, loadStatuses, reconcileStatuses, type WorkerStatus } from "./status.js";

export interface WatchOptions {
  ids: string[];
  stallMs: number;
  beatMs: number;
  pollMs: number;
}

export interface WatchDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  statuses(): WorkerStatus[];
  /** provider name -> health URL (empty/absent: not probed). */
  urls(): Record<string, string>;
  probe(url: string): Promise<boolean>;
  emit(line: string): void;
}

interface Seen {
  state: string;
  turns: number;
  turnsAt: number;
  denials: number;
  stalled: boolean;
}

/** "4m", "90s", "250ms", bare number = seconds. */
export function parseDuration(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`bad duration "${v}" (use 90s, 4m, 1h)`);
  const n = Number(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"] as number));
}

const denials = (s: WorkerStatus): number => s.denialCount ?? s.denials?.length ?? 0;

export async function watchWorkers(o: WatchOptions, d: WatchDeps): Promise<number> {
  const seen = new Map<string, Seen>();
  const down = new Set<string>();
  let lastBeat = d.now();
  for (;;) {
    const now = d.now();
    const all = d.statuses();
    const rows = o.ids.map((id) => ({ id, s: all.find((x) => x.id === id) }));
    for (const { id, s } of rows) {
      if (!s) {
        if (!seen.has(id)) {
          seen.set(id, { state: "missing", turns: 0, turnsAt: now, denials: 0, stalled: false });
          d.emit(`STATE ${id} [?] ? -> missing (turns 0)`);
        }
        continue;
      }
      const prev = seen.get(id);
      const turns = s.turns ?? 0;
      if (!prev || prev.state !== s.state) {
        d.emit(`STATE ${id} [${s.provider}] ${prev?.state ?? "?"} -> ${s.state} (turns ${turns})`);
      }
      const cur: Seen = { state: s.state, turns, turnsAt: prev && prev.turns === turns ? prev.turnsAt : now, denials: denials(s), stalled: prev?.stalled ?? false };
      if (prev && cur.denials > prev.denials) d.emit(`DENIED ${id} [${s.provider}] denials ${prev.denials} -> ${cur.denials}`);
      if (prev && turns !== prev.turns) cur.stalled = false;
      if (s.state === "running" && !cur.stalled && now - cur.turnsAt >= o.stallMs) {
        cur.stalled = true;
        d.emit(`STALL ${id} [${s.provider}] turns ${turns} unchanged for ${Math.round((now - cur.turnsAt) / 1000)}s`);
      }
      seen.set(id, cur);
    }
    // provider health of the workers still going
    const urls = d.urls();
    const live = new Set(rows.filter((r) => r.s && !isTerminal(r.s.state)).map((r) => r.s!.provider));
    for (const p of live) {
      const url = urls[p];
      if (!url) continue;
      if (await d.probe(url)) down.delete(p);
      else if (!down.has(p)) {
        down.add(p);
        d.emit(`SERVER DOWN ${p} ${url}`);
      }
    }
    if (now - lastBeat >= o.beatMs) {
      lastBeat = now;
      d.emit(`PROGRESS ${rows.map(({ id, s }) => `turns:${id}:${s?.turns ?? 0}`).join(" ")}`);
    }
    if (rows.every(({ s }) => s && isTerminal(s.state))) {
      d.emit("ALL TERMINAL");
      return 0;
    }
    await d.sleep(o.pollMs);
  }
}

export function realWatchDeps(logDir: string, emit: (l: string) => void): WatchDeps {
  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    statuses: () => {
      reconcileStatuses(logDir, new Date(), 0);
      return loadStatuses(logDir);
    },
    urls: () => {
      try {
        return Object.fromEntries(Object.entries(readWorkersSection().workers.providers).map(([k, v]) => [k, v.baseUrl]));
      } catch {
        return {};
      }
    },
    probe: (u) => probeEndpointUrl(u, 3000),
    emit,
  };
}
