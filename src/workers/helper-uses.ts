/**
 * helper-uses.ts — the three first uses of the small local model (helper.ts).
 * Each sits behind `helper.uses.*` (default on) and returns null/undefined when
 * the model is off, down, busy or answers unusably: the caller's rule-based
 * path then stands unchanged.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperComplete, helperCompleteSync, helperConfig, helperRejected, type HelperDeps } from "./helper.js";
import { harnessEvidence, type ErrorClass, type ToolErrorGroup } from "./tool-errors.js";

const model0 = (deps: HelperDeps): string => (deps.config ?? helperConfig()).models[0] ?? "helper";

// ---- a: tool-error alert classification ----------------------------------------------------

export interface AlertVerdict {
  cls: Exclude<ErrorClass, "unknown">;
  reason: string;
}

export function parseAlertVerdict(text: string): AlertVerdict | null {
  const m = /^[\s<\[\"'*]*(harness|model|benign)\b[>\]\"'*]*\s*[:\-–—]?\s*(.*)$/im.exec(text.trim());
  if (!m) return null;
  const reason = m[2].replace(/\s+/g, " ").trim().slice(0, 160);
  return { cls: m[1].toLowerCase() as AlertVerdict["cls"], reason: reason || "no reason given" };
}

/** Classify an alert the rule table could not name; null = keep "unknown". */
export async function classifyAlert(g: Pick<ToolErrorGroup, "signature" | "sample" | "sampleInput">, deps: HelperDeps = {}): Promise<AlertVerdict | null> {
  if (!(deps.config ?? helperConfig()).uses.toolErrors) return null;
  const text = await helperComplete(
    {
      label: "alert",
      maxTokens: 60,
      keep: "head",
      task:
        "A tool call of an AI coding agent failed. Decide who is at fault: harness (the tooling, config, server or environment is broken), " +
        "model (the agent itself asked for something wrong — a bad path, a wrong edit, a broken one-off command, a compile error in its own files), " +
        "or benign (a normal answer such as no match or a failing test the agent is meant to see). " +
        'Reply on ONE line as "<harness|model|benign>: <reason in at most 12 words>".',
      input: `signature: ${g.signature}\nerror: ${g.sample}${g.sampleInput ? `\ninput: ${g.sampleInput}` : ""}`,
    },
    deps
  );
  if (text === null) return null;
  const v = parseAlertVerdict(text);
  if (!v) {
    helperRejected("alert", model0(deps), deps);
    return null;
  }
  // The helper may only refine an [unknown]; it may not invent a harness fault.
  // [harness] needs a matching marker — a message or stack frame from the pai
  // CLI, the guard, the router or the daemon (harnessEvidence) — else fall back
  // to null and the record stays unknown ("[unknown] → inspect").
  if (v.cls === "harness" && !harnessEvidence(`${g.signature}\n${g.sample}${g.sampleInput ? `\ninput: ${g.sampleInput}` : ""}`)) return null;
  return v;
}

// ---- b: cockpit TL;DR ------------------------------------------------------------------------

const pending = new Set<string>();
const retryAt = new Map<string, number>();
const TLDR_RETRY_MS = 10 * 60_000;
/** Chars of a spec a TL;DR is worth making from: the task body's first lines. */
const TLDR_INPUT_CHARS = 1200;

const tldrPath = (logDir: string, id: string): string => join(logDir, `${id}.tldr`);

/** The worker-rules block every PAI-spawned local spec starts with: boilerplate, never the task. */
const BOILERPLATE_RE = /^local worker rules:/i;

/**
 * Trim a spec to what a TL;DR needs: past the "Local worker rules" preamble (the
 * same block in every spec — it only burns the 8k window and slows the answer),
 * then at most TLDR_INPUT_CHARS. An input without the marker is kept whole up
 * to the cap. Pure, exported for tests.
 */
