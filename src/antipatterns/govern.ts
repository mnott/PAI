/**
 * govern.ts — governance of the anti-pattern directory: list, stats, candidates, promote, enforce/monitor, retire,
 * label, conflicts. Shared by `pai antipatterns` and the antipatterns_* MCP tools.
 *
 * Shipped files are never changed: every change is a user override file (same id, in the user directory) that wins
 * over the shipped one. Firings, outcomes and labels come from the append-only logs written by the hooks
 * (hooks/ts/lib/antipattern-log.ts).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { SHIPPED_ANTIPATTERNS } from "../hooks/ts/lib/antipatterns.generated.js";
import { BUILTIN_RULES } from "../hooks/ts/lib/rules/builtin.generated.js";
import { commitHomeChange } from "../config/home-git.js";
import { paiHomePath } from "../config/pai-home.js";
import { CATEGORIES, loadAntipatterns, resetAntipatternCache, userAntipatternsDir, validateAntipattern, type Antipattern } from "../hooks/ts/lib/antipatterns.js";
import { lifecycleDoc, type Lifecycle, type Mode, type Status } from "../hooks/ts/lib/antipattern-lifecycle.js";
import { candidatesDir, labelsPath, readFirings, readFiringsResolved, readLabels, readOutcomes, recordLabel, DISPOSITIONS, type Disposition, type Firing } from "../hooks/ts/lib/antipattern-log.js";
import { evaluateRules } from "../hooks/ts/lib/rules/eval.js";
import { allRuleDirs, listRules, projectRuleDirs, ruleLifecycle, userAntipatternShellDir } from "../hooks/ts/lib/rules/load.js";
import type { LoadedRule } from "../hooks/ts/lib/rules/types.js";

const DAY = 86_400_000;
const today = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

/** One pattern, shell or not, with its lifecycle. */
export interface Entry extends Lifecycle {
  id: string;
  category: string;
  /** Shell rules: the severity; others: the action. */
  action: string;
  source: string;
  kind: "shell" | "pattern";
  fixtures: { match: string[]; no_match: string[] };
}

const fixtureStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Every pattern in effect, retired ones included: the shell rules and every other category. */
export function allEntries(cwd = process.cwd()): Entry[] {
  const out: Entry[] = [];
  const { rules } = listRules(allRuleDirs(cwd), { projectDirs: projectRuleDirs(cwd) });
  for (const r of rules) {
    if (r.severity === "off" && !r.reason) continue;
    out.push({
      ...ruleLifecycle(r),
      id: r.id,
      category: "shell",
      action: r.severity,
      source: r.source,
      kind: "shell",
      fixtures: { match: fixtureStrings(r.tests?.match), no_match: fixtureStrings(r.tests?.no_match) },
    });
  }
  for (const a of loadAntipatterns()) {
    out.push({ ...a, action: a.action, kind: "pattern", fixtures: a.tests });
  }
  return out;
}

export function listPatterns(o: { category?: string; status?: string; cwd?: string } = {}): Entry[] {
  return allEntries(o.cwd).filter((e) => (!o.category || e.category === o.category) && (!o.status || e.status === o.status));
}

/** `7d`, `12h`, `2w` as milliseconds. */
export function parseSince(s: string): number {
  const m = /^(\d+)([hdw])$/.exec(s.trim());
  if (!m) throw new Error(`bad --since ${s}: use e.g. 12h, 7d, 2w`);
  return Number(m[1]) * { h: 3_600_000, d: DAY, w: 7 * DAY }[m[2] as "h" | "d" | "w"];
}

