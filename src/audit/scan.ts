/**
 * scan.ts — after-the-fact rule scan over a session or worker transcript.
 *
 * `pai audit scan` reads a Claude Code JSONL transcript line by line and
 * runs the rules module against it: single-step rules against every tool_use
 * (Bash command, Write/Edit file_path + content, WebFetch url) and, for a
 * rule that sets `results: true`, against tool results; sequence rules against the whole run — all steps within
 * `window_seconds` of each other, in step order when `order` is "strict".
 * Evidence is the matched content passed through maskSecrets, so a finding
 * can be shown without leaking the secret it caught.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { maskSecrets } from "../hooks/ts/lib/loop-guard.js";
import type { Rule, RuleSequenceStep } from "../hooks/ts/lib/rules/types.js";

export interface Finding {
  ruleId: string;
  severity: Rule["severity"];
  /** ISO timestamp of the line that completed the hit (null when the transcript carries none). */
  ts: string | null;
  tool: string;
  /** The matched content, masked, at most 300 chars. */
  evidence: string;
  /** 1-based line number in the transcript. */
  line: number;
}

const EVIDENCE_MAX = 300;

/** A line or tool result larger than this is skipped: rules are not run over megabytes of file reads. */
const MAX_TEXT_BYTES = 256 * 1024;

/** Regex source for a literal string (a captured filename inserted into a later step's pattern). */
function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The matched content, masked and capped, as it goes into a Finding. */
function evidence(text: string): string {
  return maskSecrets(text).slice(0, EVIDENCE_MAX);
}

interface ContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
  /** tool_use blocks carry `id`; tool_result blocks carry `tool_use_id`. */
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: { content?: string | ContentBlock[] };
}

/** What one line contributes to the scan: tool calls, tool results, line timestamp. */
interface ParsedLine {
  line: number;
  tsMs: number | null;
  /** Tool name → content the rules test for that call. */
  calls: Array<{ tool: string; content: string }>;
  /** Plain text of a tool_result block, with the name of the tool it belongs to. */
  results: Array<{ tool: string; text: string }>;
}

/** tool_use id → tool name, so a tool_result can be attributed to its tool. */
type ToolNames = Map<string, string>;

/** The text a tool_result carries: a string, or the text blocks of a content array. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => (typeof x === "object" && x !== null && "text" in x ? String((x as { text?: string }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** The content a single-step rule tests for one tool call. */
function callContent(name: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const i = input as Record<string, unknown>;
  const str = (k: string): string => (typeof i[k] === "string" ? (i[k] as string) : "");
  if (name === "Bash") return str("command");
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    const parts = [str("file_path")];
    for (const k of ["content", "new_string", "old_string"]) {
      const v = i[k];
      if (typeof v === "string") parts.push(v);
    }
    const edits = i.edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        if (typeof e === "object" && e !== null) {
          const eo = e as Record<string, unknown>;
          for (const k of ["new_string", "old_string"]) {
            if (typeof eo[k] === "string") parts.push(eo[k]);
          }
        }
      }
    }
    return parts.join("\n");
  }
  if (name === "WebFetch") return str("url");
  return null;
}

function parseLine(lineNo: number, obj: TranscriptLine, names: ToolNames): ParsedLine {
  const tsMs = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
  const out: ParsedLine = {
    line: lineNo,
    tsMs: Number.isNaN(tsMs) ? null : tsMs,
    calls: [],
    results: [],
  };
  const content = obj.message?.content;
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use" && b.name) {
      if (b.id) names.set(b.id, b.name);
      const c = callContent(b.name, b.input);
      if (c !== null) out.calls.push({ tool: b.name, content: c });
    } else if (b.type === "tool_result") {
      // a result belongs to the tool that produced it: a step pinned to
      // WebFetch|Read matches fetched content, not the bare result block
      out.results.push({ tool: b.tool_use_id ? names.get(b.tool_use_id) ?? "" : "", text: resultText(b.content) });
    }
  }
  return out;
}

/** Compiled regexes by source+flags, so a rule is compiled once per scan and not once per event. */
type RegexCache = Map<string, RegExp | null>;

