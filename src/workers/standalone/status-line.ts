#!/usr/bin/env node

/**
 * Standalone worker status-line entry point.
 *
 * statusline-command.sh calls this (argv: <ITERM_SESSION_ID> <PWD> [<claude
 * session id>]) on every status refresh, so it must stay a plain node script
 * with no CLI framework and no daemon IPC: read the config, read the worker
 * statuses, print one line or nothing. With a claude session id it also
 * refreshes the spawner-session map (see scope.ts) and claims the workers
 * that session spawned. Built to dist/worker-status-line.mjs by
 * scripts/build-hooks.mjs and symlinked to ~/.claude/worker-status-line.mjs.
 */

import { readWorkersSection } from "../config.js";
import { workersLogDir } from "../paths.js";
import { recordSessionMapEntry } from "../scope.js";
import { pendingCountCached } from "../pending.js";
import { statusLineOutput } from "../viewer.js";
import { readRoutingState } from "../routing.js";
import { detectSessionName } from "../session-name.js";
import { getProfile, resolveWorkers } from "../session-profile.js";
import { readSessionNameCache, sessionNameCachePath, writeSessionNameCache } from "./session-name-cache.js";
import { readUrgency } from "../urgency.js";

const term = process.argv[2] ?? process.env.ITERM_SESSION_ID ?? "";
const cwd = process.argv[3] ?? process.cwd();
const claudeSession = process.argv[4] ?? "";

/** detectSessionName once per session identity per 5 min, the result in the cache file. */
async function cacheAndReturn(path: string | null): Promise<string | undefined> {
  const name = await detectSessionName();
  writeSessionNameCache(path, name);
  return name;
}

try {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);
  if (claudeSession) recordSessionMapEntry(logDir, cwd, claudeSession, term);
  let out = statusLineOutput(logDir, term, cwd, claudeSession, new Date());
  const unmerged = pendingCountCached(logDir, cwd);
  if (unmerged) out = [out, `⚑${unmerged} unmerged`].filter(Boolean).join(" ");
  // the operator's urgency window (urgency.ts): its workers run with now until the window closes.
  const urgent = readUrgency();
  if (urgent) {
    const d = new Date(urgent.until);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    out = ["⚡now" + (urgent.where === "local" ? " local" : "") + ` until ${hhmm}`, out].filter(Boolean).join(" ");
  }
  // where this session's next worker would run: the same resolver every spawn uses (no live budget poll in the bar).
  // The session name comes from detectSessionName — the one resolver — so a session not started by `pai`
  // (no PAI_SESSION_NAME) still shows its route; its slow paths sit behind a 5-min file cache keyed by
  // ITERM_SESSION_ID/claude session, since this line runs on every prompt.
  const namePath = sessionNameCachePath(logDir, process.env, cwd);
  const sessionName = readSessionNameCache(namePath) ?? (await cacheAndReturn(namePath));
  const r = resolveWorkers({}, { cfg: workers, profile: getProfile(sessionName), env: process.env, budgets: {}, routing: readRoutingState(logDir) });
  if (r.provider) out = [`workers: ${r.provider}${r.model && r.model !== "default" ? `/${r.model}` : ""}`, out].filter(Boolean).join(" ");
  if (out) process.stdout.write(out + "\n");
} catch {
  // no workers section or a broken config: no line, never an error in the bar
}
