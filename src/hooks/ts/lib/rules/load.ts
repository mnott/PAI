/**
 * load.ts — read `*.rule.yaml` files (and `<id>.yaml` in an antipatterns/shell dir) from directories into rules.
 *
 * One rule per file, or a top-level list of rules. A bad regex or a missing
 * field is reported in `errors` and the rule is skipped — this never throws,
 * because hooks fail open and a broken user rule must not break the hook.
 *
 * Directories are read in order; a later rule with the same id replaces an
 * earlier one (user rules override built-ins), and `severity: off` disables
 * that id entirely. Project directories (`.pai/rules` at or above the cwd,
 * up to the repo root, shipped by whatever repo is checked out) are less
 * trusted: they may only add rules or
 * raise the severity of an existing id (the existing pattern stays); an
 * `off` or a downgrade is ignored and reported in `ignored`.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse as parsePath, resolve, sep } from "node:path";
import { parse } from "yaml";
import { defaultPaiHomeDir, legacyPaiHomeDir } from "../../../../config/pai-home.js";
import { parseLifecycle, type Lifecycle } from "../antipattern-lifecycle.js";
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
 * The user rule directories: PAI_HOME/rules and the project rules dir found
 * at or above the cwd.
 * PAI_HOME is resolved like paiHomeDir() but without its stderr migration
 * notice — a hook's stderr is machinery, and reading a rules directory is
 * not a reason to complain about it.
 */
export function userRuleDirs(cwd: string = process.cwd()): string[] {
  return [homeRulesDir(), ...projectRuleDirs(cwd)];
}

/** Every rule directory in load order: PAI_HOME/rules, PAI_HOME/antipatterns/shell, then the project dir. */
export function allRuleDirs(cwd: string = process.cwd()): string[] {
  const [home, ...project] = userRuleDirs(cwd);
  return [home, userAntipatternShellDir(), ...project];
}

/** The user's own shell anti-patterns (PAI_HOME/antipatterns/shell/<id>.yaml): same schema, loaded after PAI_HOME/rules. */
export function userAntipatternShellDir(): string {
  return join(homePaiDir(), "antipatterns", "shell");
}

function homeRulesDir(): string {
  return join(homePaiDir(), "rules");
}

function homePaiDir(): string {
  return process.env.PAI_HOME
    ? process.env.PAI_HOME
    : !existsSync(join(defaultPaiHomeDir(), "config.yaml")) && existsSync(join(legacyPaiHomeDir(), "config.yaml"))
      ? legacyPaiHomeDir()
      : defaultPaiHomeDir();
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The repo-local rule directory: the first `.pai/rules` found walking up from
 * cwd to the nearest directory containing `.git` (file or dir), so a session
 * started in a repo subdirectory still sees the repo's rules; closest wins.
 * The walk needs a `.git` ancestor at or below $HOME (none: no project rules)
 * and stops at a directory owned by another uid. The PAI-home rules dir is never one,
 * even when cwd is $HOME and PAI_HOME=~/.pai makes both paths the same
 * directory.
 */
export function projectRuleDirs(cwd: string = process.cwd()): string[] {
  const home = realOrResolved(homedir());
  const homeRules = realOrResolved(homeRulesDir());
  const uid = process.getuid?.();
  const ownedByOther = (d: string): boolean => {
    try { return uid !== undefined && statSync(d).uid !== uid; } catch { return false; }
  };
  const inHome = (d: string): boolean => d === home || d.startsWith(home.endsWith(sep) ? home : home + sep);
  // the repo root must exist at or below $HOME and be reached without crossing a directory of another uid:
  // otherwise /tmp/.pai/rules or /Users/Shared/.pai/rules, written by another user, would be picked up
  const start = realOrResolved(cwd);
  const chain: string[] = [];
  let root: string | null = null;
  for (let dir = start; dir !== parsePath(dir).root; dir = parsePath(dir).dir) {
    if (!inHome(dir) || ownedByOther(dir)) return [];
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) { root = dir; break; }
  }
  if (!root) return [];
  for (const dir of chain) {
    const rules = join(dir, ".pai", "rules");
    if (existsSync(rules)) return realOrResolved(rules) === homeRules ? [] : [rules];
  }
  return [];
}

