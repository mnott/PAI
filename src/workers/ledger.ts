/**
 * ledger.ts — the routing ledger, one append-only log for every worker event.
 *
 * Line shapes (whitespace-aligned so `tail` reads as a table):
 *
 *   2026-09-17 12:00:00 WORKER-START id=<id> provider=<p> mode=headless model=<m> cwd=<cwd> label=<label>
 *   2026-09-17 12:01:00 WORKER-END   id=<id> provider=<p> mode=headless model=<m> rc=0 secs=60 turns=3 tools=8 label=<label>
 *   2026-09-17 12:00:20 WORKER-REROUTE from=<a> to=<b> reason=quota
 *   2026-09-17 12:00:00 DENIED-ANTHROPIC-AGENT cwd=<cwd> desc=<desc>
 *   2026-09-17 12:00:00 ALLOWED-ANTHROPIC-AGENT cwd=<cwd> desc=<desc>
 *
 * `pai worker log` (and glm-log before it) counts these; keep the tags stable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function ledgerStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export interface LedgerLine {
  stamp: string;
  event: string;
  fields: Record<string, string>;
}

/** Parse `2026-09-17 12:00:00 TAG key=value …` into its parts. */
export function parseLedgerLine(line: string): LedgerLine | null {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+)(?: (.*))?$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  // values are whitespace-collapsed by the writers, so spaces safely delimit
  for (const part of (m[3] ?? "").split(" ")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { stamp: m[1], event: m[2], fields };
}

export function parseLedger(text: string): LedgerLine[] {
  const out: LedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLedgerLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Append one ledger line. `kv` order is the caller's; values are flattened. */
export function appendLedger(
  path: string,
  event: string,
  kv: Record<string, string | number | null | undefined>,
  now: Date = new Date()
): void {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${String(v).replace(/\s+/g, " ")}`);
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tail = parts.length ? " " + parts.join(" ") : "";
  appendFileSync(path, `${ledgerStamp(now)} ${event}${tail}\n`, "utf8");
}

export interface LedgerSummary {
  scope: string;
  started: number;
  endedOk: number;
  endedFailed: number;
  denied: number;
  allowed: number;
  reroutes: number;
  lastLines: string[];
}

/** The counts `pai worker log` prints, over today's lines or the whole file. */
export function ledgerSummary(
  path: string,
  scope: "today" | "all",
  lastN = 15,
  now: Date = new Date()
): LedgerSummary | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const today = ledgerStamp(now).slice(0, 10);
  const lines = text.split("\n").filter((l) => l.trim());
  const scoped =
    scope === "all" ? lines : lines.filter((l) => l.startsWith(today));
  const parsed = scoped.map(parseLedgerLine).filter((x): x is LedgerLine => x !== null);
  const count = (ev: string) => parsed.filter((p) => p.event === ev).length;
  const ends = parsed.filter((p) => p.event === "WORKER-END");
  const ok = ends.filter((p) => p.fields.rc === "0").length;
  return {
    scope: scope === "all" ? "all time" : `today ${today}`,
    started: count("WORKER-START"),
    endedOk: ok,
    endedFailed: ends.length - ok,
    denied: count("DENIED-ANTHROPIC-AGENT"),
    allowed: count("ALLOWED-ANTHROPIC-AGENT"),
    reroutes: count("WORKER-REROUTE"),
    lastLines: lines.slice(-lastN),
  };
}
