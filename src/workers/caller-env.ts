/**
 * caller-env.ts — the PATH a daemon-side (re)spawn of a worker runs with.
 *
 * The PAI daemon runs under launchd with a minimal PATH, so a worker it restarts (reroute, escalation, MCP
 * worker_run) lost /opt/homebrew/bin and failed with "gh: command not found" (2026-10-26). A run records the
 * PATH of the process that started it (status.callerPath); a restart uses that, else the user's login-shell
 * PATH resolved once. Only PATH is carried: nothing secret is ever recorded.
 */

import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";

let loginPath: string | null | undefined;

/** The login shell's PATH, resolved once per process; null when the shell gives none. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (loginPath !== undefined) return loginPath;
  loginPath = null;
  try {
    const r = spawnSync(env.SHELL || "/bin/zsh", ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const out = (r.stdout ?? "").trim();
    if (r.status === 0 && out) loginPath = out;
  } catch {
    /* no login shell: keep the base PATH */
  }
  return loginPath;
}

/** `a` entries first, then those of `b` it lacks. */
function mergePaths(a: string, b: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...a.split(delimiter), ...b.split(delimiter)]) {
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(delimiter);
}

/**
 * `base` with the PATH a restart must run under: the recorded caller PATH when there is one, else the base PATH
 * extended with the login shell's. Returns a copy.
 */
export function withCallerPath(base: NodeJS.ProcessEnv, recorded?: string, login: () => string | null = () => loginShellPath(base)): NodeJS.ProcessEnv {
  const env = { ...base };
  if (recorded) env.PATH = recorded;
  else {
    const l = login();
    if (l) env.PATH = mergePaths(base.PATH ?? "", l);
  }
  return env;
}
