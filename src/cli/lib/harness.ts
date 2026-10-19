/**
 * The command line that starts the Claude Code harness on a provider.
 *
 * This is the one builder behind `pai open`, `pai new` and (later) every
 * other launcher. The env, --settings pin, --model and extra arguments come
 * from buildLaunchPlan (src/workers/launch.ts) — the same code the old
 * `pai launch` runs — so the two cannot differ. Nothing here shells out to a
 * second `pai`.
 */

import { spawnSync } from "node:child_process";
import { buildLaunchPlan, maskLaunchEnv, type LaunchPlan } from "../../workers/launch.js";
import type { WorkersConfig } from "../../workers/config.js";
import { workersLogDir, ledgerPath } from "../../workers/paths.js";
import { appendLedger } from "../../workers/ledger.js";
import { printExitDir } from "./exit-dir.js";

export interface Harness {
  cmd: "claude";
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  provider: string;
  model: string;
}

/** `--name N "/Name N"`: label the session and tab (same as launchPrompt in lib/launch.ts). `named`: the session already carries N, so no /Name is sent. */
export const nameArgs = (name: string, named = false): string[] => (named ? ["--name", name] : ["--name", name, `/Name ${name}`]);

export async function buildHarness(
  workers: Pick<WorkersConfig, "providers" | "nativeModels" | "logDir">,
  opts: { provider: string; model?: string; cwd: string; resume?: string; name: string; named?: boolean }
): Promise<Harness> {
  const extra = [...(opts.resume ? ["--resume", opts.resume] : []), ...nameArgs(opts.name, opts.named)];
  const plan: LaunchPlan = await buildLaunchPlan(workers, opts.provider, opts.model, extra, workersLogDir(workers));
  return { cmd: "claude", argv: plan.argv, env: plan.env, cwd: opts.cwd, provider: plan.providerName, model: plan.model };
}

const quote = (a: string) => (/[\s"'$`\\{}]/.test(a) ? JSON.stringify(a) : a);

/** The exec line for --dry-run. The auth token is inside the --settings JSON, so it is masked here too. */
export function execLine(h: Harness): string {
  const token = h.env.ANTHROPIC_AUTH_TOKEN;
  const masked = token ? maskLaunchEnv({ ANTHROPIC_AUTH_TOKEN: token }).ANTHROPIC_AUTH_TOKEN : undefined;
  const hide = (a: string) => (token && masked ? a.split(token).join(masked) : a);
  return `cd ${quote(h.cwd)} && ${h.cmd} ${h.argv.map((a) => quote(hide(a))).join(" ")}`;
}

export function dryRunText(h: Harness): string {
  const masked = maskLaunchEnv(h.env);
  const env = Object.keys(masked)
    .sort()
    .filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|ENABLE_TOOL_SEARCH|PAI_WORKER|PAI_SESSION_)/.test(k))
    .map((k) => `  ${k}=${masked[k]}`);
  return [execLine(h), ...(env.length ? ["env:", ...env] : [])].join("\n");
}

/** Run the harness in the foreground; returns its exit code. */
export function execHarness(h: Harness, workers: Pick<WorkersConfig, "logDir">): number {
  appendLedger(ledgerPath(workersLogDir(workers)), "LAUNCH-START", {
    kind: "launch",
    provider: h.provider,
    model: h.model,
    cwd: h.cwd,
  });
  const r = spawnSync(h.cmd, h.argv, { stdio: "inherit", env: h.env, cwd: h.cwd });
  if (r.error) throw new Error(`could not start claude: ${r.error.message}`);
  printExitDir(h.cwd);
  return r.status ?? 0;
}
