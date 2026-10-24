/**
 * agentish.ts — Agentish v2 (AG2), the wire format a worker's final report
 * uses by default: a kind line plus one-letter k=v lines instead of JSON
 * prose. Spec and validator live in the `aibroker` CLI
 * (see AIBroker: docs/agentish.md);
 * this module shells out to it when present and falls back to a frozen copy
 * of the spec text otherwise, so a worker still gets a contract when
 * `aibroker` is not installed on its box.
 */

import { execFileSync } from "node:child_process";
import type { WorkerReport } from "./report.js";

/** Frozen copy of `aibroker agentish spec`'s first line, for when the CLI is absent. */
export const AG2_SPEC_FALLBACK =
  "AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys i id g goal o own n forbid d steps p proof u out l limits r res c changes t tests G gate I inst m images # nums w worst x next z note(<200ch). sep |. outcomes + - ~ ? !. @n=path declared once then reused; @n:12=file:line. tests as Name+ Name-. no prose, no articles, never restate, unknown=?. r=+ only if all t +.";

/** Frozen copy of the `y` (why) extension line. */
export const AG2_EXTENSIONS_FALLBACK = "y why(≤600ch)";

interface Ag2SpecResult {
  spec: string;
  extensions: string;
  source: "aibroker" | "builtin";
}

let cachedSpec: Ag2SpecResult | null = null;

/**
 * The AG2 spec + extensions lines: from `aibroker agentish spec` when the
 * CLI runs and its output looks right, else the frozen fallback. Memoised —
 * every caller in one process gets the same spec without re-spawning aibroker.
 */
