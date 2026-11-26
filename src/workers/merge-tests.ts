/**
 * merge-tests.ts — the verify check `pai worker merge` runs after a
 * successful merge: the configured command (default: a typecheck). The repo
 * keeps only the governed core in tests/KEPT.md. A failure reverts the merge like the other gates.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseGateFailure, saveMergeGateLog } from "./gate-log.js";
import { summarizeGateFailure } from "./helper-uses.js";
import { stripApiKey } from "./strip-api-key.js";

export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

export interface RelatedSettings {
  /** Command run in the checkout; empty = off. */
  verify: string;
  verifyTimeoutSec: number;
}

export interface RelatedResult {
  status: "passed" | "failed" | "skipped" | "timeout";
  /** The one line printed and recorded in the ledger. */
  line: string;
  failing: string[];
  flakyLogs?: string[];
  /** First assertion/error line of the first failure (max 400 chars), parsed from the gate output. */
  assert?: string;
  /** Hint lines for a failed gate, e.g. "dist/ is older than src/: run the build first". */
  hints?: string[];
  /** Path of the full gate output kept on disk (<logDir>/<id>.merge-gate-<ts>.log). */
  logPath?: string;
  /** 3-line summary of the failing part from a small local model (which test, file:line, error); absent when it was off or unavailable. */
  summary?: string;
  /** Tail of the gate output, for the test-growth alarm. */
  output?: string;
}

/** Every file the merge changed (any type), from a `git diff --name-only` listing. */
export function changedFiles(cwd: string, oldHead: string, git: (cwd: string, args: string[]) => string): string[] {
  return git(cwd, ["diff", "-z", "--name-only", oldHead, "HEAD"]).split("\0").filter(Boolean);
}

/**
 * Runs shell commands in order and prints one JSON result on stdout. Each
 * command gets its own process group; on timeout the whole group is killed.
 * Stops at the first command that does not exit 0. A command is done on
 * `exit`, not `close`: after a short grace for the last output the pipes
 * are destroyed and the group killed.
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

export interface ResolvedVerify {
  /** Shell command; empty when the repo has nothing runnable. */
  cmd: string;
  /** Runner name printed in the gate output. */
  runner: string;
}

const NODE_RUNNER = /(tsx\b.*\s--test\b|node\s+--test|\bjest\b|\bmocha\b)/;

/**
 * The verify command for one repo: `verify:` in <repo>/.pai/merge.yaml, else a
 * non-default configured command, else the repo's own runner (vitest keeps the
 * shipped default; node:test/jest/mocha run `npm test`; pytest; go), else a
 * typecheck/build only.
 */
export function resolveVerify(cwd: string, configured: string): ResolvedVerify {
  const own = (() => {
    const f = join(cwd, ".pai", "merge.yaml");
    if (!existsSync(f)) return "";
    try {
      const v = (parseYaml(readFileSync(f, "utf8")) as { verify?: unknown } | null)?.verify;
      return typeof v === "string" ? v.trim() : "";
    } catch {
      return "";
    }
  })();
  if (own) return { cmd: own, runner: ".pai/merge.yaml" };
  if (configured.trim() && configured !== DEFAULT_VERIFY) return { cmd: configured, runner: "workers.merge.verify" };
  if (!configured.trim()) return { cmd: "", runner: "off" };
  const tsc = existsSync(join(cwd, "tsconfig.json")) ? "npx tsc --noEmit" : "";
  const join2 = (...c: string[]) => c.filter(Boolean).join(" && ");
  const pkgFile = join(cwd, "package.json");
  if (existsSync(pkgFile)) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    } catch {
      /* unreadable package.json: treated as no runner */
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const test = pkg.scripts?.test ?? "";
    const hasTest = test.trim() !== "" && !/no test specified/.test(test);
    if (/\bvitest\b/.test(test) || (deps.vitest !== undefined && !(hasTest && NODE_RUNNER.test(test)))) return { cmd: DEFAULT_VERIFY, runner: "vitest" };
    if (hasTest) {
      const runner = /(tsx\b.*\s--test\b|node\s+--test)/.test(test) ? "node:test" : (/\bjest\b/.test(test) ? "jest" : /\bmocha\b/.test(test) ? "mocha" : "npm test");
      return { cmd: join2(tsc, "npm test"), runner };
    }
    return { cmd: join2(tsc, pkg.scripts?.build ? "npm run build" : ""), runner: "none (typecheck/build only; no test runner found)" };
  }
  if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "setup.py"))) return { cmd: "python3 -m pytest -q", runner: "pytest" };
  if (existsSync(join(cwd, "go.mod"))) return { cmd: "go test ./...", runner: "go test" };
  const pubspec = join(cwd, "pubspec.yaml");
  if (existsSync(pubspec) && existsSync(join(cwd, "test"))) {
    let flutter = false;
    try {
      const y = parseYaml(readFileSync(pubspec, "utf8")) as { dependencies?: Record<string, unknown> } | null;
      const d = y?.dependencies;
      flutter = !!d && typeof d === "object" && "flutter" in d;
    } catch {
      /* unreadable pubspec: plain dart */
    }
    return flutter ? { cmd: "flutter test", runner: "flutter test" } : { cmd: "dart test", runner: "dart test" };
  }
  return { cmd: "", runner: "none (no package.json, pytest, go.mod or pubspec.yaml with test/; nothing to run)" };
}

