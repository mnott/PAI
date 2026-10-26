#!/usr/bin/env node

/**
 * urgency.ts — UserPromptSubmit (interactive sessions)
 *
 * The operator's words decide urgency, not a flag the model remembers: when the
 * prompt asks for "now", "immediately", "asap", "jetzt", ... (as words, outside
 * quotes and code), the session gets an urgency window (workers/urgency.ts) and
 * every worker it starts in that time runs with --now (and --local when the
 * prompt said local) unless it names its own target.
 */

import { readFileSync } from "node:fs";
import { readWorkersSection } from "../../../workers/config.js";
import { DEFAULT_URGENCY_WINDOW_MIN, recordUrgency, urgencyKeys, urgencyOf } from "../../../workers/urgency.js";

function windowMinutes(): number {
  try {
    return readWorkersSection().workers.urgency?.windowMinutes ?? DEFAULT_URGENCY_WINDOW_MIN;
  } catch {
    return DEFAULT_URGENCY_WINDOW_MIN;
  }
}

function main(): void {
  let prompt = "";
  let sessionId: string | undefined;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { prompt?: string; session_id?: string };
    prompt = typeof input.prompt === "string" ? input.prompt : "";
    sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
  } catch {
    return;
  }
  const u = urgencyOf(prompt);
  if (!u.urgent) return;
  const keys = urgencyKeys(process.env, sessionId);
  if (!keys.length) return;
  const min = windowMinutes();
  try {
    recordUrgency(keys, min, u.local);
  } catch {
    return;
  }
  process.stdout.write(`Urgent (operator): workers you start in the next ${min} min run with now${u.local ? ", local" : ""}\n`);
}

main();