function compiled(cache: RegexCache, source: string, flags: string | undefined): RegExp | null {
  const fl = (flags ?? "").replace(/[gy]/g, ""); // g/y would make .test stateful
  const key = `${fl}/${source}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let re: RegExp | null;
  try {
    re = new RegExp(source, fl);
  } catch {
    re = null; // loadRules validates; a hand-built bad pattern never matches
  }
  cache.set(key, re);
  return re;
}

function toolMatches(step: RuleSequenceStep | { tool?: string }, toolName: string): boolean {
  if (!step.tool) return true;
  try {
    return new RegExp(step.tool).test(toolName);
  } catch {
    return false;
  }
}

/** One candidate occurrence of a sequence step in the transcript. */
interface StepHit {
  tsMs: number;
  line: number;
  /** The step's match, so a later step can resolve a backreference to it. */
  match: RegExpMatchArray;
  /** The step index this hit is for. */
  step: number;
}

/** Candidate chains built so far: one list of chains per step index. */
type StepChains = StepHit[][][];

/**
 * A step's regex against a content. A step whose source backreferences an
 * earlier step's group (`\1`) is checked with that group's capture
 * substituted in — download-then-execute's filename — which a per-step regex
 * cannot see on its own.
 */
function stepMatch(step: RuleSequenceStep, text: string, prior: RegExpMatchArray[], cache: RegexCache): RegExpMatchArray | null {
  const refs = step.match.includes("\\1") ? prior.flatMap((p) => (p[1] ? [p[1]] : [])) : [];
  if (refs.length) {
    for (const v of refs) {
      // the capture is data from the transcript: literal in the pattern, and a
      // function replacement so `$&` in it is not interpreted
      const lit = escapeRegex(v);
      const re = compiled(cache, step.match.replace(/\\1/g, () => lit), step.flags);
      const m = re ? text.match(re) : null;
      if (m) return m;
    }
    return null;
  }
  const re = compiled(cache, step.match, step.flags);
  return re ? text.match(re) : null;
}

/**
 * A sequence hit: every step matched, all within `window_seconds` of the
 * first step, in step order when `order` is "strict". `chains` holds the
 * candidate chains built so far, one list per step index. A step extends
 * chains that already cover it: for strict, chains that stop at its
 * predecessor; for "any", chains that stop at any earlier step or start at
 * any later one (the transcript may carry the steps in any order, so a chain
 * grows in both directions until it covers every step).
 */
function sequenceAdvance(
  rule: Rule,
  chains: StepChains,
  toolName: string,
  text: string,
  tsMs: number,
  line: number,
  cache: RegexCache
): StepHit[] | null {
  const seq = rule.sequence;
  if (!seq) return null;
  const windowMs = seq.window_seconds * 1000;
  // a chain whose head is older than the window can never complete
  for (const list of chains) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (tsMs - list[i][0].tsMs > windowMs) list.splice(i, 1);
    }
  }
  const out: StepHit[] = [];
  seq.steps.forEach((step, idx) => {
    if (!toolMatches(step, toolName)) return;
    // candidate chains this step extends: the empty start plus the
    // predecessor's for strict; the empty start plus every chain that does
    // not already cover this step for "any" (so a chain can grow forward from
    // a later step or backward from an earlier one)
    const empty: StepHit[][] = [[]];
    const priorChains: StepHit[][] = seq.order === "strict"
      ? (idx === 0 ? empty : empty.concat(chains[idx - 1] ?? []))
      : empty.concat(chains.flatMap((list, k) => (k === idx ? [] : list)));
    for (const chain of priorChains) {
      const prior = chain.map((h) => h.match);
      const m = stepMatch(step, text, prior, cache);
      if (!m) continue;
      const first = chain[0];
      if (first && (tsMs < first.tsMs || tsMs - first.tsMs > windowMs)) continue;
      const hit: StepHit = { tsMs, line, match: m, step: idx };
      const full = [...chain, hit].sort((a, b) => a.step - b.step);
      if (full.length === seq.steps.length) {
        // a hit needs every step: strict chains run in step order; an "any"
        // chain covers every step index, in whatever order they appeared
        const ordered = seq.order === "strict"
          ? full.every((h, k) => h.step === k)
          : true;
        if (ordered) out.push(...full);
      } else {
        (chains[idx] ??= []).push(full);
      }
    }
  });
  return out.length ? out : null;
}

/**
 * Scan a transcript against rules; findings in transcript order. Single-step
 * rules are checked against every tool call and tool result; sequence rules
 * correlate across lines. Lines without a timestamp are skipped by sequence
 * rules (no window can be measured).
 */
export async function scanTranscript(path: string, rules: Rule[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const single = rules.filter((r) => !r.sequence && r.match && r.severity !== "off");
  const seqRules = rules.filter((r) => r.sequence);
  // per sequence rule: candidate chains, one list per step index
  const chains = new Map<string, StepChains>();
  for (const r of seqRules) chains.set(r.id, r.sequence!.steps.map(() => []));

  const cache: RegexCache = new Map();
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  const toolNames: ToolNames = new Map();
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    if (!raw.trim() || raw.length > MAX_TEXT_BYTES) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    const parsed = parseLine(lineNo, obj, toolNames);
    const events = [
      ...parsed.calls.map((c) => ({ tool: c.tool, text: c.content, result: false })),
      ...parsed.results.filter((r) => r.text.length <= MAX_TEXT_BYTES).map((r) => ({ tool: r.tool, text: r.text, result: true })),
    ];
    for (const ev of events) {
      for (const rule of single) {
        // a single-step rule tests tool calls; a result only when the rule opts in
        if (ev.result && !rule.results) continue;
        if (!toolMatches(rule, ev.tool)) continue;
        try {
          const re = compiled(cache, rule.match!, rule.flags);
          if (re?.test(ev.text)) {
            findings.push({ ruleId: rule.id, severity: rule.severity, ts: obj.timestamp ?? null, tool: ev.tool, evidence: evidence(ev.text), line: lineNo });
          }
        } catch {
          // one bad rule skips only itself
        }
      }
      if (parsed.tsMs !== null) {
        for (const rule of seqRules) {
          try {
            const c = chains.get(rule.id)!;
            const done = sequenceAdvance(rule, c, ev.tool, ev.text, parsed.tsMs, lineNo, cache);
            if (done) {
              findings.push({ ruleId: rule.id, severity: rule.severity, ts: obj.timestamp ?? null, tool: ev.tool, evidence: evidence(ev.text), line: lineNo });
              for (const list of c) list.length = 0;
            }
          } catch {
            // one bad rule skips only itself
          }
        }
      }
    }
  }
  return findings;
}
