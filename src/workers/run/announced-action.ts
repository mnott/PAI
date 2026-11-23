/**
 * A final assistant text that only announces an action ("I'll start by reading the tasks file.") with no tool call.
 * Claude Code takes it as the final answer and the run ends. Forms come from antipatterns/final-text/announced-no-action.yaml.
 */

import { activeAntipattern } from "../../hooks/ts/lib/antipatterns.js";
import { dispositionOf } from "../../hooks/ts/lib/antipattern-lifecycle.js";

interface Params {
  max_chars: number;
  max_per_run: number;
  starts: string;
  report: string;
}

/** Does the text announce an action and stop there? */
export function announcesAction(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const p = activeAntipattern("announced-no-action").detector.params as unknown as Params;
  if (t.length > p.max_chars) return false;
  if (new RegExp(p.report).test(t)) return false;
  return new RegExp(p.starts, "i").test(t);
}

/** The continuation to run now, or null: the text announces an action, the pattern is on, the run has tools and the per-run cap is not used up. */
export function announcedActionDecision(text: string | undefined, done: number, hasTools: boolean): { mode: "enforce" | "monitor"; version: number; message: string } | null {
  if (!hasTools || !announcesAction(text)) return null;
  const ap = activeAntipattern("announced-no-action");
  if (done >= (ap.detector.params as unknown as Params).max_per_run) return null;
  const mode = dispositionOf(ap, text ?? "", process.env);
  return mode === "off" ? null : { mode, version: ap.version, message: ap.message };
}
