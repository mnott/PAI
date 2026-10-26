#!/usr/bin/env node

/**
 * urgency.ts — UserPromptSubmit (interactive sessions)
 *
 * The explicit marker opens the window, never prose: a prompt carrying the
 * literal token `/now` (anywhere in a line) opens the session's urgency window
 * (workers/urgency.ts) for `workers.urgency.windowMinutes` (default 30), and
 * `/now local` also forces where=local. Every worker the session starts in
 * that time runs with --now (and --local) unless it names its own target;
 * workers already running are made urgent here, like `pai worker priority <id>
 * now` (front + preempt the other local workers).
 *
 * The token rule is what makes pasted text safe: the bare word "now" — in a
 * manager report, a log, a description — never arms anything (observed
 * 2026-10-26). Channel/Todoist deliveries ([PAILot], [Inbound:...],
 * [Session:...], [Task...]) count when their text carries the token — every
 * channel ends up as a prompt here — but worker sessions (PAI_WORKER=1) never:
 * a worker's spec is not the operator asking.
 */

import { readWorkersSection } from "../../../workers/config.js";
import { workersLogDir } from "../../../workers/paths.js";
import { loadStatuses, isLive } from "../../../workers/status.js";
import { makeUrgent } from "../../../workers/preempt.js";
import { isLocalProvider, getProviderOrNative } from "../../../workers/config.js";
import { isWorkerSession } from "../lib/worker-session.js";
import { readHookInput } from "../lib/read-stdin.js";
import { DEFAULT_URGENCY_WINDOW_MIN, recordUrgency, urgencyKeys, urgencyOf } from "../../../workers/urgency.js";

function windowMinutes(): number {
  try {
    return readWorkersSection().workers.urgency?.windowMinutes ?? DEFAULT_URGENCY_WINDOW_MIN;
  } catch {
    return DEFAULT_URGENCY_WINDOW_MIN;
  }
}

/** This session's running/queued workers, made urgent like `pai worker priority <id> now`. */
function makeRunningUrgent(local: boolean): number {
  try {
    const { workers } = readWorkersSection();
    const logDir = workersLogDir(workers);
    const sessionKeys = urgencyKeys(process.env);
    let count = 0;
    for (const s of loadStatuses(logDir)) {
      if (!isLive(s) || s.now) continue;
      if (s.spawnerSession && sessionKeys.includes(s.spawnerSession)) {
        const p = getProviderOrNative(workers, s.provider);
        makeUrgent(logDir, s.id, local && !!p && isLocalProvider(p.baseUrl), "urgency-token");
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

interface HookInput {
  prompt?: string;
  session_id?: string;
}

async function main(): Promise<void> {
  if (isWorkerSession()) return;
  const input = await readHookInput<HookInput>();
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const u = urgencyOf(prompt);
  if (!u.urgent) return;
  const keys = urgencyKeys(process.env, input?.session_id);
  if (!keys.length) return;
  const min = windowMinutes();
  try {
    recordUrgency(keys, min, u.local);
  } catch {
    return;
  }
  const made = makeRunningUrgent(u.local);
  process.stdout.write(
    `Urgent (operator /now): workers you start in the next ${min} min run with now${u.local ? ", local" : ""}${made ? ` · ${made} running worker${made > 1 ? "s" : ""} made urgent` : ""}\n`
  );
}

main().catch(() => {});
