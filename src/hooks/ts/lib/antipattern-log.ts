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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import { paiHomePath } from "../../../config/pai-home.js";
import { modelOf } from "./antipattern-lifecycle.js";
import { getActiveTenant } from "./antipatterns.js";
import { ruleVersionOf } from "../../../tenants/rules.js";

export const ROTATE_BYTES = 10 * 1024 * 1024;
export const EXCERPT_CHARS = 120;
export const OUTCOMES = ["run-continued", "run-stopped", "run-succeeded", "run-failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const DISPOSITIONS = ["tp", "fp", "benign_tp", "undetermined"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** Where the decision ran: a Claude Code hook / worker runner, the model-API proxy, the MCP server or the UHP server. */
export type AuditSource = "hook" | "proxy" | "mcp" | "uhp";

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
  /** Where the decision ran: a Claude Code hook / worker runner (default, absent in old lines) or the model-API proxy. */
  source?: AuditSource;
  /** Audit identity (every line of a tenant's export carries these): the tenant whose rule set decided, the rule id and its content hash, who asked (token id, run id or session id; never a secret). */
  tenant?: string;
  ruleId?: string;
  ruleVersion?: string;
  principal?: string;
}

export interface OutcomeLine {
  ts: string;
  firingTs: string;
  id: string;
  workerId: string;
  outcome: Outcome;
  /** How the run ended after the firing, whatever the firing's own outcome says. */
  final: "succeeded" | "failed" | "stopped";
  tenant?: string;
  ruleId?: string;
  ruleVersion?: string;
  principal?: string;
}

export interface LabelLine {
  ts: string;
  firingTs: string;
  id: string;
  disposition: Disposition;
}

