/**
 * merge-tests.ts — the related-tests check `pai worker merge` runs after a
 * successful merge: every test that imports a source file the merge changed
 * (`vitest related`), so a worker that reverses a codified rule is caught at
 * merge time, not by the full suite later. A failure never reverts the merge;
 * the operator decides.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

export interface RelatedSettings {
  /** Command template with `{files}`; empty = off. */
  verify: string;
  verifyTimeoutSec: number;
  /** Repo-guard test paths/globs (config `workers.merge.alwaysTests`), appended to every run. */
  alwaysTests?: string[];
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

/** A config glob matched against repo-relative paths (`**` crosses directories). */
function globMatches(glob: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; continue; }
    if (c === "*") { re += "[^/]*"; continue; }
    if (c === "?") { re += "[^/]"; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

/**
 * The always-tests entries expanded against the checkout: literal paths that
 * exist, globs matched against every tracked `*.test.*`. Deduped, sorted;
 * entries matching nothing are skipped (the caller notes them).
 */
export function resolveAlwaysTests(cwd: string, entries: string[]): { files: string[]; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  let testFiles: string[] | null = null;
  const allTestFiles = (): string[] => {
    if (testFiles === null) testFiles = trackedTestFiles(cwd);
    return testFiles;
  };
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!entry.includes("*") && !entry.includes("?")) {
      if (existsSync(join(cwd, entry))) files.add(entry);
      else missing.push(entry);
      continue;
    }
    const hits = allTestFiles().filter((f) => globMatches(entry, f));
    if (hits.length) hits.forEach((f) => files.add(f));
    else missing.push(entry);
  }
  return { files: [...files].sort(), missing };
}

/** Every tracked `*.test.*` file in the repo at `cwd`, repo-relative; [] if git fails. */
function trackedTestFiles(cwd: string): string[] {
  try {
    const r = spawnSync("git", ["ls-files", "--", "*.test.ts", "*.test.tsx", "*.test.mjs"], { cwd, encoding: "utf8", timeout: 15_000 });
    if (r.status !== 0) return [];
    return r.stdout.split("\n").filter(Boolean).sort();
  } catch {
    return [];
  }
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
  const always = resolveAlwaysTests(cwd, settings.alwaysTests ?? []);
  const run = [...files, ...always.files];
  const note = always.missing.length ? ` (always-tests skipped: ${always.missing.join(", ")})` : "";
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "PAI_WORKER", "PAI_WORKER_ORCHESTRATOR"]) delete env[k];
  const timeoutSec = settings.verifyTimeoutSec > 0 ? settings.verifyTimeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const r = spawnSync("sh", ["-c", buildRelatedCommand(settings.verify, run)], {
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
    const counts = always.files.length ? `${files.length} source files + ${always.files.length} always-tests, passed` : `${files.length} source files, passed`;
    return { status: "passed", line: `related tests: ${passSummary(output) ?? counts}${note}`, failing: [] };
  }
  const failing = failingFiles(output);
  const why = failing.length ? `failed: ${failing.join(", ")}` : `failed (exit ${r.status ?? 1})`;
  return { status: "failed", line: `related tests: ${why}${note}`, failing };
}

/** The shipped default template; a repo without vitest skips only when running this one. */
export const DEFAULT_VERIFY = "npx vitest related --run {files}";

/** Hint lines printed under a failed check. */
export function failureHints(r: RelatedResult, mergeCommit: string): string[] {
  return [...r.failing.map((f) => `  failing: ${f}`), `  revert with: git revert -m 1 ${mergeCommit}`];
}
