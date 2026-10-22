/**
 * load.ts — read `*.rule.yaml` files from directories into rules.
 *
 * One rule per file, or a top-level list of rules. A bad regex or a missing
 * field is reported in `errors` and the rule is skipped — this never throws,
 * because hooks fail open and a broken user rule must not break the hook.
 *
 * Directories are read in order; a later rule with the same id replaces an
 * earlier one (user rules override built-ins), and `severity: off` disables
 * that id entirely.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { defaultPaiHomeDir, legacyPaiHomeDir } from "../../../../config/pai-home.js";
import { BUILTIN_RULES } from "./builtin.generated.js";
import type { LoadedRule, Rule, RuleSeverity } from "./types.js";

const SEVERITIES: RuleSeverity[] = ["block", "confirm", "warn", "off"];

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
  return [join(home, "rules"), join(cwd, ".pai", "rules")];
}

function asRule(value: unknown, source: string, errors: string[]): Rule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${source}: not a mapping`);
    return null;
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const severity = raw.severity as RuleSeverity;
  const match = typeof raw.match === "string" ? raw.match : "";
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
  if (!match) {
    errors.push(`${source} (${id}): missing match`);
    return null;
  }
  // YAML accepts a bare regex node (`match: /foo/i`); a plain string is the
  // regex source with flags in `flags`.
  const isRegexNode = match.length > 2 && match.startsWith("/") && /\/[a-z]*$/.test(match);
  const flags = typeof raw.flags === "string" ? raw.flags : isRegexNode ? match.slice(match.lastIndexOf("/") + 1) : "";
  const source2 = isRegexNode ? match.slice(1, match.lastIndexOf("/")) : match;
  try {
    new RegExp(source2, flags);
  } catch (e) {
    errors.push(`${source} (${id}): invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const tests =
    typeof raw.tests === "object" && raw.tests !== null && !Array.isArray(raw.tests)
      ? {
          match: Array.isArray((raw.tests as Record<string, unknown>).match) ? ((raw.tests as Record<string, unknown>).match as unknown[]).map(String) : undefined,
          no_match: Array.isArray((raw.tests as Record<string, unknown>).no_match) ? ((raw.tests as Record<string, unknown>).no_match as unknown[]).map(String) : undefined,
        }
      : undefined;
  return {
    id,
    severity,
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
    category: typeof raw.category === "string" ? raw.category : undefined,
    match: source2,
    flags: flags || undefined,
    quoted: raw.quoted === true ? true : undefined,
    reason,
    tests,
  };
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

/**
 * Built-in rules first, then each directory in order; a later rule with the
 * same id replaces the earlier one, and `severity: off` removes the id.
 */
export function loadRules(dirs: string[]): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map<string, LoadedRule>();
  for (const rule of BUILTIN_RULES) byId.set(rule.id, rule);
  for (const dir of dirs) {
    for (const rule of loadDir(dir, errors)) byId.set(rule.id, rule);
  }
  const rules: Rule[] = [];
  for (const rule of byId.values()) {
    if (rule.severity === "off") continue;
    const { source: _source, ...rest } = rule;
    rules.push(rest);
  }
  return { rules, errors };
}

/** Every rule with its source and enabled state, for `pai rules list`. */
export function listRules(dirs: string[]): { rules: LoadedRule[]; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map<string, LoadedRule>();
  for (const rule of BUILTIN_RULES) byId.set(rule.id, rule);
  for (const dir of dirs) {
    for (const rule of loadDir(dir, errors)) byId.set(rule.id, rule);
  }
  return { rules: [...byId.values()], errors };
}
