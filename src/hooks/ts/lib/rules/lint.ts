/**
 * lint.ts — run each rule's own fixtures.
 *
 * Every `tests.match` string must hit the rule, every `tests.no_match` must
 * not. A rule with no fixtures is ok (nothing to check).
 */

import { evaluateRules } from "./eval.js";
import type { Rule } from "./types.js";

export interface RuleLint {
  id: string;
  ok: boolean;
  failures: string[];
}

export function lintRules(rules: Rule[]): RuleLint[] {
  return rules.map((rule) => {
    const failures: string[] = [];
    for (const text of rule.tests?.match ?? []) {
      const hit = evaluateRules([rule], "Bash", text);
      if (!hit || hit.rule.id !== rule.id) failures.push(`tests.match did not hit: ${text}`);
    }
    for (const text of rule.tests?.no_match ?? []) {
      const hit = evaluateRules([rule], "Bash", text);
      if (hit && hit.rule.id === rule.id) failures.push(`tests.no_match hit: ${text}`);
    }
    return { id: rule.id, ok: failures.length === 0, failures };
  });
}