let ambientPrincipal: string | undefined;
/** The principal evaluate() is deciding for (set per decision; read by the firing sink). */
export function setAuditPrincipal(p: string | undefined): void {
  ambientPrincipal = p;
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

/** The `model` of a worker's status file under PAI_HOME/logs/workers, or undefined when absent or unreadable. */
export function workerStatusModel(workerId: string): string | undefined {
  try {
    const m = (JSON.parse(readFileSync(paiHomePath("logs", "workers", `${workerId}.status`), "utf8")) as { model?: unknown }).model;
    return typeof m === "string" && m ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Model of a firing: the env model, else the worker's status file model, else `session`. */
export function firingModel(env: NodeJS.ProcessEnv): string {
  const m = modelOf(env);
  return m !== "session" || !env.PAI_WORKER_ID ? m : (workerStatusModel(env.PAI_WORKER_ID) ?? m);
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
  source?: AuditSource;
  /** Tenant and principal of the decision; absent: the active tenant and the ambient principal. */
  tenant?: string;
  principal?: string;
  /** Model and provider the caller knows (proxy firings); absent: taken from the environment. */
  model?: string;
  provider?: string;
}

/** Record one firing. Returns its ts (the key outcomes and labels refer to), or null when writing failed. Never throws. */
export function recordFiring(f: FiringInput): string | null {
  try {
    const env = f.env ?? process.env;
    const ts = uniqueTs();
    const tenant = f.tenant ?? getActiveTenant();
    const line: Firing = {
      ts,
      id: f.id,
      version: f.version ?? 1,
      category: f.category,
      action: f.action,
      mode: f.mode,
      provider: f.provider || env.PAI_WORKER_PROVIDER || "session",
      model: f.model || firingModel(env),
      ...(env.PAI_WORKER_ID ? { workerId: env.PAI_WORKER_ID } : {}),
      ...(f.sessionId ? { sessionId: f.sessionId } : {}),
      project: basename(f.cwd ?? process.cwd()),
      source: f.source ?? "hook",
      tenant,
      ruleId: f.id,
      ruleVersion: ruleVersionOf(f.id, tenant, f.cwd),
      ...((f.principal ?? ambientPrincipal ?? f.sessionId ?? env.PAI_WORKER_ID) ? { principal: f.principal ?? ambientPrincipal ?? (f.sessionId ? `session:${f.sessionId}` : `run:${env.PAI_WORKER_ID}`) } : {}),
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

/** Firings with the stored model `session` of a known worker resolved to that worker's model (read time only; the log is append-only). */
export function readFiringsResolved(): Firing[] {
  const cache = new Map<string, string | undefined>();
  return readFirings().map((f) => {
    if (f.model !== "session" || !f.workerId) return f;
    if (!cache.has(f.workerId)) cache.set(f.workerId, workerStatusModel(f.workerId));
    const m = cache.get(f.workerId);
    return m ? { ...f, model: m } : f;
  });
}
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
      out.push({ ts: new Date().toISOString(), firingTs: f.ts, id: f.id, workerId, outcome, final: end, ...(f.tenant ? { tenant: f.tenant, ruleId: f.ruleId ?? f.id, ruleVersion: f.ruleVersion, principal: f.principal } : {}) });
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
  /** How the candidate was observed; default: a guard stop no pattern covers. */
  observed?: string;
  /** Worker ids behind the observation (default: this process's PAI_WORKER_ID). */
  workers?: string[];
}

/** Stored examples per signature; further repeats only raise the counter. */
export const CANDIDATE_MAX_EXAMPLES = 5;
const CANDIDATE_MAX_WORKERS = 100;
const SIG_BODY_CHARS = 56;
/** Shell words that say nothing about which loop it is. */
const SKELETON_NOISE = new Set(["echo", "date", "sh", "bash", "tail", "head", "tee", "grep", "cat", "true", "false", "rc", "exit", "sleep", "set", "then", "do", "done", "if", "fi"]);

/** Text with ids, quoted strings, paths and numbers replaced by placeholders: the same incident on another day reads the same. */
export function normalizeCandidateText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\b\d{8}-\d{6}-\d+\b/g, "<ID>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<ID>")
    .replace(/String: .*/s, "String: <S>")
    .replace(/(^|[\s(=:])(["'`])(?:(?!\2).){0,200}?\2(?!\w)/g, "$1<S>")
    .replace(/(same command )(?:\S*\/)?(\S+)/, "$1$2")
    .replace(/\S*\/\S*/g, (m) => (m.startsWith("<") ? m : "<P>"))
    .replace(/\b\d+(?:\.\d+)*\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Command skeleton of a loop-guard fingerprint (a bag of tokens): long flags and command words, paths as basenames, noise dropped. */
function loopSkeleton(text: string): string {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^.*\//, "");
    if (!/^(--[a-z][\w-]*|[A-Za-z][\w.-]*)$/.test(w) || /^[A-Z_]+$/.test(w) || SKELETON_NOISE.has(w)) continue;
    out.add(w);
  }
  return [...out].sort().join(" ");
}

/**
 * The key of a candidate: category | tool | error class | command skeleton. Tool errors ("[head\n]Tool|text") key on the
 * normalised error text; the command head only matters when the text is a bare exit code. Guard stops key on the
 * normalised guard message plus the skeleton of the looped command. Computed from the 120-char excerpts, so a
 * stored literal candidate and a fresh one of the same incident agree.
 */
export function candidateSignature(category: string, input: string, message = ""): string {
  const ex = excerptOf(input);
  const m = /^(?:([^\n]*)\n)?([A-Za-z][\w-]*)\|([\s\S]*)$/.exec(ex);
  if (m) {
    // a truncated excerpt ends at a different place when the head line is longer: cut it where every variant still agrees and
    // drop the half-cut last word, so one error text keys the same however long its head
    let body = normalizeCandidateText(m[3]);
    if (ex.length >= EXCERPT_CHARS) body = body.slice(0, SIG_BODY_CHARS).replace(/\s*\S*$/, "");
    const generic = /^Exit code <N>$/.test(body);
    return `${category}|${m[2]}|${body}${generic ? `|${normalizeCandidateText(m[1] ?? "")}` : ""}`;
  }
  return `${category}|guard|${normalizeCandidateText(excerptOf(message)).slice(0, 60)}|${loopSkeleton(ex)}`;
}

const signatureShort = (sig: string): string => hashOf(sig).slice(0, 8);

interface CandidateDoc {
  [k: string]: any;
}

/** Add one occurrence to a signature candidate document. Returns false when nothing new was recorded (a worker already counted). */
function addOccurrence(doc: CandidateDoc, o: { date: string; worker?: string; model: string }, n = 1): boolean {
  const workers: string[] = Array.isArray(doc.workers) ? doc.workers : [];
  if (o.worker) {
    if (workers.includes(o.worker)) return false;
    if (workers.length < CANDIDATE_MAX_WORKERS) workers.push(o.worker);
  }
  doc.workers = workers;
  doc.count = Number(doc.count ?? 0) + n;
  doc.last_seen = o.date;
  const examples: unknown[] = Array.isArray(doc.examples) ? doc.examples : [];
  if (examples.length < CANDIDATE_MAX_EXAMPLES) examples.push({ date: o.date, ...(o.worker ? { worker: o.worker } : {}), model: o.model });
  doc.examples = examples;
  return true;
}

function findBySignature(dir: string, short: string): string | null {
  try {
    const n = readdirSync(dir).filter((f) => f.endsWith(`-${short}.yaml`)).sort()[0];
    return n ? join(dir, n) : null;
  } catch {
    return null;
  }
}

export interface CandidateWrite {
  path: string;
  /** A new file was created. */
  created: boolean;
  /** The file was created or its counter moved. */
  changed: boolean;
}

/**
 * A guard stopped something no pattern covers, or a model tool error repeated: write or update ONE inactive candidate
 * per signature (see candidateSignature). A repeat raises `count` and appends worker/date/model to `examples` (at most
 * CANDIDATE_MAX_EXAMPLES); a worker already listed counts once. Never throws.
 */
export function upsertCandidate(c: CandidateInput): CandidateWrite | null {
  try {
    const env = c.env ?? process.env;
    const sig = candidateSignature(c.category, c.input, c.message);
    const short = signatureShort(sig);
    const date = new Date().toISOString().slice(0, 10);
    const dir = candidatesDir();
    const model = modelOf(env);
    const workers = c.workers ?? (env.PAI_WORKER_ID ? [env.PAI_WORKER_ID] : [undefined]);
    const existing = findBySignature(dir, short);
    if (existing) {
      const doc = parse(readFileSync(existing, "utf8")) as CandidateDoc;
      let changed = false;
      for (const w of workers) changed = addOccurrence(doc, { date, worker: w, model }) || changed;
      if (changed) writeFileSync(existing, stringify(doc), { mode: 0o600 });
      return { path: existing, created: false, changed };
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${date}-${short}.yaml`);
    const doc: CandidateDoc = {
      id: `cand-${short}`,
      status: "experimental",
      mode: "monitor",
      version: 1,
      created: date,
      category: c.category,
      signature: sig,
      detector: { kind: "observed", params: {} },
      action: c.action,
      message: excerptOf(c.message) || "guard stop without a pattern",
      tests: { match: [excerptOf(c.input)], no_match: [] },
      provenance: { date, model, observed: c.observed ?? `${c.action} by a guard no pattern covers` },
    };
    for (const w of workers) addOccurrence(doc, { date, worker: w, model });
    writeFileSync(path, stringify(doc), { mode: 0o600 });
    return { path, created: true, changed: true };
  } catch {
    return null;
  }
}

/** Write or update the signature candidate; returns its path, or null. */
export function writeCandidate(c: CandidateInput): string | null {
  return upsertCandidate(c)?.path ?? null;
}

export interface MigrationResult {
  /** Candidate files read. */
  before: number;
  /** Signature candidates after the merge. */
  after: number;
  /** Old files removed (empty on a dry run). */
  removed: string[];
  written: string[];
}

/**
 * One-off: collapse literal candidates (one file per incident, keyed by a hash of the whole text) into signature
 * candidates. Each group keeps the oldest file's identity data; counts add up (distinct workers when the literal
 * candidates name them, else one per file); examples are capped. Files already carrying a `signature` are only re-keyed
 * when two share one. `dryRun` reports without touching the directory.
 */
export function migrateCandidates(dir: string = candidatesDir(), dryRun = false): MigrationResult {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    return { before: 0, after: 0, removed: [], written: [] };
  }
  const groups = new Map<string, { file: string; doc: CandidateDoc }[]>();
  for (const n of names) {
    try {
      const doc = parse(readFileSync(join(dir, n), "utf8")) as CandidateDoc;
      const sig = String(doc.signature ?? candidateSignature(String(doc.category), String(doc.tests?.match?.[0] ?? ""), String(doc.message ?? "")));
      groups.set(sig, [...(groups.get(sig) ?? []), { file: n, doc }]);
    } catch {
      /* unreadable candidate stays where it is */
    }
  }
  const res: MigrationResult = { before: names.length, after: groups.size, removed: [], written: [] };
  for (const [sig, items] of groups) {
    const short = signatureShort(sig);
    const base = items[0].doc;
    const merged: CandidateDoc = { ...base, id: `cand-${short}`, signature: sig, workers: [], examples: [], count: 0 };
    merged.created = items.map((i) => String(i.doc.created ?? "")).filter(Boolean).sort()[0] ?? base.created;
    for (const { doc } of items) {
      const date = String(doc.created ?? merged.created);
      const model = String(doc.provenance?.model ?? "session");
      if (Array.isArray(doc.workers) && typeof doc.count === "number") {
        // already a signature candidate: fold its counter and examples in
        for (const w of doc.workers) if (!merged.workers.includes(w) && merged.workers.length < CANDIDATE_MAX_WORKERS) merged.workers.push(w);
        merged.count += doc.count;
        for (const e of doc.examples ?? []) if (merged.examples.length < CANDIDATE_MAX_EXAMPLES) merged.examples.push(e);
        merged.last_seen = [merged.last_seen, doc.last_seen].filter(Boolean).sort().pop();
        continue;
      }
      const named = /across workers ([^—]+?) —/.exec(String(doc.provenance?.observed ?? ""))?.[1]?.split(/,\s*/).filter(Boolean) ?? [];
      if (named.length === 0) addOccurrence(merged, { date, model });
      for (const w of named) addOccurrence(merged, { date, worker: w, model });
    }
    const target = join(dir, `${merged.created}-${short}.yaml`);
    res.written.push(target);
    const same = items.length === 1 && join(dir, items[0].file) === target && items[0].doc.signature === sig;
    if (same || dryRun) continue;
    writeFileSync(target, stringify(merged), { mode: 0o600 });
    for (const { file } of items) {
      const p = join(dir, file);
      if (p !== target) {
        rmSync(p, { force: true });
        res.removed.push(p);
      }
    }
  }
  return res;
}
