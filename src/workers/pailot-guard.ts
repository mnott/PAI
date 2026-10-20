/**
 * pailot-guard.ts — the one gate in front of every PAILot message PAI sends.
 *
 * 2026-10-20: a pane-audit tick re-reported the same violations on every overlapping tick and about 760
 * messages reached the operator's phone in four minutes. Whatever the next bug is, it must not do that:
 * the same text goes to PAILot at most once (persisted marker, so a restart does not repeat it), and no
 * more than PAILOT_MAX_PER_MIN messages leave per minute from all PAI processes; the excess is dropped,
 * one summary line is sent per window and the ledger records PAILOT-RATE-LIMIT.
 *
 * The decision is made synchronously on a small state file before the send, so overlapping callers in one
 * process cannot both pass. The state is a courtesy cache: an unreadable file starts fresh.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLedger } from "./ledger.js";
import { ledgerPath } from "./paths.js";

export const PAILOT_MAX_PER_MIN = 5;
export const PAILOT_DEDUP_MS = 24 * 3600_000;

interface GuardState {
  /** text hash -> ms it was sent */
  sent: Record<string, number>;
  /** ms of each message that left within the last minute */
  recent: number[];
  /** ms of the last summary line, 0 when none in the current window */
  summarised: number;
  dropped: number;
}

const stateFile = (logDir: string): string => join(logDir, "pailot-guard.json");

function load(logDir: string): GuardState {
  try {
    const s = JSON.parse(readFileSync(stateFile(logDir), "utf8")) as Partial<GuardState>;
    return { sent: s.sent ?? {}, recent: s.recent ?? [], summarised: s.summarised ?? 0, dropped: s.dropped ?? 0 };
  } catch {
    return { sent: {}, recent: [], summarised: 0, dropped: 0 };
  }
}

function save(logDir: string, s: GuardState): void {
  try {
    mkdirSync(logDir, { recursive: true });
    const tmp = `${stateFile(logDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), "utf8");
    renameSync(tmp, stateFile(logDir));
  } catch {
    /* the guard is best effort; the in-process decision already stands */
  }
}

export type PailotVerdict = "send" | "duplicate" | "limited";

/**
 * Decide and record. "send": go ahead. "duplicate": this text was already sent. "limited": over the rate;
 * `summary` is set on the first drop of a window (send it, it is allowed through once).
 */
export function pailotGate(logDir: string, text: string, now: number = Date.now(), dedup = true): { verdict: PailotVerdict; summary?: string } {
  const s = load(logDir);
  for (const [h, t] of Object.entries(s.sent)) if (now - t > PAILOT_DEDUP_MS) delete s.sent[h];
  s.recent = s.recent.filter((t) => now - t < 60_000);
  const key = createHash("sha1").update(text).digest("hex");
  if (dedup && s.sent[key] !== undefined) return { verdict: "duplicate" };
  if (s.recent.length >= PAILOT_MAX_PER_MIN) {
    s.sent[key] = now; // dropped text is not retried later either
    s.dropped++;
    let summary: string | undefined;
    if (now - s.summarised >= 60_000) {
      s.summarised = now;
      summary = `PAI held back PAILot messages: more than ${PAILOT_MAX_PER_MIN} in a minute. The rest are dropped; see PAILOT-RATE-LIMIT in the worker ledger.`;
    }
    appendLedger(ledgerPath(logDir), "PAILOT-RATE-LIMIT", { dropped: s.dropped, text: text.slice(0, 120) }, new Date(now));
    save(logDir, s);
    return { verdict: "limited", summary };
  }
  s.sent[key] = now;
  s.recent.push(now);
  s.dropped = 0;
  save(logDir, s);
  return { verdict: "send" };
}

/** Send `text` to PAILot through the gate (`dedup` false: a repeat is a new event, only the rate cap applies); true when it was handed to `send` and accepted. */
export async function guardedPailot(logDir: string, text: string, send: (text: string) => Promise<boolean>, now: () => number = Date.now, dedup = true): Promise<boolean> {
  const g = pailotGate(logDir, text, now(), dedup);
  if (g.verdict === "duplicate") return false;
  if (g.verdict === "limited") {
    if (g.summary) await send(g.summary).catch(() => false);
    return false;
  }
  return send(text);
}
