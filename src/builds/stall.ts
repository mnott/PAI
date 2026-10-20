/**
 * stall.ts — a running build job whose output stands still holds its key for nobody's benefit.
 * Incident 2026-10-20: an xcodebuild test run hung in one XCTest case for 17 min while two jobs queued
 * behind its key. The daemon ticks this every 30 s: a running ticket whose gate log plus declared door
 * logs (ticket.logs) have not grown for `minutes` is marked stalledAt (shown as STALLED by `pai build queue`,
 * ps and the cockpit), logged BUILD-STALL with the last output line, and its owner is told once. Never kills.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { patchTicket, type BuildTicket } from "./queue.js";

export interface StallDeps {
  /** Size of a file, null when unreadable. */
  size: (path: string) => number | null;
  /** Last non-empty line of a file, "" when none. */
  lastLine: (path: string) => string;
  now: () => number;
  log: (line: string) => void;
  /** Tell the owning session. */
  notify: (t: BuildTicket, text: string) => Promise<unknown> | void;
}

/** Per-ticket watch state, kept by the caller between ticks. */
export type StallState = Map<string, { sig: string; since: number }>;

export const XCODE_TIMEOUT_HINT = "-test-timeouts-enabled YES -default-test-execution-time-allowance 60 -maximum-test-execution-time-allowance 120";

export const realSize = (p: string): number | null => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};

export function realLastLine(p: string): string {
  try {
    const size = statSync(p).size;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  } catch {
    return "";
  }
}

const watched = (t: BuildTicket): string[] => [...new Set([t.log, ...(t.logs ?? [])].filter((x): x is string => !!x))];

const isXcode = (t: BuildTicket, last: string): boolean => /xcodebuild|xctest|\.xcodeproj|Test Case '/i.test(`${t.cmd} ${t.key ?? ""} ${last}`);

const mins = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function stallMessage(t: BuildTicket, quietMs: number, last: string, behind: BuildTicket[]): string {
  const jobs = behind.length ? behind.map((b) => `${b.label} (${b.session})`).join(", ") : "none";
  const hint = isXcode(t, last) ? `; xcodebuild: add ${XCODE_TIMEOUT_HINT} so a hung test fails instead of holding the key` : "";
  return `build ${t.label}${t.key ? ` [${t.key}]` : ""} stalled ${mins(quietMs)} min; last line: ${last || "(no output)"}; jobs waiting behind it: ${jobs}${hint}. Not killed: stop it with \`pai build release ${t.id}\` or kill the worker.`;
}

/** One pass over the tickets; returns the ids newly flagged. */
export async function stallTick(dir: string, tickets: BuildTicket[], minutes: number, state: StallState, deps: StallDeps): Promise<string[]> {
  const now = deps.now();
  const flagged: string[] = [];
  const running = tickets.filter((t) => t.state === "running");
  for (const id of [...state.keys()]) if (!running.some((t) => t.id === id)) state.delete(id);
  for (const t of running) {
    const files = watched(t);
    const sig = files.map((f) => `${f}=${deps.size(f) ?? "-"}`).join("|");
    const prev = state.get(t.id);
    if (!prev || prev.sig !== sig) {
      state.set(t.id, { sig, since: now });
      if (t.stalledAt) await patchTicket(dir, t.id, { stalledAt: undefined });
      continue;
    }
    const quiet = now - prev.since;
    if (t.stalledAt || quiet < minutes * 60_000) continue;
    const last = files.map((f) => deps.lastLine(f)).filter(Boolean).pop() ?? "";
    await patchTicket(dir, t.id, { stalledAt: now });
    const behind = tickets.filter((x) => x.state === "waiting" && x.key && x.key === t.key);
    const text = stallMessage(t, quiet, last, behind);
    deps.log(`BUILD-STALL ${t.id} ${t.label} key=${t.key ?? "-"} quiet=${mins(quiet)}m last=${last || "-"}`);
    await Promise.resolve(deps.notify(t, text)).catch(() => undefined);
    flagged.push(t.id);
  }
  return flagged;
}

const daemonState: StallState = new Map();

/** Daemon tick: real files, ledger-less BUILD-STALL on stderr, owner told through `tell`. */
export async function buildStallTick(dir: string, minutes: number, tell: (t: BuildTicket, text: string) => Promise<unknown>, tickets: BuildTicket[], deps: Partial<StallDeps> = {}): Promise<string[]> {
  return stallTick(dir, tickets, minutes, daemonState, {
    size: realSize,
    lastLine: realLastLine,
    now: Date.now,
    log: (l) => process.stderr.write(l + "\n"),
    notify: tell,
    ...deps,
  });
}
