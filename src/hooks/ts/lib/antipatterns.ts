/**
 * antipatterns.ts — loader for the anti-pattern directory.
 *
 * Shipped patterns (antipatterns/<category>/<id>.yaml in the package) are embedded at build time
 * (antipatterns.generated.ts, hooks are single bundled files); the user's own live in
 * PAI_HOME/antipatterns/<category>/<id>.yaml. The same id in the user dir overrides the shipped one,
 * a new id extends. Shell patterns (category `shell`) keep their own schema and are loaded by
 * rules/load.ts; every other category is read here.
 *
 * A bad file is skipped with one stderr line, never a crash. The user dir is re-read when a file's
 * mtime changes, so an edit takes effect without a restart.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { paiHomePath } from "../../../config/pai-home.js";
import { SHIPPED_ANTIPATTERNS } from "./antipatterns.generated.js";
import { parseLifecycle, type Lifecycle } from "./antipattern-lifecycle.js";

export const CATEGORIES = ["shell", "tool-loop", "final-text", "paths"] as const;
export type Category = (typeof CATEGORIES)[number];
export const ACTIONS = ["note", "deny", "continue", "stop"] as const;
export type Action = (typeof ACTIONS)[number];

export interface Antipattern extends Lifecycle {
  id: string;
  category: Category;
  detector: { kind: string; params: Record<string, unknown> };
  action: Action;
  message: string;
  tests: { match: string[]; no_match: string[] };
  provenance?: { date?: string; model?: string; observed?: string; ref?: string };
  /** Parameter changes made with `pai antipatterns set`, oldest first. */
  changes?: Record<string, unknown>[];
  /** `shipped` or the file the pattern came from. */
  source: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Per-kind parameter checks; a string is the problem found. */
const PARAM_CHECKS: Record<string, (p: Record<string, unknown>) => string | null> = {
  "identical-write": (p) => (num(p.note_at) && num(p.stop_at) && typeof p.stop_message === "string" ? null : "needs note_at, stop_at (numbers) and stop_message"),
  revert: (p) => (num(p.note_at) && num(p.stop_at) && num(p.seen_cap) && typeof p.stop_message === "string" ? null : "needs note_at, stop_at, seen_cap (numbers) and stop_message"),
  "distinct-rewrites": (p) => (num(p.same_file_writes) && num(p.distinct_versions) ? null : "needs same_file_writes and distinct_versions (numbers)"),
  "growing-command": (p) => (num(p.max_repeats) && num(p.stop_denials) && typeof p.note_message === "string" && typeof p.tool_message === "string" ? null : "needs max_repeats, stop_denials (numbers), note_message and tool_message"),
  "repeated-failure": (p) => (num(p.deny_at) && num(p.stop_at) ? null : "needs deny_at and stop_at (numbers)"),
  "unparsed-tool-call": (p) => {
    if (!num(p.tail_chars) || !num(p.json_window_lines) || !Array.isArray(p.regexes) || !p.regexes.length) return "needs tail_chars, json_window_lines and regexes";
    for (const r of p.regexes) {
      try {
        new RegExp(String(r));
      } catch {
        return `invalid regex ${String(r)}`;
      }
    }
    return null;
  },
  "missing-path": () => null,
  /** A recorded case with no live detector (a promoted candidate): fixtures only, nothing acts on it. */
  observed: () => null,
};

