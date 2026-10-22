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

import { Script, createContext } from "node:vm";
import { splitSegments } from "../worker-git-guard.js";
import type { Rule } from "./types.js";

export interface RuleHit {
  rule: Rule;
  /** The rule's regex ran past the time guard; the hit is a fail-closed one. */
  timedOut?: boolean;
}

/** Longest a project rule's regex may run per test before it counts as a hit. */
export const UNTRUSTED_TIMEOUT_MS = 50;

type Tester = (re: RegExp, text: string) => boolean;

const plainTest: Tester = (re, text) => re.test(text);

// One context and one compiled script, reused for every guarded test; a
// timeout is enforced by the vm watchdog, which interrupts a running regex.
const guardCtx = createContext({ re: null as RegExp | null, text: "" });
const guardScript = new Script("re.test(text)");

/** Throws when the regex runs past UNTRUSTED_TIMEOUT_MS. */
const guardedTest: Tester = (re, text) => {
  guardCtx.re = re;
  guardCtx.text = text;
  try {
    return guardScript.runInContext(guardCtx, { timeout: UNTRUSTED_TIMEOUT_MS }) === true;
  } finally {
    guardCtx.re = null;
    guardCtx.text = "";
  }
};

/** Quoted strings removed: text inside a commit message or echo is not a command. */
function dropQuoted(segment: string): string {
  return segment.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
}

/** A quoted +refspec is still a forced push, so push segments also test with only the quote marks removed. */
function gitPatternHit(pattern: RegExp, segment: string, test: Tester): boolean {
  const bare = dropQuoted(segment);
  if (test(pattern, bare)) return true;
  return /\bgit\b.*\spush\b/.test(bare) && test(pattern, segment.replace(/["']/g, ''));
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
      const test = rule.untrusted ? guardedTest : plainTest;
      let hit: boolean;
      try {
        hit =
          severity === "confirm"
            ? segments.some((seg) => gitPatternHit(re, seg, test))
            : test(re, bare) || (rule.quoted === true && (test(re, content) || test(re, unquoted)));
      } catch {
        // a project regex that did not finish in time: fail closed for block and confirm
        if (severity === "warn") continue;
        return { rule, timedOut: true };
      }
      if (hit) return { rule };
    }
  }
  return null;
}
