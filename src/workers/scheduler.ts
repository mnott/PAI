/**
 * scheduler.ts — the read side of the local slot scheduler: per session what
 * runs and what waits (position, waited), per engine slots used / conversation
 * slots. The grant order itself lives in capacity.ts (fairOrder); this is what
 * `pai worker queue|ps`, the cockpit and the MCP worker_queue show, and the
 * counters a request-level scheduler can read ("who is next" = nextSession).
 */
import { isLocalProvider, type WorkersConfig } from "./config.js";
import { admitCap, liveQueue, queueRows, sessionOf } from "./capacity.js";
import { alive, isLive, loadStatuses, ownsPid, type WorkerStatus } from "./status.js";

export interface SessionCounters {
  session: string;
  /** Display name: session name, else the short key. */
  name: string;
  running: number;
  waiting: { id: string; provider: string; position: number; waitedSec: number }[];
}

export interface EngineSlots {
  provider: string;
  /** Workers holding a slot. */
  used: number;
  /** Admission cap the gate applies (undefined = unlimited). */
  cap?: number;
  /** Configured conversation-cache slots (undefined = same as maxConcurrent). */
  conversationSlots?: number;
}

export interface SchedulerView {
  sessions: SessionCounters[];
  engines: EngineSlots[];
}

const nameOf = (s: WorkerStatus | undefined, key: string): string => s?.sessionKey || s?.session?.name || key.slice(0, 8);

/** Sessions with local work (running or waiting) and engines with their slot use. */
export function schedulerView(
  logDir: string,
  workers: Pick<WorkersConfig, "providers">,
  now: number = Date.now(),
  statuses: WorkerStatus[] = loadStatuses(logDir),
  owns: (w: Pick<WorkerStatus, "pid" | "started">) => boolean = ownsPid,
  isAlive: (pid: number) => boolean = alive
): SchedulerView {
  const local = (name: string): boolean => {
    const p = workers.providers[name];
    return !!p && isLocalProvider(p.baseUrl);
  };
  const by = new Map<string, SessionCounters>();
  const get = (s: WorkerStatus | undefined): SessionCounters => {
    const key = sessionOf(s);
    let c = by.get(key);
    if (!c) by.set(key, (c = { session: key, name: nameOf(s, key), running: 0, waiting: [] }));
    return c;
  };
  const used = new Map<string, number>();
  for (const s of statuses) {
    if (!local(s.provider) || s.state !== "running" || !isLive(s, owns)) continue;
    get(s).running++;
    used.set(s.provider, (used.get(s.provider) ?? 0) + 1);
  }
  const sinceOf = new Map(queueRows(logDir, {}, isAlive).map((r) => [`${r.provider}/${r.id}`, r.since]));
  for (const prov of new Set(queueRows(logDir, {}, isAlive).map((r) => r.provider))) {
    if (prov.startsWith("session~") || !local(prov)) continue;
    liveQueue(logDir, prov, isAlive, statuses, now).forEach((id, i) => {
      get(statuses.find((s) => s.id === id)).waiting.push({
        id,
        provider: prov,
        position: i + 1,
        waitedSec: Math.max(0, Math.floor((now - (sinceOf.get(`${prov}/${id}`) ?? now)) / 1000)),
      });
    });
  }
  const engines: EngineSlots[] = Object.entries(workers.providers)
    .filter(([n]) => local(n))
    .map(([n, p]) => ({
      provider: n,
      used: used.get(n) ?? 0,
      cap: admitCap(p.maxConcurrent, p.conversationSlots, true),
      ...(p.conversationSlots !== undefined ? { conversationSlots: p.conversationSlots } : {}),
    }));
  return { sessions: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)), engines };
}

/** The session whose waiting ticket is granted next (head of the fair order), or null. */
export function nextSession(v: SchedulerView): string | null {
  return v.sessions.find((c) => c.waiting.some((w) => w.position === 1))?.session ?? null;
}

const mins = (sec: number): string => (sec < 90 ? `${sec}s` : `${Math.floor(sec / 60)}m`);

/** Plain-text lines: engines "p: slots 2/3 (conversation slots 4)", then per session running / waiting. */
export function schedulerLines(v: SchedulerView): string[] {
  const lines: string[] = [];
  for (const e of v.engines) {
    if (!e.used && !v.sessions.some((s) => s.waiting.some((w) => w.provider === e.provider))) continue;
    lines.push(`engine ${e.provider}: slots ${e.used}/${e.cap ?? "unlimited"}${e.conversationSlots !== undefined ? `, conversation slots ${e.conversationSlots}` : ""}`);
  }
  for (const s of v.sessions) {
    lines.push(
      `session ${s.name}: ${s.running} running, ${s.waiting.length} waiting` +
        (s.waiting.length ? ` (${s.waiting.map((w) => `#${w.position} ${w.id} waited ${mins(w.waitedSec)}`).join(", ")})` : "")
    );
  }
  return lines;
}
