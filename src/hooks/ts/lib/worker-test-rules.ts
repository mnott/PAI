/**
 * worker-test-rules.ts — deny test runs in a worker whose project is tested by the operator.
 *
 * `.pai/checks.yaml` with `tests: operator` (the key loadChecks reads) means the
 * operator tests visually: the loop is implement -> build the touched target ->
 * stop. Memory rules saying this were broken by every worker spec, so the
 * PreToolUse guard enforces it. `pai worker run --allow-tests` sets
 * PAI_WORKER_ALLOW_TESTS=1 and the guard allows tests again — only when the
 * operator asked for tests.
 *
 * The runners are the loop guard's RUNNER list (loop-guard.ts actionKey), shared
 * here, not a second list; a registered build door invoked in a test mode (first
 * door arg `test`, e.g. `sh tools/build.sh test mac --wait`) is denied too.
 * `tools/check.sh` is a runner by name.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectConfigFile } from "../../../workers/preamble.js";
import { stripPrefix } from "./build-gate.js";
import { RUNNER } from "./loop-guard.js";

export const OPERATOR_TESTS_REL = ".pai/checks.yaml";

/** Reason text; the spec fixes it verbatim. */
export const OPERATOR_TESTS_DENY =
  "PAI: this project is tested by the operator (.pai/checks.yaml tests: operator): build the touched target, report, stop — no test runs";

/**
 * True when the nearest `.pai/checks.yaml` at or above `cwd` has `tests: operator`.
 * The worktree has no `.pai/` (gitignored), so a worker in a worktree finds the
 * main checkout's file through projectConfigFile; outside git the cwd itself is
 * searched, then upward (a plain temp dir has no git toplevel).
 */
export function projectTestsByOperator(cwd: string): boolean {
  let path = projectConfigFile(cwd, OPERATOR_TESTS_REL);
  if (!existsSync(path)) {
    let dir = resolve(cwd);
    for (;;) {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
      const cand = join(dir, OPERATOR_TESTS_REL);
      if (existsSync(cand)) {
        path = cand;
        break;
      }
    }
  }
  if (!existsSync(path)) return false;
  try {
    return /^\s*tests\s*:\s*operator\s*(#.*)?$/m.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** The first positional (non-flag) word after the door script and an optional `sh|bash|zsh`. */
function firstDoorArg(ws: string[]): string | null {
  let w = stripPrefix(ws);
  if (/^(?:bash|sh|zsh)$/.test(w[0]?.slice(w[0].lastIndexOf("/") + 1) ?? "")) {
    w = w.slice(1);
    while (w[0]?.startsWith("-")) w = w.slice(1);
  }
  w = w.slice(1); // the door script itself
  return w.find((x) => !x.startsWith("-")) ?? null;
}

/**
 * Deny reason when `command` runs a test: a loop-guard RUNNER in test mode
 * (vitest/jest/pytest/swift test/cargo test/go test/npm test/…, but not the
 * `npm run build` / bare `tsc` members of the list), `xcodebuild … test`,
 * `tools/check.sh`, or a registered door whose first argument is `test`.
 * `cfg` is the project's builds config (doors); null when none is registered.
 */
export function operatorTestsReason(command: string, runsDoor: (ws: string[], cwd: string) => boolean, cwd: string): string | null {
  const bare = command.replace(/\d*>>?\s*&?[^\s;&|]+/g, " ").replace(/<\s*[^\s;&|]+/g, " ");
  let dir = cwd;
  for (const raw of bare.split(/&&|\|\||[;|&\n]/)) {
    let seg = raw.replace(/["']/g, "").trim();
    for (;;) {
      const next = seg
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)/, "")
        .replace(/^nohup\s+/, "")
        .replace(/^(?:timeout|gtimeout)\s+(?:-\S+\s+)*\d+\w*\s+/, "")
        .replace(/^cd\s+(\S+)\s*/, (_m, p: string) => ((dir = resolve(dir, p)), ""));
      if (next === seg) break;
      seg = next;
    }
    if (!seg) continue;
    const ws = stripPrefix(seg.split(/\s+/).filter(Boolean));
    if (!ws.length) continue;
    if (/^(?:tools\/)?check\.sh$/.test(ws[0])) return OPERATOR_TESTS_DENY;
    if (runsDoor(ws, dir) && firstDoorArg(ws) === "test") return OPERATOR_TESTS_DENY;
    const m = RUNNER.exec(seg);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (key === "npm run build" || key === "npm test" || key === "tsc") continue;
    if (key === "xcodebuild") {
      if (/\btest-without-building\b|\btest\b/.test(rest)) return OPERATOR_TESTS_DENY;
      continue;
    }
    return OPERATOR_TESTS_DENY;
  }
  return null;
}
