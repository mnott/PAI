/**
 * active-time.ts — a worker's deadline counts active time only. Waiting for a
 * local slot (capacity gate) and blocked in a build-gate wait (`pai build
 * run|lock`, a door with --wait) are not work: the first is added to the
 * deadline when the slot is granted, the second is recorded here by the build
 * gate (it knows the ticket's worker via PAI_WORKER_ID) in a sidecar file
 * <logDir>/waits/<worker>.json = { ms, since }: `ms` closed waits, `since`
 * the start of the wait in progress. Not measured: a model request waiting
 * in the engine's own FIFO (the engine reports no per-request queue time).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface WaitFile {
  ms: number;
  since: number | null;
}

const waitPath = (logDir: string, id: string): string => join(logDir, "waits", `${id.replace(/[^\w.-]/g, "_")}.json`);

function read(logDir: string, id: string): WaitFile {
  try {
    const w = JSON.parse(readFileSync(waitPath(logDir, id), "utf8")) as Partial<WaitFile>;
    return { ms: Number(w.ms) || 0, since: typeof w.since === "number" ? w.since : null };
  } catch {
    return { ms: 0, since: null };
  }
}

function write(logDir: string, id: string, w: WaitFile): void {
  try {
    mkdirSync(join(logDir, "waits"), { recursive: true });
    writeFileSync(waitPath(logDir, id), JSON.stringify(w));
  } catch {
    // accounting must never break a build
  }
}

/** The worker starts waiting on a build gate. */
export function beginBuildWait(logDir: string, id: string, now: number = Date.now()): void {
  const w = read(logDir, id);
  if (w.since === null) write(logDir, id, { ...w, since: now });
}

/** The wait ended (slot granted, aborted): fold it into the closed total. */
export function endBuildWait(logDir: string, id: string, now: number = Date.now()): void {
  const w = read(logDir, id);
  if (w.since !== null) write(logDir, id, { ms: w.ms + Math.max(0, now - w.since), since: null });
}

/** Total ms the worker spent blocked in build-gate waits, the one in progress included. */
export function buildWaitMs(logDir: string, id: string, now: number = Date.now()): number {
  const w = read(logDir, id);
  return w.ms + (w.since === null ? 0 : Math.max(0, now - w.since));
}

/** "active 12 of 60 min, waited 31" for a limited run (waited = queue + build-gate waits); null without a limit. */
export function activeText(
  s: { started: string; maxMinutes?: number | null; queueWaitedMs?: number | null; blockedMs?: number | null },
  now: number
): string | null {
  if (!s.maxMinutes) return null;
  const blocked = s.blockedMs ?? 0;
  const startedAt = Date.parse(s.started.replace(" ", "T"));
  const active = Number.isFinite(startedAt) ? Math.max(0, now - startedAt - blocked) : 0;
  const m = (ms: number): number => Math.floor(ms / 60_000);
  return `active ${m(active)} of ${s.maxMinutes} min, waited ${m(blocked + (s.queueWaitedMs ?? 0))}`;
}
