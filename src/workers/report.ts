/**
 * report.ts — the worker contract: terse, structured final reports.
 *
 * Headless workers run with an appended system prompt that fixes their output
 * shape: act, verify, then finish with ONE final message — AG2 (see
 * agentish.ts) by default, JSON as the pre-AG2 fallback. The runner parses it
 * out of the result; the viewer renders it as a compact block instead of a
 * wall of text.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { shortText } from "./args.js";
import type { Paint } from "./render.js";
import { ag2Spec, ag2ToWorkerReport, parseAg2Report } from "./agentish.js";

/** The marker the runner puts on operator messages the worker must answer. */
export const OPERATOR_MARK = "[operator]";

/** Classes that get the short contract — cheap, bounded, single-answer tasks. */
const SHORT_CONTRACT_CLASSES = new Set(["spotcheck", "simple"]);

/**
 * The AG2 report block appended to a contract when format is "ag2" — field
 * set matches `aibroker agentish check`'s real R schema (verified 2026-09-20:
 * i/r/t/c are required, not optional as an early draft of this contract had
 * it; r=+ needs G=+ and non-empty p too, not just all-t-passing; R has no
 * `u`/out field at all — u is T-only — so the answer goes in z instead).
 */
function ag2ReportBlock(): string[] {
  const spec = ag2Spec();
  return [
    spec.spec,
    spec.extensions,
    "Final message: one AG2 `R` message only — no prose, no code fence, no markdown.",
    "R requires i (id), r (+ - ~ ? !), t (tests, Name+ Name-), c (path summary|path summary).",
    "r=+ requires G=+ (gate) and p non-empty (proof command), and every t entry +. z= the answer/note,",
    "one line, always present. x= what is left (omit if nothing). y= one line why when r is not +.",
    "Example:",
    "R",
    "i=count-audit-ts",
    "r=+",
    "G=+",
    "c=src/audit summary of files counted",
    "t=Count+",
    "p=wc -l src/audit/*.ts",
    "z=19 files, 2523 lines",
  ];
}

/** The JSON report block appended to a contract when format is "json" (pre-AG2 fallback). */
function jsonReportBlock(lead: string): string[] {
  return [
    lead,
    '{"changed":[{"path":"…","summary":"…"}],"commands":["…"],"checks":[{"name":"…","ok":true,"detail":"…"}],"open":["…"],"notes":"one line"}',
  ];
}

/** The two sentences that stop a worker from breaking on shell quoting — kept in both contracts. */
function fileNotInlineBlock(): string[] {
  return [
    "NEVER put a multi-line or quoted payload inline in a shell command — no heredocs (<<EOF), no long",
    "-p '…' specs for child workers, no inline JSON, no inline scripts. ALWAYS write it to a file with",
    "the Write tool first and pass the file: -p \"$(cat spec.txt)\", --file spec.txt, or < spec.txt.",
    "Inline quoting fails silently or dies with a parse error and burns a worker launch; there are no",
    "exceptions.",
    "Never inline code one-liners (python3 -c, node -e, ruby -e and friends) — the permission layer",
    "denies them (\"ztk: command denied by permission rules\"); write the script to a file with the",
    "Write tool and run it (python3 script.py), or use jq for JSON inspection.",
  ];
}

/** The file-not-inline rule, condensed for the short contract's tight length budget. */
function fileNotInlineBlockShort(): string[] {
  return [
    "NEVER put a multi-line or quoted payload inline in a shell command (no heredocs, no inline",
    "scripts): write it to a file with the Write tool and pass it, e.g. -p \"$(cat spec.txt)\".",
    "Never inline code (python3 -c and friends) — write a script file and run it, or use jq.",
  ];
}

/** spotcheck/simple: headless, bounded, no delegation language — under 1500 chars in ag2 format. */
function shortContractPrompt(format: "ag2" | "json"): string {
  const lines = [
    "You are a headless implementation worker, run non-interactively.",
    "This task is yours: answer the question or do the bounded task now. Run at most one command",
    "to confirm a result and never re-derive a number you already have. No child workers, no handoff.",
    ...fileNotInlineBlockShort(),
  ];
  lines.push(
    ...(format === "ag2"
      ? ag2ReportBlock()
      : jsonReportBlock(
          "Your ONE final message is a JSON object and nothing else — no prose before or after, no code fence:"
        ))
  );
  return lines.join("\n");
}