export function trimTldrInput(specText: string): string {
  const t = specText.trim();
  if (BOILERPLATE_RE.test(t)) {
    const i = t.indexOf("\n\n");
    const rest = i >= 0 ? t.slice(i + 2).trim() : "";
    if (rest) return rest.length > TLDR_INPUT_CHARS ? `${rest.slice(0, TLDR_INPUT_CHARS)}\n[...truncated...]` : rest;
  }
  return t.length > TLDR_INPUT_CHARS ? `${t.slice(0, TLDR_INPUT_CHARS)}\n[...truncated...]` : t;
}

export function cleanTldr(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  // complete sentences when there are any; otherwise the whole short answer — a one-liner
  // with no final period ("Adds the chip. It lands in the status file") is still usable
  const sentences = t.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  let out = sentences?.length ? sentences.slice(0, 2).map((x) => x.trim()).join(" ") : t;
  if (out.length < 15 && sentences?.length) {
    const rest = t.slice(sentences.reduce((n, s) => n + s.length, 0)).trim();
    if (rest) out += ` ${rest}`;
  }
  return out.length >= 15 ? out.slice(0, 400) : null;
}

/**
 * The cached TL;DR of a job, else null with a background generation started
 * (one at a time, per job once; a failure retries after 10 minutes). Never blocks.
 */
export function cachedTldr(logDir: string, id: string, specText: string, deps: HelperDeps = {}): string | null {
  const f = tldrPath(logDir, id);
  try {
    if (existsSync(f)) return readFileSync(f, "utf8").trim() || null;
  } catch {
    /* regenerate */
  }
  if (!specText.trim() || !(deps.config ?? helperConfig()).uses.tldr) return null;
  const now = (deps.now ?? Date.now)();
  if (pending.has(id) || (retryAt.get(id) ?? 0) > now) return null;
  pending.add(id);
  void (async () => {
    try {
      const input = trimTldrInput(specText);
      const task = "Summarize this task spec in exactly 2 plain sentences: what is to be built or fixed, and where. No lists, no markdown.";
      // the small engine answers empty now and then: one retry inside this call, before the
      // 10-minute cooldown; a model that failed outright is cooling down, so the retry skips it
      const raw =
        (await helperComplete({ label: "tldr", maxTokens: 64, keep: "head", timeoutMs: 8_000, task, input }, deps)) ??
        (await helperComplete({ label: "tldr", maxTokens: 64, keep: "head", timeoutMs: 12_000, task, input }, deps));
      const t = raw === null ? null : cleanTldr(raw);
      if (raw !== null && !t) helperRejected("tldr", model0(deps), deps);
      if (t) {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(f, t + "\n");
      } else retryAt.set(id, now + TLDR_RETRY_MS);
    } catch {
      retryAt.set(id, now + TLDR_RETRY_MS);
    } finally {
      pending.delete(id);
    }
  })();
  return null;
}

/** Test seam. */
export function resetTldrState(): void {
  pending.clear();
  retryAt.clear();
}

// ---- c: build/test failure summary -----------------------------------------------------------

export function cleanGateSummary(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*\d.)]+\s+)/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return lines.length ? lines.join("\n") : null;
}

/** 3 lines (which test, file:line, the error) from a failing run's log tail; null = rules only. Blocks at most the helper timeout. */
export function summarizeGateFailure(output: string, deps: HelperDeps = {}): string | null {
  if (!(deps.config ?? helperConfig()).uses.gateSummary) return null;
  const text = helperCompleteSync(
    {
      label: "gate",
      maxTokens: 120,
      keep: "tail",
      task: "This is the tail of a failing build or test run. Summarize the failing part in exactly 3 lines: (1) which test or step failed, (2) the file:line, (3) the error. Plain text, one fact per line.",
      input: output,
    },
    deps
  );
  if (text === null) return null;
  const s = cleanGateSummary(text);
  if (!s) helperRejected("gate", model0(deps), deps);
  return s;
}
