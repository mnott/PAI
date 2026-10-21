/**
 * slim-profile.ts — what a headless worker loads of the operator's setup.
 *
 * A default `claude -p` run reads the user settings: ~/.claude/CLAUDE.md, the
 * enabled plugins' SessionStart context, every SessionStart/UserPromptSubmit
 * injection (Whispr, handover...), skills, output style. Measured
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkerProvider } from "./config.js";
import { claudeHomeDir } from "../config/pai-home.js";

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
  "local-model-hint",
  "worker-guard",
  "worker-path-repair",
  "worker-edit-repair",
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

/**
 * The built PostToolUse hook that delivers `pai worker goal` notes: next to
 * this CLI's own dist/hooks (so a build under test delivers with its own
 * hook), else the installed one. null when neither exists.
 */
export function noteHookPath(from: string = fileURLToPath(import.meta.url), claudeDir: string = claudeHomeDir()): string | null {
  for (let dir = dirname(from), i = 0; i < 6; i++, dir = dirname(dir)) {
    const p = join(dir, "hooks", "worker-note.mjs");
    if (existsSync(p)) return p;
  }
  const installed = join(claudeDir, "Hooks", "worker-note.mjs");
  return existsSync(installed) ? installed : null;
}

const PROVIDER_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/**
 * Settings env outranks the process env, so the user's global tuning for the
 * first-party API must not shadow a non-anthropic provider: its own output
 * cap wins (none set: the user's is dropped), the first-party-base-url flag
 * goes, and thinking is switched off (no `thinking`, no effort in the request)
 * unless the provider asks for it.
 */
function applyProviderEnv(e: Record<string, unknown>, provider: WorkerProvider): void {
  const cap = provider.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (cap !== undefined) e.CLAUDE_CODE_MAX_OUTPUT_TOKENS = cap;
  else delete e.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  delete e._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL;
  if (!provider.thinking) {
    e.CLAUDE_CODE_DISABLE_THINKING = "1";
    e.CLAUDE_CODE_EFFORT_LEVEL = "unset";
  }
}

/** The user settings reduced to env, permissions and the guard hooks. */
export function slimSettings(
  user: Record<string, unknown>,
  procEnv: NodeJS.ProcessEnv = {},
  provider?: WorkerProvider,
  noteHook?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["env", "permissions", "model"]) if (user[k] !== undefined) out[k] = user[k];
  // Settings env overrides the process env, so a provider's endpoint and token
  // (set by the spawner) must not be shadowed by the user's own.
  const nonNative = provider !== undefined && !provider.native;
  if ((out.env && typeof out.env === "object") || nonNative) {
    const e = { ...((out.env ?? {}) as Record<string, unknown>) };
    for (const k of PROVIDER_KEYS) if (procEnv[k]) delete e[k];
    if (provider && nonNative) applyProviderEnv(e, provider);
    out.env = e;
  }
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries((user.hooks ?? {}) as Record<string, HookGroup[]>)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => GUARD_HOOKS.some((n) => h.command?.includes(n))) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  // Not a user hook: the worker's own channel for `pai worker goal` notes, for every provider.
  if (noteHook) (hooks.PostToolUse ??= []).push({ matcher: "*", hooks: [{ type: "command", command: noteHook }] });
  out.hooks = hooks;
  // Empty strings switch off Claude Code's Co-Authored-By / "Generated with" lines.
  out.attribution = { commit: "", pr: "" };
  return out;
}

function noteHookCommand(logDir: string): string | undefined {
  const hook = noteHookPath();
  return hook ? `node "${hook}" "${logDir}"` : undefined;
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
  userSettingsPath = join(claudeHomeDir(), "settings.json"),
  provider?: WorkerProvider,
  pin?: { env: Record<string, string> } & Record<string, unknown>,
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
  const slim = slimSettings(user, env, provider, noteHookCommand(logDir));
  // Claude Code honours one --settings only (the last), so the route pin travels inside this file
  if (pin) Object.assign(slim, { ...pin, env: { ...(slim.env as Record<string, unknown> | undefined), ...pin.env } });
  writeFileSync(path, JSON.stringify(slim, null, 2) + "\n", "utf8");
  return ["--setting-sources", "project,local", "--settings", path];
}

/**
 * Settings-file id of a pool slot. The file is read when the slot's claude
 * starts, so slots of different providers must not share one name: the last
 * writer's provider env (or lack of it) would land in every slot.
 */
export function poolSlotSettingsId(providerName: string, model: string): string {
  return `pool-slot-${providerName}-${model}`.replace(/[^A-Za-z0-9._-]/g, "_");
}
