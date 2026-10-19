/**
 * session-workers-hint.ts — hook-safe "this session's workers" line. A leaf: only
 * the profile store and the env, so the hook bundle stays off the CLI/router/memory
 * graph. It names the configured target; fallback under exhaustion is `pai worker`'s
 * job (sessionWorkersLine in session-profile.ts runs the full resolver).
 */

import { BATCH_ENV, currentSessionName, getProfile } from "./session-profile-store.js";

const PROVIDER_ENV = "PAI_SESSION_WORKER_PROVIDER";

export function sessionWorkersHint(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const name = currentSessionName(env);
    if (!name) return null;
    const target = getProfile(name)?.workers ?? (env[PROVIDER_ENV]?.trim() ? { provider: env[PROVIDER_ENV]!.trim(), model: undefined } : undefined);
    if (!target) return `this session's workers: global routing`;
    const model = target.model && target.model !== "default" ? ` ${target.model}` : "";
    return `this session's workers: ${target.provider}${model}${env[BATCH_ENV] === "1" ? " (batch)" : ""}`;
  } catch {
    return null;
  }
}
