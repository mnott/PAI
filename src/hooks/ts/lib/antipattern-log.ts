/**
 * antipattern-log.ts — firing telemetry and candidates for the anti-pattern directory.
 *
 * Every place that acts on a pattern appends one line to PAI_HOME/antipatterns/firings.jsonl (rotated at 10 MB):
 * when, which pattern and version, the action, enforce or monitor, provider and model, worker or session, the
 * project (basename of the cwd only), a sha1 of the matched input and its first 120 chars with home paths as `~`.
 * The input itself is never stored. At the end of a worker run one outcome line per firing goes to outcomes.jsonl;
 * dispositions set by an operator go to labels.jsonl. All three are append-only.
 *
 * Writing is synchronous, wrapped in try/catch and never throws: a hook must not slow down or fail for telemetry.
 * Uncovered stops (a guard denied something no pattern id covers) become inactive candidate files under
 * PAI_HOME/antipatterns/_candidates/ for review.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { paiHomePath } from "../../../config/pai-home.js";
import { modelOf } from "./antipattern-lifecycle.js";

export const ROTATE_BYTES = 10 * 1024 * 1024;
export const EXCERPT_CHARS = 120;
export const OUTCOMES = ["run-continued", "run-stopped", "run-succeeded", "run-failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const DISPOSITIONS = ["tp", "fp", "benign_tp", "undetermined"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface Firing {
  ts: string;
  id: string;
  version: number;
  category: string;
  action: "note" | "deny" | "continue" | "stop";
  mode: "enforce" | "monitor";
  provider: string;
  model: string;
  workerId?: string;
  sessionId?: string;
  project: string;
  inputHash: string;
  excerpt: string;
  disposition: Disposition;
}

export interface OutcomeLine {
  ts: string;
  firingTs: string;
  id: string;
  workerId: string;
  outcome: Outcome;
  /** How the run ended after the firing, whatever the firing's own outcome says. */
  final: "succeeded" | "failed" | "stopped";
}

export interface LabelLine {
  ts: string;
  firingTs: string;
  id: string;
  disposition: Disposition;
}

export const antipatternDir = (): string => paiHomePath("antipatterns");
export const firingsPath = (): string => join(antipatternDir(), "firings.jsonl");
export const outcomesPath = (): string => join(antipatternDir(), "outcomes.jsonl");
export const labelsPath = (): string => join(antipatternDir(), "labels.jsonl");
export const candidatesDir = (): string => join(antipatternDir(), "_candidates");

/** The first 120 chars of the text with the home directory and other users' home paths written as `~`. */
export function excerptOf(text: string): string {
  let t = text;
  const home = homedir();
  if (home && home !== "/") t = t.split(home).join("~");
  t = t.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~");
  return t.slice(0, EXCERPT_CHARS);
}

export const hashOf = (text: string): string => createHash("sha1").update(text).digest("hex");

/** Append one JSON line, rotating the file to `<file>.1` at ROTATE_BYTES. Never throws; false when the write failed. */
function appendLine(file: string, line: unknown): boolean {
  try {
    mkdirSync(antipatternDir(), { recursive: true });
    try {
      if (statSync(file).size >= ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false; // telemetry never fails the caller
  }
}

let lastMs = 0;
/** An ISO timestamp that never repeats within this process: it is the key outcomes and labels refer to. */
function uniqueTs(): string {
  lastMs = Math.max(Date.now(), lastMs + 1);
  return new Date(lastMs).toISOString();
}

export interface FiringInput {
  id: string;
  version?: number;
  category: string;
  action: Firing["action"];
  mode: Firing["mode"];
  /** The matched input (command, file path, final text); only its hash and excerpt are kept. */
  input: string;
  cwd?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  disposition?: Disposition;
}

/** Record one firing. Returns its ts (the key outcomes and labels refer to), or null when writing failed. Never throws. */
export function recordFiring(f: FiringInput): string | null {
  try {
    const env = f.env ?? process.env;
    const ts = uniqueTs();
    const line: Firing = {
      ts,
      id: f.id,
      version: f.version ?? 1,
      category: f.category,
      action: f.action,
      mode: f.mode,
      provider: env.PAI_WORKER_PROVIDER || "session",
      model: modelOf(env),
      ...(env.PAI_WORKER_ID ? { workerId: env.PAI_WORKER_ID } : {}),
      ...(f.sessionId ? { sessionId: f.sessionId } : {}),
      project: basename(f.cwd ?? process.cwd()),
      inputHash: hashOf(f.input),
      excerpt: excerptOf(f.input),
      // an operator who allowed what the guard would deny (PAI_ALLOW_* in the environment) marks the firing a false positive
      disposition: f.disposition ?? (Object.keys(env).some((k) => k.startsWith("PAI_ALLOW_") && env[k]) && f.action !== "note" ? "fp" : "undetermined"),
    };
    return appendLine(firingsPath(), line) ? ts : null;
  } catch {
    return null;
  }
}

/** Parsed JSONL lines of a file and its rotated predecessor, oldest first; bad lines are skipped. */
function readLines<T>(file: string): T[] {
  const out: T[] = [];
  for (const f of [`${file}.1`, file]) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        /* torn line */
      }
    }
  }
  return out;
}