/** A project pattern longer than this is not accepted: untrusted input is kept small. */
const PROJECT_PATTERN_MAX = 512;

/** The quantifier starting at source[i]: its length, whether it repeats, whether it has no upper bound. */
function quantifierAt(source: string, i: number): { len: number; repeats: boolean; unbounded: boolean } | null {
  const c = source[i];
  if (c === "*" || c === "+") return { len: 1, repeats: true, unbounded: true };
  if (c === "?") return { len: 1, repeats: false, unbounded: false };
  if (c !== "{") return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
  if (!m) return null;
  const unbounded = m[2] !== undefined && m[3] === "";
  const max = m[2] === undefined ? Number(m[1]) : unbounded ? Infinity : Number(m[3]);
  return { len: m[0].length, repeats: max > 1, unbounded };
}

/**
 * Why a regex source from a project dir is refused, or null when it may load.
 * Refused: longer than PROJECT_PATTERN_MAX, or a repeated group (`*`, `+`,
 * `{n,}`, `{n,m}`) whose body itself contains a `*`, `+` or `{n,}` — the
 * `(a+)+` shape that backtracks exponentially.
 */
export function untrustedPatternProblem(source: string): string | null {
  if (source.length > PROJECT_PATTERN_MAX) return `pattern longer than ${PROJECT_PATTERN_MAX} chars`;
  // per open group: whether its body holds an unbounded or repeated quantifier
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      stack.push(false);
    } else if (c === ")") {
      const inner = stack.pop() ?? false;
      const q = quantifierAt(source, i + 1);
      if (q?.repeats && inner) return "nested quantifier (a repeated group whose body is itself repeated)";
      if (stack.length && (inner || q?.repeats)) stack[stack.length - 1] = true;
    } else {
      const q = quantifierAt(source, i);
      if (q) {
        if (q.unbounded && stack.length) stack[stack.length - 1] = true;
        i += q.len - 1;
      }
    }
  }
  return null;
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
  const lc = parseLifecycle(raw);
  if (typeof lc === "string") {
    errors.push(`${source} (${id}): ${lc}`);
    return null;
  }
  const match = typeof raw.match === "string" ? raw.match : "";
  // A sequence rule carries its patterns in `sequence.steps` instead of `match`.
  if (raw.sequence !== undefined) {
    const sequence = asSequence(raw, id, source, errors);
    if (!sequence) return null;
    return { ...lc, id, severity, sequence, category: typeof raw.category === "string" ? raw.category : undefined, reason, tests: asTests(raw) };
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
    ...lc,
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

/** The rule's lifecycle with defaults filled in (built-ins embed the raw YAML fields). */
export function ruleLifecycle(rule: Rule): Lifecycle {
  const lc = parseLifecycle(rule as unknown as Record<string, unknown>);
  return typeof lc === "string" ? parseLifecycle({}) as Lifecycle : lc;
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
    // the anti-pattern directory names its files <id>.yaml (antipatterns/shell/)
    const idNamed = basename(dir) === "shell" && basename(dirname(dir)) === "antipatterns";
    names = readdirSync(dir).filter((f) => f.endsWith(".rule.yaml") || (idNamed && f.endsWith(".yaml"))).sort();
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

/** First problem among a project rule's patterns (match and sequence steps), or null. */
function untrustedRuleProblem(rule: Rule): string | null {
  const sources = [rule.match, ...(rule.sequence?.steps.map((s) => s.match) ?? [])];
  for (const src of sources) {
    if (!src) continue;
    const p = untrustedPatternProblem(src);
    if (p) return p;
  }
  return null;
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
      if (isProject) {
        const problem = untrustedRuleProblem(rule);
        if (problem) {
          ignored.push(`${rule.source} (${rule.id}): project rule pattern refused: ${problem}`);
          continue;
        }
      }
      if (!isProject || !existing) {
        byId.set(rule.id, isProject ? { ...rule, untrusted: true } : rule);
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
    if (rule.severity === "off" || rule.status === "deprecated") continue;
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
