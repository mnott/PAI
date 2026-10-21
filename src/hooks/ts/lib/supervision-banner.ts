/**
 * supervision-banner.ts — SessionStart text telling a session it is supervised.
 *
 * Tool descriptions are forgotten at compaction; the AIBroker watcher entry in
 * managers.json is the ground truth, so the harness re-injects it on startup
 * and after every compact. Silent (null) whenever there is no live entry.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { itermUuid } from "../../../workers/scope.js";
import { resolveHostSession } from "../../../workers/pane.js";

interface Manager {
  sessionId?: string;
  objective?: string;
  paused?: boolean;
  shift?: { until?: number };
}

export const MANAGERS_PATH = join(homedir(), ".aibroker", "managers.json");

/** The calling session's iTerm uuid: ITERM_SESSION_ID when set, else the pane host resolver (background-daemon sessions). */
export async function callerItermId(
  env: NodeJS.ProcessEnv,
  resolve: () => Promise<{ uid: string }> = () => resolveHostSession(env),
): Promise<string> {
  const fromEnv = itermUuid(env.ITERM_SESSION_ID ?? "");
  if (fromEnv) return fromEnv;
  try {
    return (await resolve()).uid;
  } catch {
    return "";
  }
}

export function supervisionBanner(itermId: string, managersPath: string = MANAGERS_PATH, now: number = Date.now()): string | null {
  if (!itermId) return null;
  try {
    const all = JSON.parse(readFileSync(managersPath, "utf8")) as Record<string, Manager>;
    const m = Object.values(all).find((e) => e && typeof e.sessionId === "string" && itermUuid(e.sessionId) === itermId);
    const until = m?.shift?.until;
    if (!m || m.paused || typeof until !== "number" || until <= now) return null;
    const d = new Date(until);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const objective = (m.objective ?? "").slice(0, 120);
    return [
      `SUPERVISION ACTIVE until ${hhmm} (this survives compaction — it is your ground truth, not memory). Objective: ${objective}.`,
      "To re-arm NOW after a lapse: run `aibroker arm-self` — no arguments, it reads this watcher and forces the arm; safe mid-turn.",
      "NEVER ask the operator to type /goal or arm anything for you.",
    ].join("\n");
  } catch {
    return null;
  }
}

export async function supervisionBannerForSession(env: NodeJS.ProcessEnv): Promise<string | null> {
  return supervisionBanner(await callerItermId(env));
}