export interface PatternStats {
  id: string;
  category: string;
  status: string;
  mode: string;
  count: number;
  lastFired: string | null;
  byModel: Record<string, number>;
  /** Firings per origin: hook (Claude Code hooks, worker runner) or proxy (model-API path). */
  bySource: Record<string, number>;
  actions: Record<string, number>;
  outcomes: Record<string, number>;
  dispositions: Record<string, number>;
  /** fp / (tp + fp) over labelled firings; null without any. */
  fpRate: number | null;
  /** Share of deny and stop firings an operator overrode (disposition fp). */
  overrideRate: number | null;
  falsePositiveSuspect: boolean;
  flags: string[];
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

/** The latest label per firing wins over the firing's own disposition. */
function effectiveDisposition(f: Firing, labels: Map<string, Disposition>): Disposition {
  return labels.get(`${f.ts}\t${f.id}`) ?? f.disposition ?? "undetermined";
}

export function stats(o: { sinceMs?: number; model?: string; source?: "hook" | "proxy"; now?: number; cwd?: string } = {}): PatternStats[] {
  const now = o.now ?? Date.now();
  const firings = readFiringsResolved();
  const outcomes = new Map<string, string>();
  for (const x of readOutcomes()) outcomes.set(`${x.firingTs}\t${x.id}`, x.final);
  const outcomeKind = new Map<string, string>();
  for (const x of readOutcomes()) outcomeKind.set(`${x.firingTs}\t${x.id}`, x.outcome);
  const labels = new Map<string, Disposition>();
  for (const l of readLabels()) labels.set(`${l.firingTs}\t${l.id}`, l.disposition);

  const entries = new Map(allEntries(o.cwd).map((e) => [e.id, e]));
  const ids = new Set([...entries.keys(), ...firings.map((f) => f.id)]);
  const rows: PatternStats[] = [];
  for (const id of ids) {
    const e = entries.get(id);
    const all = firings.filter((f) => f.id === id);
    const win = all.filter((f) => (o.sinceMs === undefined || Date.parse(f.ts) >= now - o.sinceMs) && (!o.model || f.model === o.model) && (!o.source || (f.source ?? "hook") === o.source));
    if (!win.length && (o.model || !e)) continue;
    const row: PatternStats = {
      id,
      category: e?.category ?? all[0]?.category ?? "?",
      status: e?.status ?? "unknown",
      mode: e?.mode ?? "?",
      count: win.length,
      lastFired: all.length ? all.map((f) => f.ts).sort().at(-1)! : null,
      byModel: {},
      bySource: {},
      actions: {},
      outcomes: {},
      dispositions: {},
      fpRate: null,
      overrideRate: null,
      falsePositiveSuspect: false,
      flags: [],
    };
    let strong = 0;
    let overridden = 0;
    for (const f of win) {
      bump(row.byModel, f.model);
      bump(row.bySource, f.source ?? "hook");
      bump(row.actions, f.action);
      const key = `${f.ts}\t${f.id}`;
      const kind = outcomeKind.get(key) ?? "none";
      bump(row.outcomes, kind);
      const d = effectiveDisposition(f, labels);
      bump(row.dispositions, d);
      const acted = f.mode === "enforce" && (f.action === "deny" || f.action === "stop");
      if (acted) strong++;
      if (acted && d === "fp") overridden++;
      const final = outcomes.get(key);
      // fired and the run went on to succeed anyway (an operator override or a needless block), or a monitor hit with no bad outcome
      // A deny of an invented path followed by a successful run is the rule working, and the firing log keeps no input to tell
      // whether the same path was later executed, so the deny-after-success signal is dropped for the paths category.
      const denyOk = acted && final === "succeeded" && d !== "tp" && row.category !== "paths";
      if (denyOk || (f.mode === "monitor" && final !== "failed" && final !== "stopped" && d !== "tp")) row.falsePositiveSuspect = true;
    }
    const tp = (row.dispositions.tp ?? 0) + (row.dispositions.benign_tp ?? 0);
    const fp = row.dispositions.fp ?? 0;
    if (tp + fp) row.fpRate = fp / (tp + fp);
    if (strong) row.overrideRate = overridden / strong;
    const top = Math.max(0, ...Object.values(row.byModel));
    if (row.count >= 5 && top / row.count > 0.9) row.flags.push("model-quirk");
    const last = row.lastFired ? Date.parse(row.lastFired) : 0;
    const created = e?.created ? Date.parse(e.created) : 0;
    const old = !created || created < now - 30 * DAY;
    if (e && e.status !== "deprecated" && now - last > 30 * DAY && old) row.flags.push("retire candidate (no firing in 30 days)");
    else if (row.fpRate !== null && tp + fp >= 10 && row.fpRate > 0.5) row.flags.push("retire candidate (false-positive rate over 50%)");
    rows.push(row);
  }
  return rows.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// candidates

export interface Candidate {
  id: string;
  file: string;
  category: string;
  created: string;
  action: string;
  excerpt: string;
}

export function candidates(): Candidate[] {
  let names: string[];
  try {
    names = readdirSync(candidatesDir()).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const n of names) {
    try {
      const d = parse(readFileSync(join(candidatesDir(), n), "utf8")) as Record<string, any>;
      out.push({ id: String(d.id), file: join(candidatesDir(), n), category: String(d.category), created: String(d.created ?? ""), action: String(d.action ?? ""), excerpt: String(d.tests?.match?.[0] ?? "") });
    } catch {
      /* unreadable candidate */
    }
  }
  return out;
}

/** Move a candidate into the user directory of its category: status test, mode monitor. Returns the new path. */
export function promote(id: string, now = Date.now()): string {
  const c = candidates().find((x) => x.id === id || x.file.endsWith(`${id}.yaml`));
  if (!c) throw new Error(`no candidate ${id} (see: pai antipatterns candidates)`);
  const doc = parse(readFileSync(c.file, "utf8")) as Record<string, unknown>;
  doc.status = "test";
  doc.mode = "monitor";
  doc.modified = today(now);
  const bad = validateAntipattern(doc, c.category, c.file);
  if (typeof bad === "string") throw new Error(`candidate ${id} is not a valid pattern: ${bad}`);
  if (existsSync(join(userAntipatternsDir(), c.category, `${c.id}.yaml`))) throw new Error(`${c.id} already exists in ${c.category}`);
  const target = join(userAntipatternsDir(), c.category, `${c.id}.yaml`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, stringify(doc));
  renameSync(c.file, `${c.file}.promoted`);
  resetAntipatternCache();
  recordGovernance({ action: "promote", id: c.id, category: c.category, path: target }, now);
  commitHomeChange([target, `${c.file}.promoted`, c.file, governancePath()], `antipatterns promote ${c.id}`);
  return target;
}

// ---------------------------------------------------------------------------
// governance log

export const governancePath = (): string => paiHomePath("antipatterns", "governance.jsonl");

/** One append-only line per governance action: who changed what, when. */
export function recordGovernance(entry: { action: string; id: string; [k: string]: unknown }, now = Date.now()): void {
  const path = governancePath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ts: new Date(now).toISOString(), ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// overrides

function entryDoc(e: Entry, cwd: string): { doc: Record<string, unknown>; path: string } {
  const lc = lifecycleDoc(e);
  if (e.kind === "pattern") {
    const a = loadAntipatterns().find((x) => x.id === e.id) as Antipattern;
    const doc: Record<string, unknown> = { id: a.id, ...lc, category: a.category, detector: a.detector, action: a.action, message: a.message, tests: a.tests, ...(a.provenance ? { provenance: a.provenance } : {}), ...(a.changes?.length ? { changes: a.changes } : {}) };
    const own = a.source !== "shipped" ? a.source : join(userAntipatternsDir(), a.category, `${a.id}.yaml`);
    return { doc, path: own };
  }
  const { rules } = listRules(allRuleDirs(cwd), { projectDirs: projectRuleDirs(cwd) });
  const r = rules.find((x: LoadedRule) => x.id === e.id) as LoadedRule;
  const doc: Record<string, unknown> = { id: r.id, ...lc, severity: r.severity };
  for (const k of ["tool", "category"] as const) if (r[k]) doc[k] = r[k];
  if (r.match) doc.match = r.match;
  if (r.flags) doc.flags = r.flags;
  for (const k of ["quoted", "text_ok", "results"] as const) if (r[k]) doc[k] = true;
  if (r.sequence) doc.sequence = r.sequence;
  doc.reason = r.reason;
  if (r.tests) doc.tests = r.tests;
  // a rule that already lives in the user shell directory is rewritten in place
  const inUserDir = r.source.startsWith(userAntipatternShellDir()) && r.source.endsWith(".yaml") && !r.source.endsWith(".rule.yaml");
  return { doc, path: inUserDir ? r.source : join(userAntipatternShellDir(), `${r.id}.yaml`) };
}

function override(action: string, id: string, change: { mode?: Mode; status?: Status; reason?: string }, o: { cwd?: string; now?: number } = {}): { path: string; entry: Entry } {
  const cwd = o.cwd ?? process.cwd();
  const e = allEntries(cwd).find((x) => x.id === id);
  if (!e) throw new Error(`unknown pattern ${id} (see: pai antipatterns list)`);
  const next: Entry = { ...e, ...change, version: e.version + 1, modified: today(o.now) };
  if (change.status === "deprecated") next.deprecated = today(o.now);
  const { doc, path } = entryDoc(next, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(doc));
  resetAntipatternCache();
  recordGovernance({ action, id, ...(change.mode ? { mode: change.mode } : {}), ...(change.reason ? { reason: change.reason } : {}) }, o.now);
  commitHomeChange([path, governancePath()], `antipatterns ${action} ${id}`);
  return { path, entry: next };
}

export const setMode = (id: string, mode: Mode, o: { cwd?: string; now?: number } = {}) => override(mode, id, { mode }, o);
export const retire = (id: string, reason?: string, o: { cwd?: string; now?: number } = {}) => override("retire", id, { status: "deprecated", ...(reason ? { reason } : {}) }, o);

/** Label one firing (by its ts) or every firing of a pattern (by id). Returns the number labelled. */
export function label(target: string, disposition: Disposition): number {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`disposition must be one of ${DISPOSITIONS.join(", ")}`);
  const hits = readFirings().filter((f) => f.ts === target || f.id === target);
  for (const f of hits) recordLabel(f.ts, f.id, disposition);
  if (!hits.length) throw new Error(`no firing with ts or id ${target}`);
  commitHomeChange([labelsPath()], `antipatterns label ${target} ${disposition}`);
  return hits.length;
}

/** `20` -> 20, `true` -> true, anything else stays a string; a non-string value passes through. */
function parseValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "true" || t === "false") return t === "true";
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  return v;
}

