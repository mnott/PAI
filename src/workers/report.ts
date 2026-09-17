/**
 * report.ts — the worker contract: terse, structured final reports.
 *
 * Headless workers run with an appended system prompt that fixes their output
 * shape: act, verify, then finish with ONE final message that is a JSON object
 * and nothing else. The runner parses it out of the result; the viewer renders
 * it as a compact block instead of a wall of text.
 */

import { relative } from "node:path";
import { shortText } from "./args.js";
import type { Paint } from "./render.js";

/** Appended to the caller's system prompt on every headless run (2h). */
export const WORKER_CONTRACT_PROMPT = [
  "You are a headless implementation worker, run non-interactively by an orchestrating session.",
  "No narration, no timestamps, no greetings, no summaries of what you read; act, verify, then stop.",
  "Your ONE final message is a JSON object and nothing else — no prose before or after, no code fence:",
  '{"changed":[{"path":"…","summary":"…"}],"commands":["…"],"checks":[{"name":"…","ok":true,"detail":"…"}],"open":["…"],"notes":"one line"}',
  "changed: files you touched (path + one-line summary). commands: the commands that verify the work.",
  "checks: each with ok true/false and the evidence in detail. open: what you could not finish, if anything.",
  "notes: one line, the headline a reviewer reads first.",
].join("\n");

export interface WorkerReport {
  changed?: Array<{ path?: string; summary?: string }>;
  commands?: string[];
  checks?: Array<{ name?: string; ok?: boolean; detail?: string }>;
  open?: string[];
  notes?: string;
}

/**
 * Extract the JSON report from a worker's final message. Accepts a bare
 * object, a ```json fenced block, or an object embedded in surrounding text.
 * Only objects that look like the contract count (at least one of changed /
 * checks / notes) — any other JSON falls through to null so the raw text is
 * kept as-is.
 */
export function parseWorkerReport(text: string): WorkerReport | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) candidates.push(fence[1]);
  if (trimmed.startsWith("{")) {
    // a bare object may still carry trailing punctuation/newlines
    candidates.push(trimmed);
  }
  // object embedded in prose: first "{" to the matching last "}"
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const cand of candidates) {
    try {
      const v = JSON.parse(cand) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v) && looksLikeReport(v)) {
        return v as WorkerReport;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The contract's fingerprint — guards against unrelated JSON in a reply. */
function looksLikeReport(v: object): boolean {
  const o = v as WorkerReport;
  return Array.isArray(o.changed) || Array.isArray(o.checks) || typeof o.notes === "string";
}

/**
 * Render a parsed report as the compact block the viewer shows: changed paths
 * with summaries, checks with ✓/✗, open items, notes. Empty report → [].
 */
export function renderReport(c: Paint, prefix: string, r: WorkerReport, cwd = ""): string[] {
  const out: string[] = [];
  const has = (xs: unknown[] | undefined) => (xs ?? []).length > 0;
  if (has(r.changed)) {
    out.push(`${prefix}${c("bold", "changed")}`);
    for (const ch of r.changed!) {
      out.push(`${prefix}  ${relShort(ch.path ?? "?", cwd)} — ${shortText(ch.summary ?? "", 90)}`);
    }
  }
  if (has(r.checks)) {
    out.push(`${prefix}${c("bold", "checks")}`);
    for (const ck of r.checks!) {
      const mark = ck.ok === false ? c("red", "✗") : c("green", "✓");
      const detail = ck.detail ? c("dim", ` · ${shortText(ck.detail, 80)}`) : "";
      out.push(`${prefix}  ${mark} ${ck.name ?? "?"}${detail}`);
    }
  }
  if (has(r.commands)) {
    out.push(`${prefix}${c("bold", "commands")}`);
    for (const cmd of r.commands!) out.push(`${prefix}  ${c("dim", shortText(cmd, 100))}`);
  }
  if (has(r.open)) {
    out.push(`${prefix}${c("bold", "open")}`);
    for (const o of r.open!) out.push(`${prefix}  ${c("yellow", shortText(o, 100))}`);
  }
  if (r.notes) out.push(`${prefix}${c("bold", "notes")}  ${shortText(r.notes, 120)}`);
  return out;
}

/** repo-relative display of a changed path when it lies under cwd. */
function relShort(p: string, cwd: string): string {
  if (!cwd) return p;
  const r = relative(cwd, p);
  return r && !r.startsWith("..") ? r : p;
}
