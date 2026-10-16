/**
 * slim-profile.ts — what a headless worker loads of the operator's setup.
 *
 * A default `claude -p` run reads the user settings: ~/.claude/CLAUDE.md, the
 * enabled plugins' SessionStart context, every SessionStart/UserPromptSubmit
 * injection (Whispr, caveman, handover...), skills, output style. Measured
 * 2026-10-16 on a "reply OK" worker, roughly a third of the first request.
 * A worker needs none of it, only the PreToolUse guards and its contract.
 *
 * The slim profile drops the user setting source (`--setting-sources
 * project,local`) and passes a generated `--settings` file instead: the user's
 * env/permissions plus only the guard hooks. The project CLAUDE.md stays.
 * Opt out with PAI_WORKER_FULL_PROFILE=1 or by passing your own
 * --settings/--setting-sources.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hook commands kept for a worker; everything else is context or bookkeeping. */
const GUARD_HOOKS = [
  "terminal_guard.py",
  "route-agents-to-worker",
  "block-taskoutput-wait",
  "route-edits-to-worker",
  "security-validator",
  "ztk-auto.sh",
  "caseleaf-warm-builds",
  "block-sleep-poll",
  "worker-guard",
  "worker-path-repair",
  "worker-tool-name-repair",
  "ab-levers",
];

/** The text a worker needs in place of the user CLAUDE.md. */
export const WORKER_BRIEF = [
  "You are a headless worker: do the task in this process, then report.",
  "- Commit or push only if the spec says so; no AI attribution, no --no-verify.",
  "- Keep personal data (names, accounts, home paths) out of code, docs and commits.",
  "- Stay in the working directory; do not touch other checkouts or the user's shell.",
  "- Never sleep-poll: no sleep over 60 s; long jobs run detached and are checked with a bounded wait.",
  "- No screen/osascript automation; no email or messaging.",
  "- Nothing is done without proof: run the tests, show before/after.",
  "- A hook denial is a rule, not a glitch: adjust, do not retry verbatim.",
  "- End with the report format given in the system prompt.",
].join("\n");

const PROVIDER_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

type HookGroup = { matcher?: string; hooks?: Array<{ command?: string }> };

/** The user settings reduced to env, permissions and the guard hooks. */
export function slimSettings(
  user: Record<string, unknown>,
  procEnv: NodeJS.ProcessEnv = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["env", "permissions", "model"]) if (user[k] !== undefined) out[k] = user[k];
  // Settings env overrides the process env, so a provider's endpoint and token
  // (set by the spawner) must not be shadowed by the user's own.
  if (out.env && typeof out.env === "object") {
    const e = { ...(out.env as Record<string, unknown>) };
    for (const k of PROVIDER_KEYS) if (procEnv[k]) delete e[k];
    out.env = e;
  }
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries((user.hooks ?? {}) as Record<string, HookGroup[]>)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => GUARD_HOOKS.some((n) => h.command?.includes(n))) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  out.hooks = hooks;
  // Empty strings switch off Claude Code's Co-Authored-By / "Generated with" lines.
  out.attribution = { commit: "", pr: "" };
  return out;
}

/**
 * Args for the slim profile, or [] when it does not apply (caller brought
 * their own settings, opted out, or there is no user settings file to slim).
 */
export function slimProfileArgs(
  logDir: string,
  wid: string,
  rest: string[],
  env: NodeJS.ProcessEnv = process.env,
  userSettingsPath = join(homedir(), ".claude", "settings.json"),
): string[] {
  if (env.PAI_WORKER_FULL_PROFILE === "1") return [];
  if (rest.some((a) => a === "--settings" || a.startsWith("--settings=") || a.startsWith("--setting-sources"))) return [];
  if (!existsSync(userSettingsPath)) return [];
  let user: Record<string, unknown>;
  try {
    user = JSON.parse(readFileSync(userSettingsPath, "utf8"));
  } catch {
    return [];
  }
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${wid}.settings.json`);
  writeFileSync(path, JSON.stringify(slimSettings(user, env), null, 2) + "\n", "utf8");
  return ["--setting-sources", "project,local", "--settings", path];
}