/** Run the verify command for the merge `oldHead..HEAD`; never throws. */
export function runRelatedTests(
  cwd: string,
  oldHead: string,
  settings: RelatedSettings,
  git: (cwd: string, args: string[]) => string,
  pipeGraceMs?: number,
  runner: typeof runCommands = runCommands,
  /** Worker log dir: a failure keeps its full output at <logDir>/<id>.merge-gate-<ts>.log. */
  logDir?: string,
  id?: string
): RelatedResult {
  const skip = (why: string): RelatedResult => ({ status: "skipped", line: `verify: skipped (${why})`, failing: [] });
  if (!settings.verify.trim()) return skip("workers.merge.verify is empty");
  const resolved = resolveVerify(cwd, settings.verify);
  if (!resolved.cmd) return skip(`runner: ${resolved.runner}`);
  try {
    if (!changedFiles(cwd, oldHead, git).length) return skip("nothing changed in the merge");
  } catch (e) {
    return skip(`cannot list changed files: ${(e as Error).message.split("\n")[0]}`);
  }
  const env: NodeJS.ProcessEnv = stripApiKey({ ...process.env, NO_COLOR: "1" });
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "PAI_WORKER", "PAI_WORKER_ORCHESTRATOR"]) delete env[k];
  const timeoutSec = settings.verifyTimeoutSec > 0 ? settings.verifyTimeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const r = runner(cwd, env, [resolved.cmd], timeoutSec, pipeGraceMs);
  // a timeout says nothing about the code: it is its own status, never a red suite (the gate must not revert on it)
  if (r.timedOut) return { status: "timeout", line: `verify timed out after ${timeoutSec}s`, failing: [] };
  if (r.code === 0 && !r.signal && !r.error) return { status: "passed", line: `passed (runner: ${resolved.runner}; ${resolved.cmd})`, failing: [], output: r.output.slice(-20_000) };
  const exit = r.error ? `error: ${r.error.split("\n")[0].slice(0, 200)}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code ?? 1}`;
  const tail = r.output.trim().split("\n").slice(-5).join(" | ").slice(0, 400);
  // keep the FULL output (stdout+stderr) on disk and name what failed: the ledger's 300-char
  // summary once left a session three blind fix rounds with no test name and no assertion.
  const f = parseGateFailure(r.output, cwd);
  const logPath = logDir && id ? saveMergeGateLog(logDir, id, r.output) : null;
  // 3 lines from a small local model (null: rules only)
  const summary = summarizeGateFailure(r.output);
  return {
    status: "failed",
    line: `failed (runner: ${resolved.runner}; ${resolved.cmd}) (${exit}): ${tail}`,
    failing: f.names,
    ...(f.assert ? { assert: f.assert } : {}),
    ...(f.hints.length ? { hints: f.hints } : {}),
    ...(logPath ? { logPath } : {}),
    ...(summary ? { summary } : {}),
    output: r.output.slice(-20_000),
  };
}

/** The shipped default gate: typecheck plus the kept test core (tests/KEPT.md). */
export const DEFAULT_VERIFY = "npx tsc --noEmit && PAI_VITEST_MAX_WORKERS=2 npx vitest run";

/** Hint lines printed under a failed check: the kept log, the assertion, stale-build hints, the revert. */
export function failureHints(r: RelatedResult, mergeCommit: string): string[] {
  return [
    ...(r.logPath ? [`  full gate output: ${r.logPath}`] : []),
    ...r.failing.map((f) => `  failing: ${f}`),
    ...(r.assert ? [`  assertion: ${r.assert}`] : []),
    ...(r.summary ? r.summary.split("\n").map((l) => `  summary: ${l}`) : []),
    ...(r.hints ?? []).map((h) => `  hint: ${h}`),
    `  revert with: git revert -m 1 ${mergeCommit}`,
  ];
}
