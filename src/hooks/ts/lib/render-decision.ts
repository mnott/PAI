/**
 * The one renderer for PreToolUse decisions. Every PAI guard deny goes through it so the
 * reason carries GUARD_MARKER, which the worker tool-error classifier keys on.
 */

export type GateDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown>; context?: string }
  | { decision: "deny"; reason: string };

/** Prefix of every PAI guard deny reason. */
export const GUARD_MARKER = "PAI guard: ";

/** Render a decision as the JSON the harness reads on the hook's stdout. */
export function renderDecision(d: GateDecision): string {
  if (d.decision === "allow") {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(d.updatedInput && { updatedInput: d.updatedInput }),
        ...(d.context && { additionalContext: d.context }),
      },
    });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: GUARD_MARKER + d.reason,
    },
  });
}
