/**
 * tool-call-rules.ts — the versioned rules file behind the router's tool-call
 * repair (tool-args.ts), and the hot-reloading store that serves it.
 *
 * A rules file is YAML: `version`, optional `inherits` (another rules file:
 * "default" = the shipped one, else a path relative to this file), and
 * `rules`. Every regex is compiled and checked before a file is accepted; a
 * bad file never replaces a good set (RulesStore keeps the old one and logs
 * why). Policy lives in the file, never in code: the engine only knows the
 * rule kinds.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { shippedDefaultsDir } from "../config/shipped-defaults.js";

export const RULE_KINDS = ["opener", "junk_line", "closer", "name_cut", "bool_true", "bool_false"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleProbe {
  /** The user prompt that provokes the form. */
  prompt: string;
  /** The tool offered to the model: name + JSON schema. */
  tool?: { name: string; description?: string; input_schema: Record<string, unknown> };
}

export interface RuleDef {
  id: string;
  kind: RuleKind;
  /** JS regex source; compiled with the m flag. */
  pattern: string;
  added: string;
  /** Raw log id the form was first seen in. */
  sample?: string;
  note?: string;
  /** A broken tool_use input of `tool` and what it must be repaired to. */
  /** `input`: a parsed tool_use input; `text`: raw tool-call markup from answer text. */
  example?: { tool: string; input?: Record<string, unknown>; text?: string };
  expect?: Record<string, unknown>;
  probe?: RuleProbe;
  /** `text`: only used when parsing tool-call markup out of answer text. */
  scope?: "args" | "text";
  /** junk_line only: strip from number/boolean values, never from string values (file content). */
  typed_only?: boolean;
  disabled?: boolean;
  /** ISO date; after it the rule is inactive. */
  expires?: string;
  /** Set by `pai models rules probe`: the rule did not fire in the probe. */
  unconfirmed?: boolean;
}

export interface Rule extends RuleDef {
  re: RegExp;
  /** The file this rule came from. */
  file: string;
}

export interface RuleSet {
  version: number;
  rules: Rule[];
  /** Every file read (the file itself and its inherits), for change detection. */
  files: string[];
}

export class RulesError extends Error {}

/** The shipped rules file. */
export function shippedRulesPath(): string {
  return join(shippedDefaultsDir(), "tool-call-rules.default.yaml");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/** Validates one raw rule and compiles its regex. Throws RulesError naming the rule. */
export function compileRule(raw: unknown, file: string): Rule {
  if (!raw || typeof raw !== "object") throw new RulesError(`${file}: a rule is not a mapping`);
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) throw new RulesError(`${file}: a rule has no id`);
  const kind = r.kind as RuleKind;
  if (!RULE_KINDS.includes(kind)) throw new RulesError(`${file}: rule ${id}: kind must be one of ${RULE_KINDS.join(", ")}`);
  const pattern = str(r.pattern);
  if (!pattern) throw new RulesError(`${file}: rule ${id}: no pattern`);
  let re: RegExp;
  try {
    re = new RegExp(pattern.split("{params}").join("x"), "m");
  } catch (e) {
    throw new RulesError(`${file}: rule ${id}: bad regex: ${e instanceof Error ? e.message : String(e)}`);
  }
  // groups: opener and name_cut capture the parameter name in group 1
  const groups = new RegExp(`${pattern.split("{params}").join("x")}|`).exec("")?.length ?? 1;
  if ((kind === "opener" || kind === "name_cut") && groups < 2) throw new RulesError(`${file}: rule ${id}: ${kind} needs a capture group (the parameter name)`);
  // a pattern that matches the empty string would loop the engine
  if (kind !== "bool_true" && kind !== "bool_false" && re.test("")) throw new RulesError(`${file}: rule ${id}: pattern matches the empty string`);
  const scope = r.scope === "text" ? "text" : r.scope === undefined || r.scope === "args" ? "args" : undefined;
  if (!scope) throw new RulesError(`${file}: rule ${id}: scope must be args or text`);
  const ex = r.example as { tool?: unknown; input?: unknown; text?: unknown } | undefined;
  const exInput = !!ex && !!ex.input && typeof ex.input === "object";
  if (ex !== undefined && (typeof ex.tool !== "string" || (!exInput && typeof ex.text !== "string"))) throw new RulesError(`${file}: rule ${id}: example needs tool and input (or text)`);
  if (ex !== undefined && (!r.expect || typeof r.expect !== "object")) throw new RulesError(`${file}: rule ${id}: example without expect`);
  return {
    id,
    kind,
    pattern,
    added: r.added === undefined ? "" : String(r.added instanceof Date ? r.added.toISOString().slice(0, 10) : r.added),
    ...(str(r.sample) ? { sample: str(r.sample) } : {}),
    ...(str(r.note) ? { note: str(r.note) } : {}),
    ...(ex
      ? {
          example: { tool: ex.tool as string, ...(exInput ? { input: ex.input as Record<string, unknown> } : { text: ex.text as string }) },
          expect: r.expect as Record<string, unknown>,
        }
      : {}),
    ...(r.probe && typeof r.probe === "object" ? { probe: r.probe as RuleProbe } : {}),
    ...(scope === "text" ? { scope } : {}),
    ...(r.typed_only === true ? { typed_only: true } : {}),
    ...(r.disabled === true ? { disabled: true } : {}),
    ...(r.expires !== undefined ? { expires: String(r.expires instanceof Date ? r.expires.toISOString().slice(0, 10) : r.expires) } : {}),
    ...(r.unconfirmed === true ? { unconfirmed: true } : {}),
    re,
    file,
  };
}