export function ag2Spec(): Ag2SpecResult {
  if (cachedSpec) return cachedSpec;
  try {
    const out = execFileSync("aibroker", ["agentish", "spec"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const lines = out.split("\n").filter((l) => l.trim());
    if (lines[0]?.startsWith("AG2.")) {
      cachedSpec = { spec: lines[0], extensions: lines[1] ?? AG2_EXTENSIONS_FALLBACK, source: "aibroker" };
      return cachedSpec;
    }
  } catch {
    // aibroker missing, not runnable, or timed out — fall through
  }
  cachedSpec = { spec: AG2_SPEC_FALLBACK, extensions: AG2_EXTENSIONS_FALLBACK, source: "builtin" };
  return cachedSpec;
}

/** Only for tests: drop the memoised spec so the next ag2Spec() re-probes. */
export function resetAg2SpecCache(): void {
  cachedSpec = null;
}

/**
 * Strip what workers wrap around a report: one surrounding ``` fence (opening
 * line may carry a language tag) and a leading `[YYYY-MM-DD HH:MM]` stamp line.
 */
export function unwrapAg2(text: string): string {
  let t = (text ?? "").trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  return t.replace(/^\[\d{4}-\d{2}-\d{2}[^\]\n]*\][ \t]*\n/, "").trim();
}

const AG2_KEYS = new Set([
  "i", "id", "g", "goal", "o", "own", "n", "forbid", "d", "steps", "p", "proof", "u", "out", "l", "limits",
  "r", "res", "c", "changes", "t", "tests", "G", "gate", "I", "inst", "m", "images", "#", "nums", "w", "worst",
  "x", "next", "z", "note", "y",
]);
const KV = /^(@\w+(?::\d+)?|[A-Za-z#]\w*)=/;

export interface NormalisedAg2 {
  /** Kind line followed by one entry per key; an entry is its k=v line plus continuation parts. */
  kindLine: string;
  entries: string[][];
  normalised: boolean;
}

/**
 * Fix the form slips workers make around an AG2 `R`: (1) `R:` / `R k=v | k=v`
 * with text on the kind line, (2) no kind line, first line starts with a known
 * key, (3) `- `/`* `/indented non-k=v lines, which continue the previous value.
 * Already-well-formed text comes back with normalised=false.
 */
export function normaliseAg2Entries(text: string): NormalisedAg2 | null {
  const raw = unwrapAg2(text)
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("```"));
  if (!raw.length) return null;
  let normalised = false;
  let kindLine = raw[0].trim();
  let rest = raw.slice(1);

  // lead = text to split into k=v parts when the kind line carries content
  let lead: string | null = null;
  const kindM = kindLine.match(/^R(?::\s*|\s+|\|\s*)(.+)$/);
  const keyM = kindLine.match(KV);
  if (kindM && KV.test(kindM[1])) {
    lead = kindM[1];
    kindLine = "R";
  } else if (!/^[TRSQAX]\b/.test(kindLine) && keyM && AG2_KEYS.has(keyM[1])) {
    lead = kindLine;
    kindLine = "R";
  } else if (/^R:\s*$/.test(kindLine)) {
    kindLine = "R";
    normalised = true;
  }
  if (lead !== null) {
    normalised = true;
    const parts: string[] = [];
    for (const p of lead.split(/\s+\|\s+/)) {
      if (parts.length && !KV.test(p.trim())) parts[parts.length - 1] += ` | ${p.trim()}`;
      else parts.push(p.trim());
    }
    rest = [...parts, ...rest];
  }

  const entries: string[][] = [];
  for (const line of rest) {
    const t = line.trim();
    const isCont = !KV.test(t) && (/^[-*]\s/.test(t) || /^\s/.test(line));
    if (isCont && entries.length) {
      entries[entries.length - 1].push(t.replace(/^[-*]\s+/, ""));
      normalised = true;
    } else {
      entries.push([t]);
    }
  }
  return { kindLine, entries, normalised };
}

/**
 * Text form of normaliseAg2Entries for the validator: continuation parts are
 * folded into their key's line with " | " (a validator reads one k=v per line).
 * Returns the input untouched when nothing needed normalising.
 */
export function normaliseAg2(text: string): { text: string; normalised: boolean } {
  const n = normaliseAg2Entries(text);
  if (!n || !n.normalised) return { text, normalised: false };
  return { text: [n.kindLine, ...n.entries.map((e) => e.join(" | "))].join("\n"), normalised: true };
}

export interface ParsedAg2 {
  kind: string;
  fields: Record<string, string>;
  symbols: Record<string, string>;
}

/**
 * Parse one AG2 message: first non-empty line is the kind (T R S Q A X,
 * optionally followed by trailing text — only the first character is the
 * kind), later lines are `key=value` or `@n=path` symbol declarations.
 * ```-fenced lines are ignored so a message pasted inside a code fence still
 * parses. Returns null when the first non-empty line is not a known kind.
 */
export function parseAg2Report(text: string): ParsedAg2 | null {
  const kinds = new Set(["T", "R", "S", "Q", "A", "X"]);
  const n = normaliseAg2Entries(text);
  if (!n) return null;
  const kind = n.kindLine[0];
  if (!kinds.has(kind)) return null;

  const fields: Record<string, string> = {};
  const symbols: Record<string, string> = {};
  for (const line of n.entries.map((e) => e.join("\n"))) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.startsWith("@")) {
      symbols[key.slice(1)] = value;
    } else {
      fields[key] = value;
    }
  }
  return { kind, fields, symbols };
}

/** true iff the value ends with the AG2 pass outcome character. */
function passed(entry: string): boolean {
  return entry.endsWith("+");
}

/**
 * Map a parsed AG2 report onto the runner's WorkerReport shape, so the
 * viewer and `printResult` can render an AG2 `R` exactly like a JSON one.
 */