/** Every other class (and no class): the full worker/orchestrator contract. */
function fullContractPrompt(format: "ag2" | "json"): string {
  const lines = [
    "You are a headless implementation worker, run non-interactively by an orchestrating session.",
    "You are the worker: this task is yours to finish in this process. Never hand your whole task to a",
    "single child worker and step back — that is delegation, not work. Child workers are for two things",
    "only: (1) PARALLELISING independent parts of your task, each part a self-contained spec; (2) CHEAPER",
    "bounded sub-tasks — probes, renders, test runs, lookups — run one tier down with --class spotcheck or",
    "--class simple. Always pin --provider anthropic on children.",
    "You own your children's results: run them in the foreground or poll until each has finished, read",
    "their result, verify it, and fold it into your own report. When your turn ends this run ends and any",
    "running child is killed, so never end with a child still running.",
    "Ending your turn ends this run. There is no later wake-up: never call ScheduleWakeup, never say you",
    "will pick something up later, never leave a background command as your final action. Finish, then",
    "report.",
    "No narration, no timestamps, no greetings, no summaries of what you read; act, verify, then stop.",
    "Never sleep longer than 60 seconds in one command; wait on a bounded timeout or event instead.",
    ...fileNotInlineBlock(),
    "",
    `Operator messages: a user turn starting with ${OPERATOR_MARK} was typed by the operator while you`,
    "run (the prompt of a resumed run is the operator's too). Answer it FIRST, in one or two plain lines —",
    "a question gets its answer, an instruction gets one line naming what will change — then continue the",
    "task you were on.",
    "",
    "Sub-workers: you may start your own workers with `pai worker run --class <class> -p '<prompt>'`",
    "(Bash tool). Your children run on their own provider and report back to you automatically when",
    "they finish. Send a handoff UP instead of doing work yourself when a cheaper provider would",
    "suffice, the task is out of your scope, or a decision is needed:",
    "`pai worker handoff '{\"kind\":\"proposal\",\"text\":\"…\",\"data\":{…}}'` (kinds: proposal,",
    "question, blocker; results are sent for you when you finish). Sibling workers are not a",
    "coordination path — there is no sideways channel; everything goes up to your parent.",
    "",
  ];
  lines.push(
    ...(format === "ag2"
      ? ag2ReportBlock()
      : jsonReportBlock(
          "Your ONE final message is a JSON object and nothing else — no prose before or after, no code fence:"
        ))
  );
  if (format === "json") {
    lines.push(
      "changed: files you touched (path + one-line summary). commands: the commands that verify the work.",
      "checks: each with ok true/false and the evidence in detail. open: what you could not finish, if anything.",
      "notes: one line, the headline a reviewer reads first."
    );
  }
  return lines.join("\n");
}

/**
 * The system prompt appended to every headless run, chosen by task class and
 * report format. `spotcheck`/`simple` get a short contract (no delegation
 * language, under 1200 chars in json format / 1500 in ag2); every other class (and no class) gets the
 * full contract. Both end with the AG2 report block unless `format` is
 * "json", the pre-AG2 fallback.
 */
export function workerContractPrompt(cls: string | undefined, format: "ag2" | "json"): string {
  return SHORT_CONTRACT_CLASSES.has(cls ?? "") ? shortContractPrompt(format) : fullContractPrompt(format);
}

/**
 * The line appended to a headless prompt's own text (never the system
 * prompt): models weight an instruction at the end of the user turn more
 * than one buried in a long system-prompt paragraph, and this is the
 * difference between a worker that returns a valid AG2/JSON report and one
 * that answers in prose despite the contract (measured 2026-09-20 on both
 * Haiku and Sonnet with the AG2 contract alone).
 */
