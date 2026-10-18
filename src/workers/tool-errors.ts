/**
 * tool-errors.ts — systematic worker tool errors.
 *
 * The runner records every failed tool_result as one JSONL line
 * (<logDir>/tool-errors.jsonl) under a normalised signature. Supervision's
 * tick reads that file on two routes (see runSupervisionTick): while a worker
 * is RUNNING, the first occurrence of each signature — all classes — is
 * pushed to the session that spawned it (detectRunningWorkerErrors);
 * everything else keeps the actionable-only thresholds (detectToolErrors,
 * the same signature repeating tells the orchestrator once per 30 min).
 * `pai worker errors` lists the signatures grouped.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { dropHeredocBodies } from "../hooks/ts/lib/heredoc.js";
import { GUARD_MARKER } from "../hooks/ts/lib/render-decision.js";

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
const INPUT_MAX = 1000;
const TAIL_BYTES = 400_000;

export type ErrorClass = "harness" | "model" | "benign" | "unknown";

export interface Classification {
  cls: ErrorClass;
  /** One-line hint naming what the error is. */
  hint: string;
  /** Model-only: same-worker count that makes it an alert (Infinity = never). */
  loopAt?: number;
}

const cwdOf = (raw: string): string | undefined => raw.match(/working directory (?:is )?(\/[^\s"'`),;]*)/i)?.[1]?.replace(/[.]+$/, "");
const inputPath = (r: ToolErrorRecord): string | undefined => r.input?.split(" ")[0];

/**
 * Deterministic classification, first match wins. The one table to extend:
 * model rules are recorded but alert only at loopAt (Infinity: never);
 * harness rules alert at the usual thresholds; anything else is unknown.
 */
/** Declared tool names a model may mis-case; the router rewrites these (src/router/tool-case.ts). */
const CASED_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

/** The name in "No such tool available: bash" when it is a wrong-case spelling of a known tool. */
function wrongCaseTool(raw: string): string | null {
  const name = raw.match(/No such tool available:?\s*(\S+)/i)?.[1]?.replace(/[.,;:"'`]+$/, "");
  if (!name || CASED_TOOLS.includes(name)) return null;
  return CASED_TOOLS.find((t) => t.toLowerCase() === name.toLowerCase()) ? name : null;
}

const SEARCH_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "ugrep", "ag"]);

/** Last simple command of a pipeline / && / ; chain: command name (path and env prefixes stripped) and the full segment. */
function lastCommand(command: string): { name: string; segment: string } | null {
  const bare = dropHeredocBodies(command).replace(/(["'])(?:\\.|(?!\1).)*\1/g, "Q");
  const segs = bare.split(/\|\|?|&&|;|\n/).map((x) => x.trim()).filter(Boolean);
  const segment = segs[segs.length - 1];
  if (!segment) return null;
  const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_]\w*=/.test(w));
  const name = (words[0] ?? "").replace(/^.*\//, "");
  return name ? { name, segment } : null;
}

/**
 * Bash exits that are the tool's normal answer, matched on exit code AND
 * command shape AND output marker: search no-match (exit 1, empty output),
 * diff/cmp "differ" (exit 1), test/[ false (exit 1, empty output), a vitest
 * run that reports failing tests (exit 1), zsh's "=, ==, === not found" (any run of =) from an
 * `echo ===` separator, and timeout's own 124/144 after a deliberate bound.
 */
export function isBenignBash(r: ToolErrorRecord): boolean {
  if (r.tool !== "Bash" || !r.input) return false;
  const m = r.raw.match(/^Exit code (\d+)\s*(.*)$/i);
  const code = m ? Number(m[1]) : null;
  const out = (m?.[2] ?? r.raw).trim();
  const cmd = r.input;
  if (/^(?:\(eval\)|zsh):\d+: =+ not found$/m.test(out) && /\becho\s+["']?=+/.test(cmd)) return true;
  if (code === null) return false;
  if ((code === 124 || code === 144) && /(^|[\s;&|(])g?timeout\s+(-\S+\s+)*\d/.test(cmd)) return true;
  const last = lastCommand(cmd);
  if (code === 3 && last && /^pai\s+worker\s+wait(-on|-url|-file)?\b/.test(last.segment)) return /not yet|still running/i.test(out);
  if (code !== 1) return false;
  if (!last) return false;
  const emptyOut = out === "" || /^(\(?no (output|matches)\)?|<no output>)$/i.test(out);
  if (SEARCH_CMDS.has(last.name)) return emptyOut;
  if (last.name === "test" || last.name === "[") return emptyOut;
  if (last.name === "diff" || last.name === "cmp") return !/No such file|Permission denied|usage:|invalid option/i.test(out);
  if (last.name === "ls" && /\bsleep\b/.test(cmd)) return /No such file or directory/i.test(out);
  if (/\bvitest\b/.test(cmd) && /\b(run|--run)\b|^npx vitest/.test(cmd)) {
    return /(FAIL\b|Test Files|Tests\s+\d|AssertionError|expected .* to)/.test(out) && !/error TS\d+|Cannot find|SyntaxError|ERR_MODULE/i.test(out);
  }
  return false;
}

/** An HTTP status only counts next to API/auth wording, never as a bare number in tool output. */
const API_AUTH_EVIDENCE = new RegExp(
  [
    "Failed to authenticate",
    "API Error",
    "\\b(?:status|HTTP|error|code)[ :=]+(?:401|403|429|5\\d\\d)\\b",
    "\\b(?:401|403)\\s+(?:Unauthorized|Forbidden)\\b",
    "\\b429\\s+Too Many Requests\\b",
    "authentication_error|permission_error|rate_limit_error|overloaded_error|api_error",
    "invalid x-api-key|invalid api key|OAuth token",
  ].join("|"),
  "i"
);

/** A 5xx status in a request context (returned/status/HTTP/error or its reason phrase). */
const LOCAL_5XX_EVIDENCE = /\b(?:returned|responded(?: with)?|status|HTTP(?:\/[\d.]+)?|error|code)[ :=]+5\d\d\b|\b5\d\d\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)/i;

const RULES: Array<{ test: (r: ToolErrorRecord) => boolean; c: Classification }> = [
  { test: (r) => /no matches/i.test(r.raw) && /^(Grep|Bash)$/.test(r.tool), c: { cls: "model", hint: "search found nothing", loopAt: Infinity } },
  { test: isBenignBash, c: { cls: "benign", hint: "expected non-zero exit", loopAt: Infinity } },
  { test: (r) => r.tool === "Bash" && /\b(?:ls|cat|tail|head|cd|stat|wc): .*No such file or directory/i.test(r.raw), c: { cls: "model", hint: "Bash on a path that does not exist (model error)", loopAt: 5 } },
  // The sleep-poll gate is a model error and must win over the generic guard rule below.
  { test: (r) => /sleep .*blocked/i.test(r.raw), c: { cls: "model", hint: "guard: sleep blocked", loopAt: 3 } },
  { test: (r) => r.raw.includes(GUARD_MARKER), c: { cls: "benign", hint: "guard redirect (PAI guard steering the model)", loopAt: Infinity } },
  { test: (r) => wrongCaseTool(r.raw) !== null, c: { cls: "model", hint: "tool name in the wrong case (model error)", loopAt: 3 } },
  {
    test: (r) => {
      const cwd = cwdOf(r.raw), p = inputPath(r);
      return r.tool === "Read" && /File does not exist/i.test(r.raw) && !!cwd && !!p && (p === cwd || p.startsWith(cwd + "/"));
    },
    c: { cls: "model", hint: "Read of a missing file inside the worker cwd", loopAt: Infinity },
  },
  { test: (r) => /exactly the same|String to replace not found/i.test(r.raw), c: { cls: "model", hint: "Edit with a wrong old_string", loopAt: 5 } },
  { test: (r) => /no AI attribution/i.test(r.raw), c: { cls: "model", hint: "commit guard: AI attribution denied", loopAt: 3 } },
  { test: (r) => /git checkout .*blocked|checkout .* blocked/i.test(r.raw), c: { cls: "model", hint: "guard: git checkout blocked", loopAt: 3 } },
  { test: (r) => /Bash timeout .*blocked/i.test(r.raw), c: { cls: "model", hint: "guard: Bash timeout blocked", loopAt: 3 } },
  {
    test: (r) => {
      if (!/hook error/i.test(r.raw)) return false;
      const cwd = cwdOf(r.raw);
      const paths = r.raw.match(/(?:^|[\s(=:])(\/[^\s"'`),;]+)/g)?.map((x) => x.replace(/^[\s(=:]+/, "")) ?? [];
      return paths.some((p) => (!cwd || !(p === cwd || p.startsWith(cwd + "/"))) && existsSync(p));
    },
    c: { cls: "harness", hint: "hook error on an existing path outside the worker cwd" },
  },
  { test: (r) => /^empty-response/i.test(r.raw), c: { cls: "model", hint: "empty first reply — model stopped at once (seen with short spec prompts); one automatic relaunch already ran" } },
  { test: (r) => /Working directory .* was deleted/i.test(r.raw), c: { cls: "harness", hint: "worker cwd deleted" } },
  { test: (r) => API_AUTH_EVIDENCE.test(r.raw), c: { cls: "harness", hint: "API/auth error" } },
  { test: (r) => /No such tool available/i.test(r.raw), c: { cls: "harness", hint: "tool missing in the worker" } },
  { test: (r) => LOCAL_5XX_EVIDENCE.test(r.raw) && /localhost|127\.0\.0\.1/.test(r.raw), c: { cls: "harness", hint: "HTTP 5xx from a local server" } },
];

export function classifyToolError(r: ToolErrorRecord): Classification {
  return RULES.find((x) => x.test(r))?.c ?? { cls: "unknown", hint: "unclassified" };
}

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

export function clipRaw(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= RAW_MAX) return normalized;
  return normalized.slice(0, 180) + " … " + normalized.slice(-117);
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
      raw: clipRaw(rec.text),
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
  cls: ErrorClass;
  hint: string;
}

const pick = (r: ToolErrorRecord) => {
  const { cls, hint } = classifyToolError(r);
  return { cls, hint };
};

export function groupToolErrors(records: ToolErrorRecord[]): ToolErrorGroup[] {
  const m = new Map<string, ToolErrorGroup>();
  for (const r of records) {
    let g = m.get(r.signature);
    if (!g) {
      g = { signature: r.signature, count: 0, workers: [], providers: [], first: r.ts, last: r.ts, sample: r.raw, sampleInput: r.input, lastWorker: r.worker, ...pick(r) };
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
    const recs = all.filter((r) => r.ts > (sent[sig] ?? 0) && classifyToolError(r).loopAt !== Infinity);
    if (!recs.length) continue;
    const loopAt = classifyToolError(recs[0]).loopAt;
    const perWorker = new Map<string, number>();
    for (const r of recs) if (now - r.ts <= SAME_WORKER_WINDOW_MS) perWorker.set(r.worker, (perWorker.get(r.worker) ?? 0) + 1);
    if (loopAt !== undefined) {
      // model-only: alert just when one worker loops on it
      const n = Math.max(0, ...perWorker.values());
      if (n < loopAt) continue;
      sent[sig] = now;
      out.push(groupToolErrors(recs)[0]);
      continue;
    }
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
  const what = `${g.signature} ×${g.count} in ${g.workers.join(",")} — sample: ${g.sample}${g.sampleInput ? ` (input: ${g.sampleInput})` : ""}`;
  const tail = "harness → stop runs it spoils, fix the cause in PAI/AIBroker, prove it, commit; model → counts against the model, stop the run if it loops; details: pai worker errors";
  if (g.cls === "harness") return `[harness] ${g.hint}: ${what} — fix at the owner. ${tail}`;
  if (g.cls === "model") return `[model ×${g.count}] ${g.hint}: ${what} — counts against the model; stop the run if it loops. ${tail}`;
  if (g.cls === "benign") return `[benign] ${g.hint}: ${what}`;
  return `[unknown] ${what} — ${tail}`;
}

/**
 * A running worker whose spawner is known: errors go to that session.
 */
export interface RunningWorkerRef {
  id: string;
  /** Owning session key (the spawner's claude session id, else the iTerm uuid). */
  session: string;
}

export interface RunningErrorPush {
  worker: string;
  session: string;
  signature: string;
  group: ToolErrorGroup;
  /** Benign exits of this worker recorded so far and not pushed. */
  benign: number;
}

/** Appended to an alert so the spawner knows what was held back. */
export function benignNote(n: number): string {
  return n > 0 ? ` (+${n} benign tool exits suppressed)` : "";
}

/**
 * Stable short tag of a signature, for claim ids: once-per-(worker,signature)
 * delivery that survives a lost state file.
 */
export function toolErrorSigTag(signature: string): string {
  let h = 5381;
  for (let i = 0; i < signature.length; i++) h = ((h * 33) ^ signature.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * While a worker is RUNNING, its tool errors are pushed to the session that
 * spawned it — the FIRST occurrence of each signature, ALL classes. 2026-10-17:
 * a run doomed from its first tool call (worktree of the wrong repo → every
 * path error [model]-class) was silently classified away by the
 * actionable-only filter, and the spawner learned of it only by polling
 * `pai worker errors`. Actionability is not the daemon's to guess: the
 * spawner wrote the spec and knows what a spoiled run looks like. Later
 * occurrences of a pushed signature are counted (the group's count, and the
 * run-end result report carries the totals), never re-pushed; nothing is
 * pushed after the run ends. `sent` maps worker id → signature → push time
 * and is updated for the returned pushes.
 */
export function detectRunningWorkerErrors(
  running: readonly RunningWorkerRef[],
  records: readonly ToolErrorRecord[],
  sent: Record<string, Record<string, number>>,
  now: number,
  harnessOnly = false
): RunningErrorPush[] {
  const sessions = new Map(running.map((r) => [r.id, r.session] as const));
  const byWorker = new Map<string, Map<string, ToolErrorRecord[]>>();
  const benign = new Map<string, number>();
  for (const r of records) {
    if (!sessions.has(r.worker)) continue;
    if (harnessOnly && classifyToolError(r).cls !== "harness") {
      if (classifyToolError(r).cls === "benign") benign.set(r.worker, (benign.get(r.worker) ?? 0) + 1);
      continue; // recorded, summarised at the end of the run, not pushed
    }
    if (classifyToolError(r).cls === "benign") {
      benign.set(r.worker, (benign.get(r.worker) ?? 0) + 1); // recorded and counted, never pushed
      continue;
    }
    let bySig = byWorker.get(r.worker);
    if (!bySig) byWorker.set(r.worker, (bySig = new Map()));
    bySig.set(r.signature, [...(bySig.get(r.signature) ?? []), r]);
  }
  const out: RunningErrorPush[] = [];
  for (const [worker, bySig] of byWorker) {
    const pushed = (sent[worker] ??= {});
    for (const [sig, all] of bySig) {
      if (pushed[sig] !== undefined) continue; // first occurrence per run, never re-pushed
      pushed[sig] = now;
      out.push({ worker, session: sessions.get(worker)!, signature: sig, group: groupToolErrors(all)[0], benign: benign.get(worker) ?? 0 });
    }
  }
  return out;
}

/**
 * One line for a unit's end-of-run notice: counts by class and the most
 * frequent signature ("tool errors: 12 model, 3 benign; top: tsc TS2307 x4").
 * Empty string when the worker recorded none.
 */
export function toolErrorSummary(records: readonly ToolErrorRecord[], worker: string): string {
  const mine = records.filter((r) => r.worker === worker);
  if (!mine.length) return "";
  const byCls = new Map<ErrorClass, number>();
  const bySig = new Map<string, number>();
  for (const r of mine) {
    const c = classifyToolError(r).cls;
    byCls.set(c, (byCls.get(c) ?? 0) + 1);
    bySig.set(r.signature, (bySig.get(r.signature) ?? 0) + 1);
  }
  const counts = (["harness", "model", "unknown", "benign"] as const).filter((c) => byCls.has(c)).map((c) => `${byCls.get(c)} ${c}`);
  const [sig, n] = [...bySig.entries()].sort((a, b) => b[1] - a[1])[0];
  return `tool errors: ${counts.join(", ")}; top: ${sig.slice(0, 80)} x${n}`;
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
