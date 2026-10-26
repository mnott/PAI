/**
 * uhp-vocab.ts — the mapping between Unified Harness Protocol (UHP) terms and
 * PAI's own: response status <-> AG2 result character / worker state, the
 * coded error set, and the requested-vs-effective model record.
 */

export type UhpStatus = "completed" | "incomplete" | "failed" | "cancelled";
export type Ag2Result = "+" | "-" | "~" | "?" | "!";
export type WorkerEndState = "done" | "failed" | "killed";

export const UHP_STATUSES: readonly UhpStatus[] = ["completed", "incomplete", "failed", "cancelled"];

/** UHP terminal status -> AG2 `r`: completed + , incomplete ~ , failed - , cancelled ! (killed). */
export function uhpStatusToResult(status: string): Ag2Result {
  switch (status) {
    case "completed":
      return "+";
    case "incomplete":
      return "~";
    case "failed":
      return "-";
    case "cancelled":
      return "!";
    default:
      return "?";
  }
}

/** AG2 `r` -> UHP status (the reverse; "?" has no UHP equivalent and maps to incomplete). */
export function resultToUhpStatus(r: Ag2Result): UhpStatus {
  switch (r) {
    case "+":
      return "completed";
    case "-":
      return "failed";
    case "!":
      return "cancelled";
    default:
      return "incomplete";
  }
}

/** WorkerStatus.state -> UHP status (done -> completed, killed -> cancelled, failed/lost -> failed). */
export function workerStateToUhpStatus(state: string): UhpStatus {
  if (state === "done") return "completed";
  if (state === "killed") return "cancelled";
  return "failed";
}

/** UHP terminal status -> the WorkerStatus state a finished run lands in. */
export function uhpStatusToState(status: string): WorkerEndState {
  const r = uhpStatusToResult(status);
  if (r === "+" || r === "~") return "done";
  return r === "!" ? "killed" : "failed";
}

/** Coded errors PAI shares with UHP; ledger and escalation reasons use these names. */
export const UHP_ERROR_CODES = [
  "timeout",
  "cancelled",
  "provider_error",
  "harness_unavailable",
  "model_unavailable",
  "rate_limited",
  "quota_exhausted",
  "session_busy",
  "session_expired",
  "response_not_found",
  "harness_mismatch",
  "harness_not_found",
  "missing_credential",
  "invalid_credential",
  "unsupported_protocol_version",
] as const;
export type UhpErrorCode = (typeof UHP_ERROR_CODES)[number];

export function isUhpErrorCode(code: unknown): code is UhpErrorCode {
  return typeof code === "string" && (UHP_ERROR_CODES as readonly string[]).includes(code);
}

/** The ledger reason for an error code: the code itself when known, else "provider_error". */
export function uhpErrorReason(code: unknown): UhpErrorCode {
  return isUhpErrorCode(code) ? code : "provider_error";
}

/** Error codes where trying another provider can help (escalation / fallback candidates). */
export function uhpErrorRetriable(code: UhpErrorCode): boolean {
  return code === "rate_limited" || code === "quota_exhausted" || code === "model_unavailable" || code === "harness_unavailable";
}

/** Model record fields for a worker status. */
export interface ModelRecord {
  requestedModel?: string;
  modelFallback?: boolean;
  modelFallbackReason?: string;
}

/**
 * requested_model / model_fallback(+reason) for a status: set only when the
 * effective model differs from the requested one. `reason` is why PAI (or the
 * harness) used another model.
 */
export function modelRecord(requested: string | undefined, effective: string | undefined, reason?: string): ModelRecord {
  if (!requested || !effective || requested === effective) return {};
  return { requestedModel: requested, modelFallback: true, ...(reason ? { modelFallbackReason: reason } : {}) };
}
