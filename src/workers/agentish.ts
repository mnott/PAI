/**
 * agentish.ts — Agentish v2 (AG2), the wire format a worker's final report
 * uses by default: a kind line plus one-letter k=v lines instead of JSON
 * prose. Spec and validator live in the `aibroker` CLI
 * (see /Users/i052341/Daten/Cloud/Development/ai/AIBroker/docs/agentish.md);
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
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));
  if (!lines.length) return null;
  const kind = lines[0][0];
  if (!kinds.has(kind)) return null;

  const fields: Record<string, string> = {};
  const symbols: Record<string, string> = {};
  for (const line of lines.slice(1)) {
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

  if (f.c) {
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
    out.checks = f.t
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => ({
        name: entry.slice(0, -1),
        ok: passed(entry),
        detail: entry.slice(-1),
      }));
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
      input: text,
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