/** The pattern, or the reason it is not one. */
export function validateAntipattern(raw: unknown, dirCategory: string | null, source: string): Antipattern | string {
  if (!isObj(raw)) return "not a mapping";
  const { id, category, detector, action, message, tests, provenance } = raw;
  if (typeof id !== "string" || !ID.test(id)) return "id must be lowercase letters, digits and dashes";
  if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) return `unknown category ${String(category)}`;
  if (dirCategory !== null && dirCategory !== category) return `category ${category} does not match its directory ${dirCategory}`;
  if (category === "shell") return "shell patterns use the rule schema (rules/load.ts)";
  if (!isObj(detector) || typeof detector.kind !== "string") return "detector.kind missing";
  const params = detector.params === undefined ? {} : detector.params;
  if (!isObj(params)) return "detector.params must be a mapping";
  const check = PARAM_CHECKS[detector.kind];
  if (!check) return `unknown detector kind ${detector.kind}`;
  const bad = check(params);
  if (bad) return `detector ${detector.kind}: ${bad}`;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return `action must be one of ${ACTIONS.join(", ")}`;
  if (typeof message !== "string" || !message) return "message missing";
  const t = isObj(tests) ? tests : {};
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const lc = parseLifecycle(raw);
  if (typeof lc === "string") return lc;
  return {
    ...lc,
    id,
    category: category as Category,
    detector: { kind: detector.kind, params },
    action: action as Action,
    message,
    tests: { match: list(t.match), no_match: list(t.no_match) },
    provenance: isObj(provenance) ? (provenance as Antipattern["provenance"]) : undefined,
    changes: Array.isArray(raw.changes) ? raw.changes.filter(isObj) : undefined,
    source,
  };
}

function shippedMap(): Map<string, Antipattern> {
  const out = new Map<string, Antipattern>();
  for (const raw of SHIPPED_ANTIPATTERNS) {
    const source = String(raw.source ?? "shipped");
    const ap = validateAntipattern(raw, null, "shipped");
    if (typeof ap === "string") process.stderr.write(`pai: antipattern ${source} skipped: ${ap}\n`);
    else out.set(ap.id, ap);
  }
  return out;
}

const SHIPPED = shippedMap();

/** Directory of the user's own patterns. */
export function userAntipatternsDir(): string {
  return paiHomePath("antipatterns");
}

interface UserCache {
  dir: string;
  sig: string;
  patterns: Map<string, Antipattern>;
}
let userCache: UserCache | null = null;

/** Regular files under the user dir by category, with their mtimes; categories starting with `_` (candidates) are inactive. */
function userFiles(dir: string): { path: string; category: string; mtime: number }[] {
  const out: { path: string; category: string; mtime: number }[] = [];
  for (const category of CATEGORIES) {
    if (category === "shell") continue;
    let names: string[];
    try {
      names = readdirSync(join(dir, category)).filter((f) => f.endsWith(".yaml")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const path = join(dir, category, n);
      try {
        out.push({ path, category, mtime: statSync(path).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return out;
}

function userMap(): Map<string, Antipattern> {
  const dir = userAntipatternsDir();
  const files = userFiles(dir);
  const sig = files.map((f) => `${f.path}:${f.mtime}`).join("\n");
  if (userCache && userCache.dir === dir && userCache.sig === sig) return userCache.patterns;
  const patterns = new Map<string, Antipattern>();
  for (const f of files) {
    try {
      const ap = validateAntipattern(parse(readFileSync(f.path, "utf8")), f.category, f.path);
      if (typeof ap === "string") process.stderr.write(`pai: antipattern ${f.path} skipped: ${ap}\n`);
      else patterns.set(ap.id, ap);
    } catch (e) {
      process.stderr.write(`pai: antipattern ${f.path} skipped: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  userCache = { dir, sig, patterns };
  return patterns;
}

/** Every active non-shell pattern: shipped, with user patterns replacing the same id or adding new ones. */
export function loadAntipatterns(category?: Category): Antipattern[] {
  const all = new Map(SHIPPED);
  for (const [id, ap] of userMap()) all.set(id, ap);
  return [...all.values()].filter((a) => !category || a.category === category);
}

/** The active pattern with this id (user override first), or undefined. */
export function getAntipattern(id: string): Antipattern | undefined {
  return userMap().get(id) ?? SHIPPED.get(id);
}

/** The shipped pattern with this id, ignoring the user dir: for constants that must not move with local overrides. */
export function shippedAntipattern(id: string): Antipattern {
  const ap = SHIPPED.get(id);
  if (!ap) throw new Error(`shipped antipattern ${id} missing`);
  return ap;
}

/** The active pattern, or the shipped one when the id is unknown to the user dir (always defined for shipped ids). */
export function activeAntipattern(id: string): Antipattern {
  return getAntipattern(id) ?? shippedAntipattern(id);
}

/** Fill `{name}` placeholders; an unknown placeholder stays as written. */
export function fillMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}

/** Test hook: drop the user cache. */
export function resetAntipatternCache(): void {
  userCache = null;
}
