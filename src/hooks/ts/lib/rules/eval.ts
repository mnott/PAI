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
 *
 * What a rule sees is bounded first (capContent), so a megabyte of padding
 * cannot make a pattern run long enough for the hook to time out.
 */

import { Script, createContext } from "node:vm";
import { splitSegments } from "../worker-git-guard.js";
import { capContent } from "./cap.js";
import type { Rule } from "./types.js";

export { capContent };

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

/** A segment that starts a git push (bounded, no `.*` scan). */
const GIT_PUSH = /^\s*(?:\S+\s+){0,8}?git(?:\s+\S+){0,6}?\s+push(?=\s|$)/;

/** A segment whose command only carries text: a commit message, a grep/rg pattern, echo/printf. */
const TEXT_COMMAND = /^\s*(?:(?:sudo|env|command)\s+)*(?:git(?:\s+\S+){0,4}?\s+(?:commit|tag|notes)(?=\s|$)|(?:grep|egrep|fgrep|rg|ag|ack|echo|printf)(?=\s|$))/;

/** A heredoc fed to an interpreter is code; any other heredoc body is text. */
const HEREDOC_RUNNER = /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|python[\d.]*|node|perl|ruby|sqlite3|psql|mysql|osascript)(?=\s|$)/;

/** Drop the bodies of heredocs not fed to an interpreter (`cat > f <<EOF`, `$(cat <<'EOF')` in a commit message). */
function stripHeredocBodies(text: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of text.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<(?!<)-?\s*(["']?)(\w+)\1/.exec(line);
    if (m && !HEREDOC_RUNNER.test(line.slice(0, m.index))) end = m[2];
  }
  return out.join("\n");
}

/** Confirm rules test one segment: quoted text is inert, except a quoted +refspec on a push and rules marked `quoted`. */
function confirmHit(rule: Rule, pattern: RegExp, segment: string, test: Tester): boolean {
  const bare = dropQuoted(segment);
  if (test(pattern, bare)) return true;
  if (rule.quoted === true) return test(pattern, segment) || test(pattern, segment.replace(/["']/g, ""));
  return GIT_PUSH.test(bare) && test(pattern, segment.replace(/["']/g, ""));
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
  const capped = capContent(content);
  const bare = dropQuoted(capped);
  const variants = [...new Set([bare, capped, capped.replace(/["']/g, "")])];
  const segments = splitSegments(capped);
  let textSegments: string[] | null = null; // built on the first text_ok rule
  for (const severity of ["block", "confirm", "warn"] as const) {
    for (const rule of rules) {
      if (rule.severity !== severity || !toolMatches(rule, toolName)) continue;
      const re = ruleRegex(rule);
      if (!re) continue;
      const test = rule.untrusted ? guardedTest : plainTest;
      let hit: boolean;
      try {
        if (severity === "confirm") {
          let segs = segments;
          if (rule.text_ok) {
            textSegments ??= splitSegments(stripHeredocBodies(capped)).filter((seg) => !TEXT_COMMAND.test(seg));
            segs = textSegments;
          }
          hit = segs.some((seg) => confirmHit(rule, re, seg, test));
        } else {
          hit = rule.quoted === true ? variants.some((t) => test(re, t)) : test(re, bare);
        }
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
