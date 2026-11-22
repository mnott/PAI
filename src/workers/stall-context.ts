/**
 * stall-context.ts — what is going on behind a worker whose turn count stopped
 * growing: Claude Code api_retry events in the worker's transcript, the local
 * runtime's live progress line, and recent router errors. Read-only, defensive:
 * anything unparsable is omitted.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StallContext {
  retry?: { attempt: number; max: number; error: string };
  /** Engine progress line; busy = younger than ENGINE_FRESH_MS and still working. */
  engine?: { text: string; busy: boolean };
  router?: string[];
}

export const ENGINE_FRESH_MS = 10_000;
/** An answer past this many tokens is flagged so a runaway is visible. */
export const LONG_ANSWER_TOKENS = 8_000;
const TAIL = 256 * 1024;

function tail(file: string, bytes = TAIL): string {
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8");
  } catch {
    return "";
  }
}

const n = (v: string): string => Number(v.replace(/,/g, "")).toLocaleString("en-US");

/** Last api_retry after the last assistant turn in a worker .jsonl tail. */
export function parseRetry(text: string): StallContext["retry"] | undefined {
  let found: StallContext["retry"] | undefined;
  for (const l of text.split("\n")) {
    if (l.includes('"api_retry"')) {
      try {
        const j = JSON.parse(l) as { attempt?: number; max_retries?: number; error?: string; error_status?: number | null };
        if (typeof j.attempt === "number") {
          const err = [j.error_status, j.error].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
          found = { attempt: j.attempt, max: j.max_retries ?? 0, error: err || "unknown" };
        }
      } catch {
        /* cut line */
      }
    } else if (l.includes('"type":"assistant"')) found = undefined;
  }
  return found;
}

/** Last Strata progress line as a short text; busy unless it is a "done" line. */
export function parseEngine(text: string): { text: string; busy: boolean } | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    let m = /\[strata\] reading the prompt: ([\d,]+) of ([\d,]+) tokens, (\d+) s/.exec(l);
    if (m) return { text: `reading prompt ${n(m[1])}/${n(m[2])} (${m[3]} s)`, busy: true };
    m = /\[strata\] thinking: ([\d,]+) of budget [\d,]+ tokens, ([\d.]+) tok\/s, (\d+) s/.exec(l);
    if (m) return { text: `thinking ${n(m[1])} tok at ${m[2]} tok/s (${m[3]} s)`, busy: true };
    m = /\[strata\] answering: ([\d,]+) of max ([\d,]+) tokens, ([\d.]+) tok\/s, (\d+) s/.exec(l);
    if (m) {
      const long = Number(m[1].replace(/,/g, "")) > LONG_ANSWER_TOKENS ? " — long answer" : "";
      return { text: `answering ${n(m[1])} of max ${n(m[2])} tok at ${m[3]} tok/s (${m[4]} s)${long}`, busy: true };
    }
    m = /\[strata\] writing a tool call: (.*?): ([\d,]+) of max ([\d,]+) tokens, ([\d.]+) tok\/s, (\d+) s/.exec(l);
    if (m) return { text: `writing a ${m[1]} call ${n(m[2])} of max ${n(m[3])} tok at ${m[4]} tok/s (${m[5]} s)`, busy: true };
    if (/\[strata\] done:/.test(l)) return { text: "idle (last request done)", busy: false };
  }
  return undefined;
}

/** Router log lines in the last minute for the model/provider that are errors. */
export function parseRouter(text: string, model: string, provider: string, now: number): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!(now - t >= 0 && now - t <= 60_000)) continue;
    if (m[2] !== model && m[3] !== provider) continue;
    const rest = m[4].trim();
    if (/^2\d\d\b/.test(rest)) continue;
    out.push(rest.replace(/\s+\d+ms$/, ""));
  }
  return [...new Set(out)].slice(-2);
}

export interface ContextTarget {
  id: string;
  provider: string;
  model: string;
}

export function gatherStallContext(t: ContextTarget, logDir: string, now: number, localDir = join(logDir, "..", "local"), routerLog = join(logDir, "..", "router.log")): StallContext {
  const ctx: StallContext = {};
  const retry = parseRetry(tail(join(logDir, `${t.id}.jsonl`)));
  if (retry) ctx.retry = retry;
  const log = join(localDir, `${t.provider}.log`);
  if (existsSync(log)) {
    const e = parseEngine(tail(log, 16 * 1024));
    let age = Infinity;
    try {
      age = now - statSync(log).mtimeMs;
    } catch {
      /* gone */
    }
    if (e && age <= ENGINE_FRESH_MS) ctx.engine = e;
  }
  const r = parseRouter(tail(routerLog, 64 * 1024), t.model, t.provider, now);
  if (r.length) ctx.router = r;
  return ctx;
}

export function describeContext(c: StallContext | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.retry) parts.push(`retrying (attempt ${c.retry.attempt} of ${c.retry.max}, error ${c.retry.error})`);
  if (c.engine) parts.push(`engine: ${c.engine.text}`);
  if (c.router) parts.push(`router: ${c.router.join("; ")}`);
  return parts.length ? ` — ${parts.join("; ")}` : "";
}
