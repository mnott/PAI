/**
 * merge-tests.ts — the related-tests check `pai worker merge` runs after a
 * successful merge: every test that imports a source file the merge changed
 * (`vitest related`), so a worker that reverses a codified rule is caught at
 * merge time, not by the full suite later. A failure never reverts the merge;
 * the operator decides.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

export interface RelatedSettings {
  /** Command template with `{files}`; empty = off. */
  verify: string;
  verifyTimeoutSec: number;
}

export interface RelatedResult {
  status: "passed" | "failed" | "skipped";
  /** The one line printed and recorded in the ledger. */
  line: string;
  failing: string[];
}

const SOURCE = /\.(ts|tsx|mjs)$/;
const TEST = /\.test\.[^/]*$/;

/** Changed source files (ts/tsx/mjs, no tests) from a `git diff --name-only` listing. */
export function filterSourceFiles(names: string[]): string[] {
  return names.filter((f) => SOURCE.test(f) && !TEST.test(f));
}

export function changedSourceFiles(cwd: string, oldHead: string, git: (cwd: string, args: string[]) => string): string[] {
  return filterSourceFiles(
    git(cwd, ["diff", "--name-only", oldHead, "HEAD", "--", "*.ts", "*.tsx", "*.mjs"]).split("\n").filter(Boolean)
  );
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The template with `{files}` replaced by the shell-quoted file list. */
export function buildRelatedCommand(template: string, files: string[]): string {
  return template.replace(/\{files\}/g, files.map(shq).join(" "));
}

/** Does the repo at `cwd` declare vitest in its devDependencies? */
export function hasVitest(cwd: string): boolean {
  try {
    const pj = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    return !!pj.devDependencies?.vitest;
  } catch {
    return false;
  }
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Failing test files named in vitest output (`FAIL  path/x.test.ts > ...`). */
export function failingFiles(output: string): string[] {
  const set = new Set<string>();
  for (const m of stripAnsi(output).matchAll(/^\s*(?:FAIL|❯)\s+(\S+\.test\.\w+)/gm)) set.add(m[1]);
  return [...set];
}

/** "14 files, 212 passed" from vitest's summary lines, or null. */
export function passSummary(output: string): string | null {
  const text = stripAnsi(output);
  const files = /Test Files\s+(?:.*?,\s*)?(\d+) passed/.exec(text) ?? /Test Files\s+(\d+)/.exec(text);
  const tests = /Tests\s+(?:.*?,\s*)?(\d+) passed/.exec(text);
  return files && tests ? `${files[1]} files, ${tests[1]} passed` : null;
}

/** Run the related tests for the merge `oldHead..HEAD`; never throws. */
export function runRelatedTests(
  cwd: string,
  oldHead: string,
  settings: RelatedSettings,
  git: (cwd: string, args: string[]) => string
): RelatedResult {
  const skip = (why: string): RelatedResult => ({ status: "skipped", line: `related tests: skipped (${why})`, failing: [] });
  if (!settings.verify.trim()) return skip("workers.merge.verify is empty");
  if (!hasVitest(cwd) && settings.verify === DEFAULT_VERIFY) return skip("no vitest in package.json devDependencies");
  let files: string[];
  try {
    files = changedSourceFiles(cwd, oldHead, git);
  } catch (e) {
    return skip(`cannot list changed files: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!files.length) return skip("no source files changed");
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "PAI_WORKER", "PAI_WORKER_ORCHESTRATOR"]) delete env[k];
  const timeoutSec = settings.verifyTimeoutSec > 0 ? settings.verifyTimeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const r = spawnSync("sh", ["-c", buildRelatedCommand(settings.verify, files)], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return { status: "failed", line: `related tests: timed out after ${timeoutSec}s`, failing: [] };
  }
  if (r.status === 0) {
    return { status: "passed", line: `related tests: ${passSummary(output) ?? `${files.length} source files, passed`}`, failing: [] };
  }
  const failing = failingFiles(output);
  const why = failing.length ? `failed: ${failing.join(", ")}` : `failed (exit ${r.status ?? 1})`;
  return { status: "failed", line: `related tests: ${why}`, failing };
}

/** The shipped default template; a repo without vitest skips only when running this one. */
export const DEFAULT_VERIFY = "npx vitest related --run {files}";

/** Hint lines printed under a failed check. */
export function failureHints(r: RelatedResult, mergeCommit: string): string[] {
  return [...r.failing.map((f) => `  failing: ${f}`), `  revert with: git revert -m 1 ${mergeCommit}`];
}