const kindOf = (v: unknown): string => (Array.isArray(v) ? "list" : typeof v);

/** Change one detector parameter of a non-shell pattern in the user override (a full copy on first use). */
export function setParam(id: string, param: string, value: unknown, reason: string, o: { now?: number } = {}): { path: string; from: unknown; to: unknown; version: number } {
  if (!reason || !reason.trim()) throw new Error("--reason is required");
  const a = loadAntipatterns().find((x) => x.id === id);
  if (!a) throw new Error(`unknown pattern ${id}: set works on detector patterns (see: pai antipatterns list; shell rules have no parameters)`);
  const params = a.detector.params;
  const valid = Object.keys(params);
  if (!(param in params)) throw new Error(`${id} has no param ${param}; valid params: ${valid.join(", ") || "(none)"}`);
  const from = params[param];
  const to = parseValue(value);
  if (kindOf(to) !== kindOf(from)) throw new Error(`param ${param} of ${id} is a ${kindOf(from)} (now ${JSON.stringify(from)}), not a ${kindOf(to)}`);
  const date = today(o.now);
  const { doc, path } = entryDoc(allEntries().find((x) => x.id === id && x.kind === "pattern") as Entry, process.cwd());
  const changes = [...(a.changes ?? []), { date, param, from, to, reason }];
  const next = { ...doc, version: a.version + 1, modified: date, detector: { ...a.detector, params: { ...params, [param]: to } }, changes };
  const bad = validateAntipattern(next, a.category, path);
  if (typeof bad === "string") throw new Error(`${param}=${JSON.stringify(to)} is not valid for ${id}: ${bad}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(next));
  resetAntipatternCache();
  recordGovernance({ action: "set", id, param, from, to, reason }, o.now);
  commitHomeChange([path, governancePath()], `antipatterns set ${id} ${param}=${JSON.stringify(to)}`);
  return { path, from, to, version: a.version + 1 };
}

// ---------------------------------------------------------------------------
// conflicts

export interface Conflict {
  kind: "duplicate-id" | "overlap";
  ids: string[];
  detail: string;
}

/** Does pattern `e` match this fixture text? Shell rules by their regex; others by an identical fixture. */
function matches(e: Entry, rules: Map<string, LoadedRule>, text: string): boolean {
  if (e.kind === "shell") {
    const r = rules.get(e.id);
    return !!r && !!evaluateRules([r], "Bash", text);
  }
  return e.fixtures.match.includes(text);
}

/** Duplicate ids within a layer, and active patterns whose fixtures the other matches with a different action. */
export function conflicts(cwd = process.cwd()): Conflict[] {
  const out: Conflict[] = [];
  const dup = (layer: string, ids: string[]): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push({ kind: "duplicate-id", ids: [id], detail: `${id} defined twice in ${layer}` });
      seen.add(id);
    }
  };
  dup("the shipped shell rules", BUILTIN_RULES.map((r) => r.id));
  dup("the shipped patterns", SHIPPED_ANTIPATTERNS.map((r) => String(r.id)));
  const shellIds = new Set(BUILTIN_RULES.map((r) => r.id));
  for (const r of SHIPPED_ANTIPATTERNS) if (shellIds.has(String(r.id))) out.push({ kind: "duplicate-id", ids: [String(r.id)], detail: `${String(r.id)} is both a shell rule and a ${String(r.category)} pattern` });
  // user files: the same id twice among the user's own files (an override of a shipped id is intended)
  const userIds: string[] = [];
  const userRoots = [userAntipatternShellDir(), ...CATEGORIES.filter((c) => c !== "shell").map((c) => join(userAntipatternsDir(), c))];
  for (const dir of userRoots) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const d = parse(readFileSync(join(dir, n), "utf8")) as { id?: unknown };
        if (typeof d?.id === "string") userIds.push(d.id);
      } catch {
        /* load errors are reported elsewhere */
      }
    }
  }
  dup("the user directory", userIds);

  const { rules } = listRules(allRuleDirs(cwd), { projectDirs: projectRuleDirs(cwd) });
  const ruleMap = new Map(rules.map((r) => [r.id, r]));
  const active = allEntries(cwd).filter((e) => e.status !== "deprecated");
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.action === b.action) continue;
      const aHitsB = b.fixtures.match.find((t) => matches(a, ruleMap, t));
      const bHitsA = a.fixtures.match.find((t) => matches(b, ruleMap, t));
      if (aHitsB !== undefined && bHitsA !== undefined) {
        out.push({ kind: "overlap", ids: [a.id, b.id], detail: `${a.id} (${a.action}) and ${b.id} (${b.action}) match each other's fixtures` });
      }
    }
  }
  return out;
}
