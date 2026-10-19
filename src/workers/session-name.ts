/**
 * session-name.ts — the one place that decides which session profile applies:
 * the name `pai` exported at launch, else the persistent name the picker shows
 * (AIBroker registry by iTerm pane, bridged to the claude session id; then the
 * transcript's customTitle), else the project name of the cwd.
 */

import { currentSessionName } from "./session-profile-store.js";
import { AIBROKER_REGISTRY, resolveSession } from "./scope.js";

export interface SessionNameDeps {
  registryPath?: string;
  mapPath?: string;
  projectsDir?: string;
  /** Project name for a directory (default: the registry `pai project list` reads). */
  projectName?: (cwd: string) => Promise<string | undefined>;
  cwd?: string;
}

async function registryProjectName(cwd: string): Promise<string | undefined> {
  try {
    const { detectProject } = await import("../cli/impl/detect.js");
    return (await detectProject(cwd))?.display_name || undefined;
  } catch {
    return undefined;
  }
}

let cached: { key: string; name: string | undefined } | null = null;

/** Env name, else AIBroker/transcript persistent name, else the cwd's project name. Cached per process (per env identity). */
export async function detectSessionName(env: NodeJS.ProcessEnv = process.env, deps: SessionNameDeps = {}): Promise<string | undefined> {
  const fromEnv = currentSessionName(env);
  if (fromEnv) return fromEnv;
  const cwd = deps.cwd ?? process.cwd();
  const key = [env.ITERM_SESSION_ID, env.CLAUDE_CODE_SESSION_ID, cwd, deps.registryPath, deps.mapPath, deps.projectsDir].join("|");
  if (cached?.key === key) return cached.name;

  let name: string | undefined;
  const registry = deps.registryPath ?? AIBROKER_REGISTRY;
  const claudeId = env.CLAUDE_CODE_SESSION_ID?.trim();
  const { loadBrokerNames, transcriptCustomTitle } = await import("../cli/lib/session-scan.js");
  name =
    resolveSession(env.ITERM_SESSION_ID ?? "", registry)?.name ??
    (claudeId ? loadBrokerNames(registry, deps.mapPath).get(claudeId) ?? transcriptCustomTitle(claudeId, deps.projectsDir) : undefined) ??
    (await (deps.projectName ?? registryProjectName)(cwd));
  cached = { key, name };
  return name;
}

/** Test hook: forget the per-process cache. */
export function resetDetectedSessionName(): void {
  cached = null;
}
