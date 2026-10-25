/**
 * loop-guard-telemetry.ts — firing records and candidates for a loop-guard step.
 *
 * Called by the hooks that run the guard (PreToolUse worker-guard, PostToolUse worker-note). A step that carries a
 * pattern id is recorded (enforce, or monitor when the pattern is monitored); a deny or stop no pattern covers
 * becomes a candidate file for review.
 */

import { activeAntipattern } from "./antipatterns.js";
import { recordFiring, writeCandidate } from "./antipattern-log.js";
import type { LoopStep } from "./loop-guard.js";

export function recordLoopTelemetry(r: LoopStep, ctx: { cwd?: string; sessionId?: string; fallbackText: string }): void {
  try {
    const text = r.key ?? ctx.fallbackText;
    if (r.id && (r.monitored || r.deny || r.note)) {
      const ap = activeAntipattern(r.id);
      recordFiring({
        id: r.id,
        version: ap.version,
        category: ap.category,
        action: r.monitored ? r.monitored.action : r.stop ? "stop" : r.deny ? "deny" : "note",
        mode: r.monitored ? "monitor" : "enforce",
        input: text,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
      });
    } else if (!r.id && r.deny) {
      writeCandidate({ category: "tool-loop", action: r.stop ? "stop" : "deny", message: r.reason ?? "", input: text });
    }
  } catch {
    /* telemetry never fails the guard */
  }
}
