/**
 * eval.ts — run rules against a tool call.
 *
 * Order is fixed: the first block hit wins, else the first confirm hit, else
 * the first warn hit. Text inside quotes is not a command, so rules test the
 * content with quoted strings removed; rules marked `quoted: true` also test
 * it as written and with only the quote marks removed — every builtin block
 * rule whose payload can sit inside `bash -c "..."` is marked, and anchors on
 * command position so a message that merely mentions the payload stays
 * allowed. Confirm rules test per-segment, so a quoted `git push -f` in a commit
 * message stays inert while a quoted `+main` refspec still counts.
 */

import { splitSegments } from "../worker-git-guard.js";
import type { Rule } from "./types.js";

export interface RuleHit {
  rule: Rule;
}

/** Quoted strings removed: text inside a commit message or echo is not a command. */
function dropQuoted(segment: string): string {
  return segment.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
}

/** A quoted +refspec is still a forced push, so push segments also test with only the quote marks removed. */
function gitPatternHit(pattern: RegExp, segment: string): boolean {
  const bare = dropQuoted(segment);
  if (pattern.test(bare)) return true;
  return /\bgit\b.*\spush\b/.test(bare) && pattern.test(segment.replace(/["']/g, ''));
}

const regexCache = new Map<string, RegExp>();

function ruleRegex(rule: Rule): RegExp | null {
  if (!rule.match) return null; // an "off" rule carries no pattern
  const key = `${rule.match} ${rule.flags ?? ""}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  try {
    const re = new RegExp(rule.match, (rule.flags ?? "").replace(/[gy]/g, "")); // g/y would make .test stateful
    regexCache.set(key, re);
    return re;
  } catch {
    return null; // loadRules validates; a hand-built bad rule never matches
  }
}

function toolMatches(rule: Rule, toolName: string): boolean {
  if (!rule.tool) return toolName === "Bash";
  try {
    return new RegExp(rule.tool).test(toolName);
  } catch {
    return false;
  }
}

/** First block hit, else first confirm hit, else first warn hit; null when none. */
export function evaluateRules(rules: Rule[], toolName: string, content: string): RuleHit | null {
  const unquoted = content.replace(/["']/g, "");
  const bare = dropQuoted(content);
  const segments = splitSegments(content);
  for (const severity of ["block", "confirm", "warn"] as const) {
    for (const rule of rules) {
      if (rule.severity !== severity || !toolMatches(rule, toolName)) continue;
      const re = ruleRegex(rule);
      if (!re) continue;
      const hit =
        severity === "confirm"
          ? segments.some((seg) => gitPatternHit(re, seg))
          : re.test(bare) || (rule.quoted === true && (re.test(content) || re.test(unquoted)));
      if (hit) return { rule };
    }
  }
  return null;
}