export function ag2ToWorkerReport(parsed: ParsedAg2): WorkerReport {
  const f = parsed.fields;
  const out: WorkerReport = { format: "ag2" };

  // `c=none` is the contract's "no changes" spelling — it must parse to [] so
  // verifyReportChanges sees no claim and a read-only worker is never marked R?
  if (f.c && f.c.trim().toLowerCase() !== "none") {
    out.changed = f.c
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const colon = entry.indexOf(":");
        const space = entry.indexOf(" ");
        const cut = colon >= 0 && (space < 0 || colon < space) ? colon : space;
        if (cut < 0) return { path: entry, summary: "" };
        return { path: entry.slice(0, cut).trim(), summary: entry.slice(cut + 1).trim() };
      });
  }

  if (f.t) {
    const tokens = f.t.split(/\s+/).filter(Boolean);
    const isGrammar = tokens.length > 0 && tokens.every((tok) => /^\S+[+\-~?!]$/.test(tok));
    out.checks = isGrammar
      ? tokens.map((entry) => ({
          name: entry.slice(0, -1),
          ok: passed(entry),
          detail: entry.slice(-1),
        }))
      : [{ name: "tests", detail: f.t }];
  }

  if (f.p) out.commands = f.p.split("|").map((s) => s.trim()).filter(Boolean);

  const open: string[] = [];
  if (f.x) open.push(f.x);
  for (const [k, v] of Object.entries(f)) {
    if ((v.endsWith("!") || v.endsWith("?")) && k !== "r" && k !== "res") open.push(`${k}: ${v}`);
  }
  if (open.length) out.open = open;

  if (f.z) out.notes = f.z;
  const res = f.r ?? f.res;
  if (res === "+" || res === "-" || res === "~" || res === "?" || res === "!") out.result = res;
  if (f.y) out.why = f.y;

  return out;
}

export interface Ag2ValidationResult {
  ok: boolean;
  errors: string[];
  validator: "aibroker" | "none";
}

interface AibrokerCheckJson {
  ok?: boolean;
  errors?: Array<{ code?: string; message?: string; line?: number }>;
}

/**
 * Validate an AG2 message with `aibroker agentish check - --json`. Never
 * fails the caller: a missing/broken CLI reports ok:true, validator "none" —
 * a worker's run is never blocked on a local tooling gap, only its
 * `reportValid` marker goes unset.
 */
