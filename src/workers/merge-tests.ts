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

/** Every file the merge changed (any type), from a `git diff --name-only` listing. */
export function changedFiles(cwd: string, oldHead: string, git: (cwd: string, args: string[]) => string): string[] {
  return git(cwd, ["diff", "-z", "--name-only", oldHead, "HEAD"]).split("\0").filter(Boolean);
}

export function changedSourceFiles(cwd: string, oldHead: string, git: (cwd: string, args: string[]) => string): string[] {
  return filterSourceFiles(changedFiles(cwd, oldHead, git));
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A name starting with `-` would reach the test runner as an option. */
const operand = (f: string): string => (f.startsWith("-") ? `./${f}` : f);

/** The template with `{files}` replaced by the shell-quoted file list (verbatim: `$&` in a name is not a replacement pattern). */
export function buildRelatedCommand(template: string, files: string[]): string {
  const list = files.map((f) => shq(operand(f))).join(" ");
  return template.replace(/\{files\}/g, () => list);
}

/** Files per command line, far below any argv limit (E2BIG). */
export const FILES_PER_COMMAND = 100;

/**
 * Runs shell commands in order and prints one JSON result on stdout. Each
 * command gets its own process group; on timeout the whole group is killed,
 * so the test tree (npx, node, workers) cannot outlive the check. Stops at
 * the first command that does not exit 0. Input arrives on stdin (it can be
 * larger than an env var or argv allows). A command is done on `exit`, not
 * `close`: a background process still holding the pipes would otherwise pin
 * a passing run until the timeout; after a short grace for the last output
 * the pipes are destroyed and the group killed.
 */
const RUNNER = `
const { spawn } = require("node:child_process");
const GRACE_MS = process.env.PAI_VERIFY_PIPE_GRACE_MS ? Number(process.env.PAI_VERIFY_PIPE_GRACE_MS) : 500;
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  const { cmds, timeoutMs } = JSON.parse(raw);
  const deadline = Date.now() + timeoutMs;
  let output = "";
  const res = { code: 0, signal: null, timedOut: false, error: null };
  for (const cmd of cmds) {
    const left = deadline - Date.now();
    if (left <= 0) { res.timedOut = true; break; }
    const r = await new Promise((done) => {
      const c = spawn("sh", ["-c", cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let to = false;
      const t = setTimeout(() => { to = true; try { process.kill(-c.pid, "SIGKILL"); } catch {} }, left);
      c.stdout.on("data", (d) => (output += d));
      c.stderr.on("data", (d) => (output += d));
      c.on("error", (e) => { clearTimeout(t); done({ code: 1, signal: null, to, error: String(e.message || e) }); });
      c.on("exit", (code, signal) => {
        clearTimeout(t);
        setTimeout(() => {
          c.stdout.destroy(); c.stderr.destroy();
          try { process.kill(-c.pid, "SIGKILL"); } catch {}
          done({ code, signal, to, error: null });
        }, GRACE_MS);
      });
    });
    if (r.to) { res.timedOut = true; break; }
    if (r.error) { res.error = r.error; res.code = 1; break; }
    if (r.code !== 0) { res.code = r.code; res.signal = r.signal; break; }
  }
  process.stdout.write(JSON.stringify({ ...res, output }));
});
`;

interface RunOutcome {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  output: string;
}

function runCommands(cwd: string, env: NodeJS.ProcessEnv, cmds: string[], timeoutSec: number, pipeGraceMs?: number): RunOutcome {
  const r = spawnSync(process.execPath, ["-e", RUNNER], {
    cwd,
    env: pipeGraceMs ? { ...env, PAI_VERIFY_PIPE_GRACE_MS: String(pipeGraceMs) } : env,
    input: JSON.stringify({ cmds, timeoutMs: timeoutSec * 1000 }),
    encoding: "utf8",
    timeout: timeoutSec * 1000 + 30_000, // backstop; the runner enforces the real limit
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout) as RunOutcome;
  } catch {
    return { code: 1, signal: r.signal, timedOut: false, error: r.error?.message ?? `runner exited ${r.status}`, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  }
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

/** "14 files, 212 passed" summed over every vitest summary line (chunked runs print one per command), or null. */
export function passSummary(output: string): string | null {
  const text = stripAnsi(output);
  let files = 0;
  let tests = 0;
  let seen = false;
  for (const m of text.matchAll(/Test Files\s+(?:.*?,\s*)?(\d+) passed/g)) { files += Number(m[1]); seen = true; }
  for (const m of text.matchAll(/Tests\s+(?:.*?,\s*)?(\d+) passed/g)) { tests += Number(m[1]); seen = true; }
  if (!seen) {
    const f = /Test Files\s+(\d+)/.exec(text);
    if (f) return `${f[1]} files`;
    return null;
  }
  return `${files} files, ${tests} passed`;
}

/** Run the related tests for the merge `oldHead..HEAD`; never throws. */
export function runRelatedTests(
  cwd: string,
  oldHead: string,
  settings: RelatedSettings,
  git: (cwd: string, args: string[]) => string,
  /** Test hook: shorten the runner's pipe-drain grace. */
  pipeGraceMs?: number
): RelatedResult {
  const skip = (why: string): RelatedResult => ({ status: "skipped", line: `related tests: skipped (${why})`, failing: [] });
  if (!settings.verify.trim()) return skip("workers.merge.verify is empty");
  if (!hasVitest(cwd) && settings.verify === DEFAULT_VERIFY) return skip("no vitest in package.json devDependencies");
  let all: string[];
  try {
    all = changedFiles(cwd, oldHead, git);
  } catch (e) {
    return skip(`cannot list changed files: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!all.length) return skip("nothing changed in the merge");
  // Any change runs the always-tests (a docs-only merge still needs the repo
  // guards); `vitest related` runs only when source files changed.
  const files = filterSourceFiles(all);
  const always = resolveAlwaysTests(cwd, settings.alwaysTests ?? []);
  if (!files.length && !always.files.length) return skip("no source files changed, no always-tests configured");
  const run = [...files, ...always.files];
  const skipped = files.length ? "" : "related tests: skipped (no source change); always-tests: ";
  const note = always.missing.length ? ` (always-tests skipped: ${always.missing.join(", ")})` : "";
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "PAI_WORKER", "PAI_WORKER_ORCHESTRATOR"]) delete env[k];
  const timeoutSec = settings.verifyTimeoutSec > 0 ? settings.verifyTimeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const cmds: string[] = [];
  for (let i = 0; i < run.length; i += FILES_PER_COMMAND) cmds.push(buildRelatedCommand(settings.verify, run.slice(i, i + FILES_PER_COMMAND)));
  const r = runCommands(cwd, env, cmds, timeoutSec, pipeGraceMs);
  const output = r.output;
  if (r.timedOut) {
    return { status: "failed", line: `${skipped}timed out after ${timeoutSec}s`, failing: [] };
  }
  if (r.code === 0 && !r.signal && !r.error) {
    const counts = always.files.length ? `${files.length} source files + ${always.files.length} always-tests, passed` : `${files.length} source files, passed`;
    // No vitest summary (a custom verify command): name the files that ran.
    const summary = passSummary(output) ?? (files.length ? counts : `${always.files.length} files, passed`);
    return { status: "passed", line: `${skipped}${summary}${note}`, failing: [] };
  }
  const failing = failingFiles(output);
  const exit = r.error ? `error: ${r.error.split("\n")[0].slice(0, 200)}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code ?? 1}`;
  const why = failing.length ? `failed: ${failing.join(", ")}` : `failed (${exit})`;
  return { status: "failed", line: `${skipped}${why}${note}`, failing };
}

/** The shipped default template; a repo without vitest skips only when running this one. */
export const DEFAULT_VERIFY = "npx vitest related --run {files}";

/** Hint lines printed under a failed check. */
export function failureHints(r: RelatedResult, mergeCommit: string): string[] {
  return [...r.failing.map((f) => `  failing: ${f}`), `  revert with: git revert -m 1 ${mergeCommit}`];
}