export const readFirings = (): Firing[] => readLines<Firing>(firingsPath());
export const readOutcomes = (): OutcomeLine[] => readLines<OutcomeLine>(outcomesPath());
export const readLabels = (): LabelLine[] => readLines<LabelLine>(labelsPath());

/** Operator label for a firing. */
export function recordLabel(firingTs: string, id: string, disposition: Disposition): void {
  appendLine(labelsPath(), { ts: new Date().toISOString(), firingTs, id, disposition } satisfies LabelLine);
}

/**
 * Run end: one outcome line per firing of this worker. A `continue` firing is `run-continued`; the others take the run's
 * end (stopped by the loop guard, succeeded, failed). Returns the lines written. Never throws.
 */
export function recordRunOutcomes(workerId: string, end: "succeeded" | "failed" | "stopped"): OutcomeLine[] {
  try {
    const done = new Set(readOutcomes().filter((o) => o.workerId === workerId).map((o) => `${o.firingTs}\t${o.id}`));
    const out: OutcomeLine[] = [];
    for (const f of readFirings()) {
      if (f.workerId !== workerId || done.has(`${f.ts}\t${f.id}`)) continue;
      const outcome: Outcome = f.action === "continue" ? "run-continued" : end === "stopped" ? "run-stopped" : end === "succeeded" ? "run-succeeded" : "run-failed";
      out.push({ ts: new Date().toISOString(), firingTs: f.ts, id: f.id, workerId, outcome, final: end });
    }
    for (const o of out) appendLine(outcomesPath(), o);
    return out;
  } catch {
    return [];
  }
}

export interface CandidateInput {
  category: string;
  action: "deny" | "stop";
  /** What the guard said (its deny reason or stop text). */
  message: string;
  /** The observed input; only the excerpt is written. */
  input: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * A guard stopped something no pattern covers: write an inactive candidate (status experimental, mode monitor, the
 * excerpt as a tests.match fixture). The same category and input write one file only. Returns the path, or null.
 */
export function writeCandidate(c: CandidateInput): string | null {
  try {
    const env = c.env ?? process.env;
    const short = hashOf(`${c.category}\n${c.input}`).slice(0, 8);
    const date = new Date().toISOString().slice(0, 10);
    const dir = candidatesDir();
    const path = join(dir, `${date}-${short}.yaml`);
    if (existsSync(path)) return path;
    mkdirSync(dir, { recursive: true });
    const excerpt = excerptOf(c.input);
    const doc = {
      id: `cand-${short}`,
      status: "experimental",
      mode: "monitor",
      version: 1,
      created: date,
      category: c.category,
      detector: { kind: "observed", params: {} },
      action: c.action,
      message: excerptOf(c.message) || "guard stop without a pattern",
      tests: { match: [excerpt], no_match: [] },
      provenance: { date, model: modelOf(env), observed: `${c.action} by a guard no pattern covers` },
    };
    writeFileSync(path, stringify(doc), { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