function resolveInherit(from: string, name: string): string {
  if (name === "default") return shippedRulesPath();
  return isAbsolute(name) ? name : resolve(dirname(from), name);
}

/** Loads a rules file with its inherits (a child's rule replaces the parent's of the same id). */
export function loadRules(path: string, depth = 0, seen: string[] = []): RuleSet {
  if (depth > 5 || seen.includes(path)) throw new RulesError(`${path}: inherits chain too deep or circular`);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RulesError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new RulesError(`${path}: top level must be a mapping`);
  const d = doc as Record<string, unknown>;
  const version = typeof d.version === "number" ? d.version : NaN;
  if (!Number.isFinite(version)) throw new RulesError(`${path}: version must be a number`);
  const rules = new Map<string, Rule>();
  const files = [path];
  const parent = str(d.inherits);
  if (parent) {
    const ps = loadRules(resolveInherit(path, parent), depth + 1, [...seen, path]);
    for (const r of ps.rules) rules.set(r.id, r);
    files.push(...ps.files);
  }
  if (d.rules !== undefined && !Array.isArray(d.rules)) throw new RulesError(`${path}: rules must be a list`);
  const own = new Set<string>();
  for (const raw of (d.rules as unknown[] | undefined) ?? []) {
    const r = compileRule(raw, path);
    if (own.has(r.id)) throw new RulesError(`${path}: duplicate rule id ${r.id}`);
    own.add(r.id);
    rules.set(r.id, r);
  }
  return { version, rules: [...rules.values()], files };
}

/** Rules that apply now: not disabled, not expired. */
export function activeRules(set: RuleSet, now: Date = new Date()): Rule[] {
  return set.rules.filter((r) => !r.disabled && !(r.expires && new Date(r.expires).getTime() < now.getTime()));
}

// ---------------------------------------------------------------------------
// config: which file serves which provider/model

/** config.yaml router.toolCallRules. */
export interface ToolCallRulesConfig {
  /** Rules directory, relative to the PAI home (default "tool-call-rules"). */
  dir?: string;
  /** File for providers/models not mapped below (default: the shipped file). */
  file?: string;
  /** provider → file, or provider → { model | "*" → file }. */
  providers?: Record<string, string | Record<string, string>>;
}

/** The rules file path serving provider+model: provider.model, provider.*, file, else the shipped default. */
export function rulesPathFor(cfg: ToolCallRulesConfig | undefined, homeDir: string, provider: string, model: string): string {
  const dir = resolve(homeDir, cfg?.dir ?? "tool-call-rules");
  const pick = (f: string | undefined): string | undefined => (f ? (isAbsolute(f) ? f : join(dir, f)) : undefined);
  const p = cfg?.providers?.[provider];
  const mapped = typeof p === "string" ? p : p ? (p[model] ?? p["*"]) : undefined;
  const chosen = pick(mapped) ?? pick(cfg?.file);
  return chosen && existsSync(chosen) ? chosen : shippedRulesPath();
}

/** Marker file `pai models rules reload` touches so a running router re-reads at once. */
export function reloadMarker(cfg: ToolCallRulesConfig | undefined, homeDir: string): string {
  return join(resolve(homeDir, cfg?.dir ?? "tool-call-rules"), ".reload");
}

// ---------------------------------------------------------------------------
// hot reload

interface Entry {
  set: RuleSet;
  sig: string;
  checkedAt: number;
  badSig?: string;
}

export interface RulesStoreOptions {
  config: () => ToolCallRulesConfig | undefined;
  homeDir: () => string;
  now?: () => number;
  log?: (line: string) => void;
  /** Minimum ms between mtime checks (default 5000). */
  checkMs?: number;
}

/** Serves the rule set for a provider/model; re-reads a changed file (checked at most every checkMs). */
export class RulesStore {
  private readonly entries = new Map<string, Entry>();
  private readonly checkMs: number;
  private readonly now: () => number;

  constructor(private readonly o: RulesStoreOptions) {
    this.checkMs = o.checkMs ?? 5000;
    this.now = o.now ?? Date.now;
  }

  private signature(set: RuleSet | null, path: string): string {
    const marker = reloadMarker(this.o.config(), this.o.homeDir());
    const files = set ? set.files : [path];
    return [...files, marker].map((f) => { try { return `${f}:${statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join("|");
  }

  get(provider: string, model: string): RuleSet {
    const path = rulesPathFor(this.o.config(), this.o.homeDir(), provider, model);
    const e = this.entries.get(path);
    const t = this.now();
    if (e && t - e.checkedAt < this.checkMs) return e.set;
    const sig = this.signature(e?.set ?? null, path);
    if (e && e.sig === sig) {
      e.checkedAt = t;
      return e.set;
    }
    if (e && e.badSig === sig) {
      e.checkedAt = t;
      return e.set;
    }
    try {
      const set = loadRules(path);
      const fresh: Entry = { set, sig: this.signature(set, path), checkedAt: t };
      this.entries.set(path, fresh);
      if (e) this.o.log?.(`${new Date().toISOString()} tool-call rules reloaded: ${path} (${set.rules.length} rules)`);
      return set;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.o.log?.(`${new Date().toISOString()} tool-call rules NOT reloaded, keeping the previous set: ${why}`);
      if (e) {
        e.badSig = sig;
        e.checkedAt = t;
        return e.set;
      }
      // first load failed: the shipped file is the floor
      const floor = shippedRulesPath();
      const set = loadRules(floor);
      this.entries.set(path, { set, sig: "floor", checkedAt: t, badSig: sig });
      return set;
    }
  }

  /** Forget the check clock: the next get() re-stats the files. */
  invalidate(): void {
    for (const e of this.entries.values()) e.checkedAt = 0;
  }
}
