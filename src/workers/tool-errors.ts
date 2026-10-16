/**
 * tool-errors.ts — systematic worker tool errors.
 *
 * The runner records every failed tool_result as one JSONL line
 * (<logDir>/tool-errors.jsonl) under a normalised signature. Supervision's
 * tick reads that file and, when the same signature repeats, tells the
 * orchestrator once (see detectToolErrors, called from runSupervisionTick).
 * `pai worker errors` lists the signatures grouped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface ToolErrorRecord {
  /** Epoch ms. */
  ts: number;
  worker: string;
  provider: string;
  label: string;
  tool: string;
  signature: string;
  raw: string;
  /** What the tool was asked to do: path, pattern or command head. */
  input?: string;
}

export const TOOL_ERRORS_FILE = "tool-errors.jsonl";
export const SAME_WORKER_MIN = 3;
export const CROSS_WORKER_MIN = 2;
export const CROSS_WORKER_WINDOW_MS = 30 * 60_000;
export const SAME_WORKER_WINDOW_MS = 2 * 60 * 60_000;
export const RESEND_MS = 30 * 60_000;
const SIGNATURE_MAX = 160;
const RAW_MAX = 300;
const INPUT_MAX = 200;
const TAIL_BYTES = 400_000;

export function toolErrorsPath(logDir: string): string {
  return join(logDir, TOOL_ERRORS_FILE);
}

/** Tool name + error text with quoted strings, paths, ids and numbers replaced by placeholders. */
export function normalizeError(tool: string, text: string): string {
  const body = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(["'`])[^"'`]*\1/g, "<S>")
    .replace(/(^|[\s(=:])(~?\/[^\s"'`),;]*)/g, "$1<P>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<ID>")
    .replace(/\b\d{8}-\d{6}-\d+\b/g, "<ID>")
    .replace(/\b\d+\b/g, "<N>");
  return `${tool}|${body.slice(0, SIGNATURE_MAX)}`;
}

/** Path / pattern / command head of a tool_use input, for the error record. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const s = [str("file_path") || str("path"), str("pattern"), str("command")].filter(Boolean).join(" ");
  return s ? s.replace(/\s+/g, " ").slice(0, INPUT_MAX) : undefined;
}

export function recordToolError(
  logDir: string,
  rec: { worker: string; provider: string; label: string; tool: string; text: string; input?: unknown },
  now = Date.now()
): void {
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const line: ToolErrorRecord = {
      ts: now,
      worker: rec.worker,
      provider: rec.provider,
      label: rec.label,
      tool: rec.tool,
      signature: normalizeError(rec.tool, rec.text),
      raw: rec.text.replace(/\s+/g, " ").trim().slice(0, RAW_MAX),
    };
    const input = summarizeToolInput(rec.input);
    if (input) line.input = input;
    appendFileSync(toolErrorsPath(logDir), JSON.stringify(line) + "\n", "utf8");
  } catch {
    // supervision data must never break a run
  }
}

/** Records of the file's tail (bounded read), oldest first; damaged lines skipped. */
export function readToolErrors(logDir: string, sinceMs = 0): ToolErrorRecord[] {
  const path = toolErrorsPath(logDir);
  if (!existsSync(path)) return [];
  let text: string;
  const size = statSync(path).size;
  if (size > TAIL_BYTES) {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(TAIL_BYTES);
    readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    closeSync(fd);
    text = buf.toString("utf8").split("\n").slice(1).join("\n");
  } else {
    text = readFileSync(path, "utf8");
  }
  const out: ToolErrorRecord[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      const r = JSON.parse(l) as ToolErrorRecord;
      if (r.ts >= sinceMs && typeof r.signature === "string") out.push(r);
    } catch {
      /* skip */
    }
  }
  return out;
}

export interface ToolErrorGroup {
  signature: string;
  count: number;
  workers: string[];
  providers: string[];
  first: number;
  last: number;
  sample: string;
  sampleInput?: string;
  /** The worker with the newest record. */
  lastWorker: string;
}

export function groupToolErrors(records: ToolErrorRecord[]): ToolErrorGroup[] {
  const m = new Map<string, ToolErrorGroup>();
  for (const r of records) {
    let g = m.get(r.signature);
    if (!g) {
      g = { signature: r.signature, count: 0, workers: [], providers: [], first: r.ts, last: r.ts, sample: r.raw, sampleInput: r.input, lastWorker: r.worker };
      m.set(r.signature, g);
    }
    g.count += 1;
    if (!g.workers.includes(r.worker)) g.workers.push(r.worker);
    if (!g.providers.includes(r.provider)) g.providers.push(r.provider);
    g.first = Math.min(g.first, r.ts);
    if (r.ts >= g.last) {
      g.last = r.ts;
      g.lastWorker = r.worker;
      g.sample = r.raw;
      g.sampleInput = r.input;
    }
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

/**
 * Signatures to report now. Rules: (a) ≥3 in one worker within 2h, (b) ≥2
 * workers within 30 min, (c) a hook-generated error twice in one worker (a guard that blocks once and teaches the fix is not systematic; two workers is rule b).
 * `sent` (signature → last send epoch ms) holds each signature to one message
 * per RESEND_MS and hides records up to that send; it is updated for the returned groups.
 */
export function detectToolErrors(
  records: ToolErrorRecord[],
  now: number,
  sent: Record<string, number>
): ToolErrorGroup[] {
  const out: ToolErrorGroup[] = [];
  const bySig = new Map<string, ToolErrorRecord[]>();
  for (const r of records) bySig.set(r.signature, [...(bySig.get(r.signature) ?? []), r]);
  for (const [sig, all] of bySig) {
    if (now - (sent[sig] ?? 0) < RESEND_MS) continue;
    // records at or before the last alert were already reported
    const recs = all.filter((r) => r.ts > (sent[sig] ?? 0));
    if (!recs.length) continue;
    const perWorker = new Map<string, number>();
    for (const r of recs) if (now - r.ts <= SAME_WORKER_WINDOW_MS) perWorker.set(r.worker, (perWorker.get(r.worker) ?? 0) + 1);
    const a = [...perWorker.values()].some((n) => n >= SAME_WORKER_MIN);
    const recent = recs.filter((r) => now - r.ts <= CROSS_WORKER_WINDOW_MS);
    const b = new Set(recent.map((r) => r.worker)).size >= CROSS_WORKER_MIN;
    const c = recs[0].raw.includes("hook error") && [...perWorker.values()].some((n) => n >= 2);
    if (!(a || b || c)) continue;
    sent[sig] = now;
    // only rule (b) fired: report just the workers inside its window
    out.push(groupToolErrors(a || c ? recs : recent)[0]);
  }
  return out;
}

export function toolErrorText(g: ToolErrorGroup): string {
  return `systematic error ${g.signature} ×${g.count} in ${g.workers.join(",")} — sample: ${g.sample}${g.sampleInput ? ` (input: ${g.sampleInput})` : ""}`;
}

/** "30m", "2h", "1d" → ms; null when unparsable. */
export function parseSince(s: string): number | null {
  const m = s.match(/^(\d+)([mhd])$/);
  return m ? Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] : null;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function errorsTable(groups: ToolErrorGroup[]): string {
  if (!groups.length) return "no tool errors recorded";
  const rows = [["SIGNATURE", "COUNT", "WORKERS", "PROVIDERS", "FIRST", "LAST"]];
  for (const g of [...groups].sort((a, b) => b.count - a.count)) {
    rows.push([g.signature, String(g.count), String(g.workers.length), g.providers.join(","), hhmm(g.first), hhmm(g.last)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ")).join("\n");
}
