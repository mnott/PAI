/**
 * load.ts — read `*.rule.yaml` files from directories into rules.
 *
 * One rule per file, or a top-level list of rules. A bad regex or a missing
 * field is reported in `errors` and the rule is skipped — this never throws,
 * because hooks fail open and a broken user rule must not break the hook.
 *
 * Directories are read in order; a later rule with the same id replaces an
 * earlier one (user rules override built-ins), and `severity: off` disables
 * that id entirely. Project directories (`<cwd>/.pai/rules`, shipped by
 * whatever repo is checked out) are less trusted: they may only add rules or
 * raise the severity of an existing id (the existing pattern stays); an
 * `off` or a downgrade is ignored and reported in `ignored`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { defaultPaiHomeDir, legacyPaiHomeDir } from "../../../../config/pai-home.js";
import { BUILTIN_RULES } from "./builtin.generated.js";
import type { LoadedRule, Rule, RuleSequence, RuleSequenceStep, RuleSeverity } from "./types.js";

const SEVERITIES: RuleSeverity[] = ["block", "confirm", "warn", "off"];

/** `g` and `y` make RegExp.test stateful (alternating hit/miss on a cached regex); rules never need them. */
function statelessFlags(flags: string): string {
  return flags.replace(/[gy]/g, "");
}

/** A YAML regex node (`/foo/i`) split into source and flags; a plain string is the source. */
function splitRegex(value: string): { source: string; flags: string } {
  const isRegexNode = value.length > 2 && value.startsWith("/") && /\/[a-z]*$/.test(value);
  return isRegexNode
    ? { source: value.slice(1, value.lastIndexOf("/")), flags: value.slice(value.lastIndexOf("/") + 1) }
    : { source: value, flags: "" };
}

/** A sequence mapping, validated (steps, window, order, every step regex compiles), or null with an error pushed. */
function asSequence(raw: Record<string, unknown>, id: string, source: string, errors: string[]): RuleSequence | null {
  const seq = raw.sequence;
  if (typeof seq !== "object" || seq === null || Array.isArray(seq)) {
    errors.push(`${source} (${id}): sequence must be a mapping`);
    return null;
  }
  const s = seq as Record<string, unknown>;
  const rawSteps = Array.isArray(s.steps) ? s.steps : [];
  const steps: RuleSequenceStep[] = [];
  for (const item of rawSteps) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${source} (${id}): sequence step must be a mapping`);
      return null;
    }
    const step = item as Record<string, unknown>;
    const match = typeof step.match === "string" ? step.match : "";
    if (!match) {
      errors.push(`${source} (${id}): sequence step missing match`);
      return null;
    }
    const split = splitRegex(match);
    const flags = statelessFlags(typeof step.flags === "string" ? step.flags : split.flags);
    try {
      new RegExp(split.source, flags);
    } catch (e) {
      errors.push(`${source} (${id}): sequence step invalid regex: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    steps.push({
      tool: typeof step.tool === "string" ? step.tool : undefined,
      match: split.source,
      flags: flags || undefined,
    });
  }
  if (!steps.length) {
    errors.push(`${source} (${id}): sequence has no steps`);
    return null;
  }
  const window = Number(s.window_seconds);
  if (!Number.isFinite(window) || window <= 0) {
    errors.push(`${source} (${id}): sequence needs a positive window_seconds`);
    return null;
  }
  const order = s.order === "any" ? "any" : s.order === "strict" ? "strict" : null;
  if (!order) {
    errors.push(`${source} (${id}): sequence order must be strict or any`);
    return null;
  }
  return { steps, window_seconds: window, order };
}

/**
 * The user rule directories: PAI_HOME/rules and .pai/rules under the cwd.
 * PAI_HOME is resolved like paiHomeDir() but without its stderr migration
 * notice — a hook's stderr is machinery, and reading a rules directory is
 * not a reason to complain about it.
 */
export function userRuleDirs(cwd: string = process.cwd()): string[] {
  const home = process.env.PAI_HOME
    ? process.env.PAI_HOME
    : !existsSync(join(defaultPaiHomeDir(), "config.yaml")) && existsSync(join(legacyPaiHomeDir(), "config.yaml"))
      ? legacyPaiHomeDir()
      : defaultPaiHomeDir();
  return [join(home, "rules"), ...projectRuleDirs(cwd)];
}

/** The repo-local rule directories under cwd: the less trusted ones (see the file header). */
export function projectRuleDirs(cwd: string = process.cwd()): string[] {
  return [join(cwd, ".pai", "rules")];
}