export function promptTrailer(format: "ag2" | "json"): string {
  return format === "ag2"
    ? "\n\nFinal message: one AG2 R message only, no prose (format in system prompt)."
    : "\n\nFinal message: a JSON object only, no prose before or after, no code fence (format in system prompt).";
}

/** The exact text sent to resend a final message that failed AG2 validation. */
export const AG2_REASK_TEXT =
  "Your final message was not a valid AG2 R message. Resend it now as a single AG2 R message only: " +
  "first line R, then i=id r=result G=+ (gate, if r=+) t=tests(Name+) c=path summary p=proof z=the " +
  "answer/note. No prose.";

/** The full-contract AG2 prompt — the keepalive path's identical-construction baseline. */
export const WORKER_CONTRACT_PROMPT = fullContractPrompt("ag2");

export interface WorkerReport {
  changed?: Array<{ path?: string; summary?: string }>;
  commands?: string[];
  checks?: Array<{ name?: string; ok?: boolean; detail?: string }>;
  open?: string[];
  notes?: string;
  /** AG2 `r` (res): the single outcome character, when the report was AG2. */
  result?: "+" | "-" | "~" | "?" | "!";
  /** AG2 `y` (why): one line explaining a non-"+" result. */
  why?: string;
  /** Which wire format the final message was parsed as. */
  format?: "ag2" | "json";
}

/**
 * Extract the report from a worker's final message: AG2 first (an `R`
 * message, see agentish.ts), then the JSON contract as a fallback for
 * workers still on the pre-AG2 shape. Accepts a bare JSON object, a
 * ```json fenced block, or an object embedded in surrounding text — only
 * objects that look like the contract count (at least one of changed /
 * checks / notes) — any other JSON falls through to null so the raw text is
 * kept as-is.
 */
export function parseWorkerReport(text: string): WorkerReport | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  const ag2 = parseAg2Report(trimmed);
  if (ag2 && ag2.kind === "R") return ag2ToWorkerReport(ag2);

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
        return { ...(v as WorkerReport), format: "json" };
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

export interface ReportVerifyFailure {
  path: string;
  reason: "missing" | "not-deleted" | "stale";
}

export interface ReportVerifyResult {
  ok: boolean;
  failures: ReportVerifyFailure[];
}

/** A summary that names its own deletion — the path is expected to be gone. */
const DELETED_RE = /\b(delete|deleted|deleting|remove|removed|removing)\b/i;

/**
 * Check every path a report's `changed` list claims against the filesystem:
 * it must exist (mtime at or after `startMs`, the run's start) unless its
 * summary says it was deleted, in which case it must be absent. Mechanical
 * only — counts, row totals and other free-text claims are not checked (a
 * worker's R report is trusted as written; a 2026-09-23 report claimed "181
 * rows saved" while it had written 31, and only its listed paths are
 * something the filesystem can confirm or refute).
 */
export function verifyReportChanges(
  changed: Array<{ path?: string; summary?: string }> | undefined,
  cwd: string,
  startMs: number
): ReportVerifyResult {
  const failures: ReportVerifyFailure[] = [];
  for (const ch of changed ?? []) {
    const raw = (ch.path ?? "").trim();
    if (!raw) continue;
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let mtimeMs: number | null;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    const deleted = DELETED_RE.test(ch.summary ?? "");
    if (deleted) {
      if (mtimeMs !== null) failures.push({ path: raw, reason: "not-deleted" });
    } else if (mtimeMs === null) {
      failures.push({ path: raw, reason: "missing" });
    } else if (mtimeMs < startMs) {
      failures.push({ path: raw, reason: "stale" });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** The one-line note appended to a report/ledger when verify fails. */
export function verifyFailNote(v: ReportVerifyResult): string {
  const paths = v.failures.map((f) => f.path).slice(0, 5).join(", ");
  return `verify: ${v.failures.length} claimed change${v.failures.length === 1 ? "" : "s"} not confirmed: ${paths}`;
}

/** repo-relative display of a changed path when it lies under cwd. */
function relShort(p: string, cwd: string): string {
  if (!cwd) return p;
  const r = relative(cwd, p);
  return r && !r.startsWith("..") ? r : p;
}