export function validateAg2(text: string): Ag2ValidationResult {
  try {
    const out = execFileSync("aibroker", ["agentish", "check", "-", "--json"], {
      input: unwrapAg2(text),
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(out) as AibrokerCheckJson;
    const errors = (parsed.errors ?? []).map((e) => e.message ?? e.code ?? "unknown error");
    return { ok: parsed.ok !== false, errors, validator: "aibroker" };
  } catch (e) {
    // execFileSync throws on non-zero exit too — stdout still carries the JSON
    const out = (e as { stdout?: Buffer | string }).stdout;
    if (out) {
      try {
        const parsed = JSON.parse(out.toString()) as AibrokerCheckJson;
        const errors = (parsed.errors ?? []).map((er) => er.message ?? er.code ?? "unknown error");
        return { ok: parsed.ok !== false, errors, validator: "aibroker" };
      } catch {
        // fall through to "no validator" below
      }
    }
    return { ok: true, errors: [], validator: "none" };
  }
}

export interface Ag2Repair {
  text: string;
  /** Short names of the repairs applied, e.g. "c pairs", "note->z". */
  repairs: string[];
}

const looksLikePath = (s: string): boolean => !/\s/.test(s) && (s.includes("/") || /\.\w+$/.test(s));

/**
 * Deterministic repair of the mechanical AG2 slips local models make, run
 * before validation. Fixes only: (1) `c=` as alternating path|summary|path|summary,
 * (2) a long-alias note key (`note`/`notes`) appended to `z` with "; ", (3) test
 * entries with spaces before the outcome char ("name 33+" -> "name-33+").
 * Anything else is left for the validator and the re-ask.
 */
export function repairAg2(text: string): Ag2Repair {
  const repairs: string[] = [];
  const src = unwrapAg2(text);
  if (!/^R\b/.test(src)) return { text, repairs };
  const lines = src.split("\n");
  const keyOf = (l: string): string => {
    const eq = l.indexOf("=");
    return eq < 0 ? "" : l.slice(0, eq).trim();
  };
  const val = (l: string): string => l.slice(l.indexOf("=") + 1).trim();

  // (2) note -> z
  const noteIdx = lines.map((l, i) => (i > 0 && (keyOf(l) === "note" || keyOf(l) === "notes") ? i : -1)).filter((i) => i > 0);
  if (noteIdx.length) {
    const zIdx = lines.findIndex((l, i) => i > 0 && keyOf(l) === "z");
    const noteText = noteIdx.map((i) => val(lines[i])).filter(Boolean).join("; ");
    if (zIdx >= 0) lines[zIdx] = `z=${[val(lines[zIdx]), noteText].filter(Boolean).join("; ")}`;
    else lines[noteIdx[0]] = `z=${noteText}`;
    repairs.push("note->z");
    for (const i of noteIdx.slice(zIdx >= 0 ? 0 : 1).reverse()) lines.splice(i, 1);
  }

  for (let i = 1; i < lines.length; i++) {
    const k = keyOf(lines[i]);
    if (k === "c") {
      const v = val(lines[i]);
      const parts = v.split("|").map((s) => s.trim());
      if (parts.length >= 2 && parts.length % 2 === 0 && parts.every((p, j) => (j % 2 === 0 ? looksLikePath(p) : !looksLikePath(p) && p))) {
        const pairs: string[] = [];
        for (let j = 0; j < parts.length; j += 2) pairs.push(`${parts[j]} ${parts[j + 1]}`);
        lines[i] = `c=${pairs.join("|")}`;
        repairs.push("c pairs");
      }
    } else if (k === "t") {
      const entries = val(lines[i]).split("|").map((s) => s.trim());
      const isGrammar = (e: string): boolean => e.split(/\s+/).every((tok) => /^\S+[+\-~?!]$/.test(tok));
      const fixed = entries.map((e) => (isGrammar(e) ? e : e.replace(/\s+/g, "-")));
      if (fixed.some((e, j) => e !== entries[j])) {
        lines[i] = `t=${fixed.join("|")}`;
        repairs.push("t names");
      }
    }
  }
  return repairs.length ? { text: lines.join("\n"), repairs } : { text, repairs };
}

/**
 * Repair known shape slips, then validate. When the repaired text validates
 * (and something was repaired) the returned text carries "repaired: ..." in z;
 * otherwise the original text is returned untouched so the re-ask sees it as written.
 */
export function repairAndValidateAg2(
  text: string,
): { text: string; validation: Ag2ValidationResult; repairs: string[]; normalised?: boolean } {
  const original = validateAg2(text);
  if (original.ok) return { text, validation: original, repairs: [] };
  // form slips first (R: / one-line / bulleted continuation), then mechanical repairs
  const norm = normaliseAg2(text);
  let working = text;
  let normalisedOk: { text: string; validation: Ag2ValidationResult } | null = null;
  if (norm.normalised) {
    const nv = validateAg2(norm.text);
    if (nv.ok) normalisedOk = { text: norm.text, validation: nv };
    else working = norm.text;
  }
  if (normalisedOk) return { text: normalisedOk.text, validation: normalisedOk.validation, repairs: [], normalised: true };
  const fixed = repairAg2(working);
  if (!fixed.repairs.length) return { text, validation: original, repairs: [] };
  const v = validateAg2(fixed.text);
  if (!v.ok) return { text, validation: original, repairs: [] };
  const note = `repaired: ${fixed.repairs.join(", ")}`;
  const lines = fixed.text.split("\n");
  const zi = lines.findIndex((l, i) => i > 0 && l.startsWith("z="));
  if (zi >= 0) lines[zi] = `${lines[zi]}; ${note}`;
  else lines.push(`z=${note}`);
  const withNote = lines.join("\n");
  const v2 = validateAg2(withNote);
  const normalised = norm.normalised || undefined;
  return v2.ok
    ? { text: withNote, validation: v2, repairs: fixed.repairs, normalised }
    : { text: fixed.text, validation: v, repairs: fixed.repairs, normalised };
}