function asRule(value: unknown, source: string, errors: string[]): Rule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${source}: not a mapping`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const severity = raw.severity as RuleSeverity;
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  if (!id) {
    errors.push(`${source}: missing id`);
    return null;
  }
  if (!SEVERITIES.includes(severity)) {
    errors.push(`${source} (${id}): severity must be block, confirm, warn or off`);
    return null;
  }
  if (!reason) {
    errors.push(`${source} (${id}): missing reason`);
    return null;
  }
  // `severity: off` disables the id; it needs no match.
  if (severity === "off") return { id, severity, reason };
  const match = typeof raw.match === "string" ? raw.match : "";
  // A sequence rule carries its patterns in `sequence.steps` instead of `match`.
  if (raw.sequence !== undefined) {
    const sequence = asSequence(raw, id, source, errors);
    if (!sequence) return null;
    return { id, severity, sequence, category: typeof raw.category === "string" ? raw.category : undefined, reason, tests: asTests(raw) };
  }
  if (!match) {
    errors.push(`${source} (${id}): missing match`);
    return null;
  }
  // YAML accepts a bare regex node (`match: /foo/i`); a plain string is the
  // regex source with flags in `flags`.
  const split = splitRegex(match);
  const flags = statelessFlags(typeof raw.flags === "string" ? raw.flags : split.flags);
  const source2 = split.source;
  try {
    new RegExp(source2, flags);
  } catch (e) {
    errors.push(`${source} (${id}): invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return {
    id,
    severity,
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
    category: typeof raw.category === "string" ? raw.category : undefined,
    match: source2,
    flags: flags || undefined,
    quoted: raw.quoted === true ? true : undefined,
    text_ok: raw.text_ok === true ? true : undefined,
    results: raw.results === true ? true : undefined,
    reason,
    tests: asTests(raw),
  };
}

/** Fixtures: plain strings for a single-step rule, lists of step contents for a sequence rule. */
function asTests(raw: Record<string, unknown>): Rule["tests"] {
  if (typeof raw.tests !== "object" || raw.tests === null || Array.isArray(raw.tests)) return undefined;
  const t = raw.tests as Record<string, unknown>;
  const list = (v: unknown): string[] | string[][] | undefined => {
    if (!Array.isArray(v)) return undefined;
    return v.every((x) => Array.isArray(x)) ? (v as unknown[][]).map((x) => x.map(String)) : v.map(String);
  };
  return { match: list(t.match), no_match: list(t.no_match) };
}

/** Rules from one directory's `*.rule.yaml` files, in filename order. */
function loadDir(dir: string, errors: string[]): LoadedRule[] {
  const out: LoadedRule[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".rule.yaml")).sort();
  } catch {
    return out; // missing directory is not an error
  }
  for (const name of names) {
    const source = join(dir, name);
    let text: string;
    try {
      text = readFileSync(source, "utf8");
    } catch (e) {
      errors.push(`${source}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (e) {
      errors.push(`${source}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const items = Array.isArray(doc) ? doc : [doc];
    for (const item of items) {
      const rule = asRule(item, source, errors);
      if (rule) out.push({ ...rule, source });
    }
  }
  return out;
}

const SEVERITY_RANK: Record<RuleSeverity, number> = { off: 0, warn: 1, confirm: 2, block: 3 };

export interface LoadOptions {
  /** Directories among `dirs` whose rules may only add or raise (see the file header). */
  projectDirs?: string[];
}

/** Built-ins, then each directory in order, with the project-directory restriction applied. */
function mergeRules(dirs: string[], opts: LoadOptions): { byId: Map<string, LoadedRule>; errors: string[]; ignored: string[] } {
  const errors: string[] = [];
  const ignored: string[] = [];
  const project = new Set((opts.projectDirs ?? []).map((d) => resolve(d)));
  const byId = new Map<string, LoadedRule>();
  for (const rule of BUILTIN_RULES) byId.set(rule.id, rule);
  for (const dir of dirs) {
    const isProject = project.has(resolve(dir));
    for (const rule of loadDir(dir, errors)) {
      const existing = byId.get(rule.id);
      if (!isProject || !existing) {
        byId.set(rule.id, rule);
      } else if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[existing.severity]) {
        // a raise keeps the existing pattern: a project file may not swap it for a weaker one
        byId.set(rule.id, existing.severity === "off" ? rule : { ...existing, severity: rule.severity, source: rule.source });
      } else {
        ignored.push(`${rule.source} (${rule.id}): project rules may only add rules or raise severity; ${rule.severity} ignored`);
      }
    }
  }
  return { byId, errors, ignored };
}

/**
 * Built-in rules first, then each directory in order; a later rule with the
 * same id replaces the earlier one, and `severity: off` removes the id.
 */
export function loadRules(dirs: string[], opts: LoadOptions = {}): { rules: Rule[]; errors: string[]; ignored: string[] } {
  const { byId, errors, ignored } = mergeRules(dirs, opts);
  const rules: Rule[] = [];
  for (const rule of byId.values()) {
    if (rule.severity === "off") continue;
    const { source: _source, ...rest } = rule;
    rules.push(rest);
  }
  return { rules, errors, ignored };
}

/** Every rule with its source and enabled state, for `pai rules list`. */
export function listRules(dirs: string[], opts: LoadOptions = {}): { rules: LoadedRule[]; errors: string[]; ignored: string[] } {
  const { byId, errors, ignored } = mergeRules(dirs, opts);
  return { rules: [...byId.values()], errors, ignored };
}
