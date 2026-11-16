/**
 * gate-log.ts — what the merge gate keeps when a test/verify command fails.
 *
 * The ledger used to carry only a 300-char summary line: another session
 * needed three blind fix rounds because the failing test name and assertion
 * were invisible (and a stale dist/ in the main checkout was the real cause).
 * So every gate failure writes its FULL output (stdout+stderr) to
 * <logDir>/<id>.merge-gate.log — the last MERGE_GATE_KEEP runs per id, like
 * flaky-log.ts keeps the last 20 per file — and the error line names that
 * path plus, parsed from the output, the failing test names (vitest /
 * node:test / pytest formats) and the first assertion/error line.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MERGE_GATE_KEEP = 20;

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Parsed from a failing gate's output: names, the first assertion/error line, a stale-build hint. */
export interface GateFailure {
  /** Failing test names, in run order, deduped (max 20). */
  names: string[];
  /** First assertion/error line of the first failure, max 400 chars; "" when none parsed. */
  assert: string;
  /** Hint lines, e.g. a stale dist/ next to a test that imports it. */
  hints: string[];
}

const NODE_ASSERT = /^(AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|Error)\b/;
const VITEST_ASSERT = /(Assertion|Type|Reference|Range)?Error\b|expected .* to |Timeout|timed out/;

/** vitest prints "AssertionError: expected 1 to be 2"; pytest/jest print "assert ..." / "expect(...)" / "E   assert 1 == 2". */
const isAssertLine = (l: string): boolean =>
  NODE_ASSERT.test(l) || VITEST_ASSERT.test(l) || /^assert\b/.test(l) || /^E\s+assert\b/.test(l) || /^expect\(/.test(l);

/** vitest's "→ expected 1 to be 2" arrow line is a detail, not the report: only the error/assert lines count. */
const STRONG_ASSERT = (l: string): boolean => NODE_ASSERT.test(l) || /^(?:E\s+)?assert\b/.test(l) || /^expect\(/.test(l);

/**
 * Failing test names (vitest "FAIL file > test", node:test "not ok N - name",
 * pytest "FAILED file::test"), the first assertion/error line of the first
 * failure, and hints. `repo` enables the stale-build hint: a test that
 * imports dist/ while dist/ is older than src/.
 */
export function parseGateFailure(output: string, repo?: string): GateFailure {
  const lines = stripAnsi(output).split("\n");
  const names: string[] = [];
  const push = (n: string): void => {
    if (n && !names.includes(n) && names.length < 20) names.push(n);
  };
  let firstFail = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // vitest: "FAIL <file>" / "FAIL <file> > <test>"; the bare FAIL line is a name too
    const fail = /^\s*FAIL\s+(.+)$/.exec(l);
    if (fail) {
      push(fail[1].trim());
      if (firstFail < 0) firstFail = i;
      continue;
    }
    // node:test TAP: "not ok 1 - name" (skip/todo markers don't count as failures)
    const tap = /^\s*not ok\s+\d+\s+-\s+(.+?)(?:\s+#\s*(?:SKIP|TODO).*)?$/.exec(l);
    if (tap && !/#\s*(SKIP|TODO)/.test(l)) {
      push(tap[1].trim());
      if (firstFail < 0) firstFail = i;
      continue;
    }
    // pytest: "FAILED path::test" / short summary "path::test FAILED"; ERROR lines are failures too
    const py = /^\s*FAILED\s+(.+?)(?:\s+-\s.*)?$/.exec(l);
    if (py) {
      push(py[1].trim());
      if (firstFail < 0) firstFail = i;
      continue;
    }
    const pys = /^(.+::\S+?)\s+FAILED\b/.exec(l);
    if (pys) {
      push(pys[1].trim());
      if (firstFail < 0) firstFail = i;
      continue;
    }
    const pe = /^\s*ERROR\s+(?:\(.*\)\s+)?(.+?::\S+)/.exec(l);
    if (pe) {
      push(pe[1].trim());
      if (firstFail < 0) firstFail = i;
    }
  }
  let assert = "";
  if (firstFail >= 0) {
    // node:test TAP reports the error block BEFORE its "not ok" line: look back there first.
    // vitest and pytest report it after (pytest's short summary lists FAILED before the FAILURES section, so forward is right).
    const nearestBack = (): string => {
      for (let i = firstFail - 1; i >= Math.max(0, firstFail - 40); i--) {
        const l = lines[i].trim();
        if (STRONG_ASSERT(l)) return l; // nearest strong line above the failure
      }
      return "";
    };
    const forward = (): string => {
      let weak = "";
      for (let i = firstFail; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l || /^\s*(?:FAIL|not ok|FAILED|ERROR)\b/.test(l)) continue;
        if (STRONG_ASSERT(l)) return l;
        if (!weak && isAssertLine(l)) weak = l; // the "→ expected…" detail, only if no error line follows
      }
      return weak;
    };
    assert = (/^\s*not ok\s/.test(lines[firstFail]) ? nearestBack() || forward() : forward() || nearestBack()).slice(0, 400);
  }
  const hints: string[] = [];
  if (repo && staleDistHint(output, repo)) hints.push("dist/ is older than src/: run the build first");
  return { names, assert, hints };
}

/** True when the output names a file under the repo's dist/ and that dist/ is older than its src/. */
export function staleDistHint(output: string, repo: string): boolean {
  if (!output.includes(join(repo, "dist") + "/")) return false;
  try {
    const d = join(repo, "dist");
    const s = join(repo, "src");
    if (!existsSync(d) || !existsSync(s)) return false;
    return statSync(d).mtimeMs < statSync(s).mtimeMs;
  } catch {
    return false;
  }
}

/** One merge-gate log per failed run: `<logDir>/<id>.merge-gate-<ts>.log`; the newest is what a caller names. */
export function mergeGateLogPath(logDir: string, id: string, at: Date): string {
  const ts = at.toISOString().replace(/[:.]/g, "-");
  return `${join(logDir, `${id}.merge-gate`)}-${ts}.log`;
}

/** Newest first; null when there is none. */
export function latestMergeGateLog(logDir: string, id: string): string | null {
  try {
    const mine = readdirSync(logDir)
      .filter((f) => f.startsWith(`${id}.merge-gate-`) && f.endsWith(".log"))
      .sort();
    return mine.length ? join(logDir, mine[mine.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * Writes the full gate output for one failed run and prunes to the newest
 * MERGE_GATE_KEEP per id. Returns the path, null when it cannot write.
 */
export function saveMergeGateLog(logDir: string, id: string, output: string, at: Date = new Date()): string | null {
  try {
    mkdirSync(logDir, { recursive: true });
    const path = mergeGateLogPath(logDir, id, at);
    writeFileSync(path, stripAnsi(output), "utf8");
    const mine = readdirSync(logDir)
      .filter((f) => f.startsWith(`${id}.merge-gate-`) && f.endsWith(".log"))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - MERGE_GATE_KEEP))) {
      try {
        rmSync(join(logDir, old), { force: true });
      } catch {
        /* best effort */
      }
    }
    return path;
  } catch {
    return null;
  }
}
