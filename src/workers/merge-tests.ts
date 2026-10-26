/**
 * merge-tests.ts — the verify check `pai worker merge` runs after a
 * successful merge: the configured command (default: a typecheck). The repo
 * keeps only the governed core in tests/KEPT.md. A failure reverts the merge like the other gates.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_VERIFY_TIMEOUT_SEC = 600;

export interface RelatedSettings {
  /** Command run in the checkout; empty = off. */
  verify: string;
  verifyTimeoutSec: number;
}

export interface RelatedResult {
  status: "passed" | "failed" | "skipped";
  /** The one line printed and recorded in the ledger. */
  line: string;
  failing: string[];
  flakyLogs?: string[];
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

/** Run the verify command for the merge `oldHead..HEAD`; never throws. */
export function runRelatedTests(
  cwd: string,
  oldHead: string,
  settings: RelatedSettings,
  git: (cwd: string, args: string[]) => string,
  pipeGraceMs?: number,
  runner: typeof runCommands = runCommands
): RelatedResult {
  const skip = (why: string): RelatedResult => ({ status: "skipped", line: `verify: skipped (${why})`, failing: [] });
  if (!settings.verify.trim()) return skip("workers.merge.verify is empty");
  try {
    if (!changedFiles(cwd, oldHead, git).length) return skip("nothing changed in the merge");
  } catch (e) {
    return skip(`cannot list changed files: ${(e as Error).message.split("\n")[0]}`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TMUX", "TMUX_PANE", "PAI_WORKER", "PAI_WORKER_ORCHESTRATOR"]) delete env[k];
  const timeoutSec = settings.verifyTimeoutSec > 0 ? settings.verifyTimeoutSec : DEFAULT_VERIFY_TIMEOUT_SEC;
  const r = runner(cwd, env, [settings.verify], timeoutSec, pipeGraceMs);
  if (r.timedOut) return { status: "failed", line: `timed out after ${timeoutSec}s`, failing: [] };
  if (r.code === 0 && !r.signal && !r.error) return { status: "passed", line: `passed (${settings.verify})`, failing: [], output: r.output.slice(-20_000) };
  const exit = r.error ? `error: ${r.error.split("\n")[0].slice(0, 200)}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code ?? 1}`;
  const tail = r.output.trim().split("\n").slice(-5).join(" | ").slice(0, 400);
  return { status: "failed", line: `failed (${exit}): ${tail}`, failing: [] };
}

/** The shipped default gate: typecheck plus the kept test core (tests/KEPT.md). */
export const DEFAULT_VERIFY = "npx tsc --noEmit && PAI_VITEST_MAX_WORKERS=2 npx vitest run";

/** Hint lines printed under a failed check. */
export function failureHints(r: RelatedResult, mergeCommit: string): string[] {
  return [...r.failing.map((f) => `  failing: ${f}`), `  revert with: git revert -m 1 ${mergeCommit}`];
}
