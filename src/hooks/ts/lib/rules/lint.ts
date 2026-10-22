/**
 * lint.ts — run each rule's own fixtures.
 *
 * Every `tests.match` must hit the rule, every `tests.no_match` must not.
 * A single-step rule's fixtures are plain strings tested as Bash commands; a
 * sequence rule's are lists of step contents, checked step by step (the
 * window and ordering are the scan's business, not the fixtures'). A rule
 * with no fixtures is ok (nothing to check).
 */

import { evaluateRules } from "./eval.js";
import type { Rule, RuleSequenceStep } from "./types.js";

export interface RuleLint {
  id: string;
  ok: boolean;
  failures: string[];
}

function stepRegex(step: RuleSequenceStep): RegExp | null {
  try {
    return new RegExp(step.match, step.flags ?? "");
  } catch {
    return null;
  }
}

/** One fixture step: the content tested, optionally the tool it belongs to. */
interface FixtureStep {
  tool?: string;
  content: string;
}

/**
 * A fixture sequence hits when every step's regex matches its content and its
 * tool pin, when set. A plain string is a Bash-shaped step; an object names
 * the tool, so a rule whose step is pinned to a fetched result (WebFetch,
 * Read) can still carry a fixture that hits. A step whose source
 * backreferences an earlier step's group (`\1`) is checked with that group's
 * capture substituted in — the same resolution the transcript scan applies —
 * so a fixture like download-then-execute's "same file twice" checks the way
 * the scan does.
 */
function sequenceHit(rule: Rule, steps: FixtureStep[]): boolean {
  const seqSteps = rule.sequence?.steps ?? [];
  if (steps.length !== seqSteps.length) return false;
  const prior: RegExpMatchArray[] = [];
  for (let i = 0; i < seqSteps.length; i++) {
    const step = seqSteps[i];
    const { tool, content } = steps[i];
    if (step.tool && !new RegExp(step.tool).test(tool ?? "Bash")) return false;
    // a step that names an earlier step's capture (`\1`) is checked with that
    // capture substituted in — the raw `\1` can never match text
    if (step.match.includes("\\1") && prior.length) {
      const cap = prior[0][1];
      if (!cap) return false;
      const lit = cap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      try {
        if (!new RegExp(step.match.replace(/\\1/g, () => lit), step.flags ?? "").test(content)) return false;
      } catch {
        return false;
      }
      continue;
    }
    const re = stepRegex(step);
    if (!re) return false;
    const m = content.match(re);
    if (!m) return false;
    prior.push(m);
  }
  return true;
}

/** A fixture sequence as written in yaml: a list of strings or {tool, content} objects. */
type FixtureSequence = Array<string | { tool?: string; content: string }>;

function asFixtureSteps(t: string | FixtureSequence): FixtureStep[] | null {
  if (!Array.isArray(t)) return null;
  return t.map((s) => (typeof s === "string" ? { content: s } : { tool: s.tool, content: s.content }));
}

export function lintRules(rules: Rule[]): RuleLint[] {
  return rules.map((rule) => {
    const failures: string[] = [];
    const show = (t: string | FixtureSequence): string =>
      Array.isArray(t) ? t.map((s) => (typeof s === "string" ? s : `${s.tool ?? "Bash"}: ${s.content}`)).join(" | ") : t;
    if (rule.sequence) {
      for (const t of rule.tests?.match ?? []) {
        const steps = asFixtureSteps(t);
        if (!steps || !sequenceHit(rule, steps)) failures.push(`tests.match did not hit: ${show(t)}`);
      }
      for (const t of rule.tests?.no_match ?? []) {
        const steps = asFixtureSteps(t);
        if (steps && sequenceHit(rule, steps)) failures.push(`tests.no_match hit: ${show(t)}`);
      }
      return { id: rule.id, ok: failures.length === 0, failures };
    }
    for (const text of (rule.tests?.match ?? []) as string[]) {
      const hit = evaluateRules([rule], "Bash", text);
      if (!hit || hit.rule.id !== rule.id) failures.push(`tests.match did not hit: ${text}`);
    }
    for (const text of (rule.tests?.no_match ?? []) as string[]) {
      const hit = evaluateRules([rule], "Bash", text);
      if (hit && hit.rule.id === rule.id) failures.push(`tests.no_match hit: ${text}`);
    }
    return { id: rule.id, ok: failures.length === 0, failures };
  });
}
