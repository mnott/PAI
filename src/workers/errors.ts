/**
 * errors.ts — PAI's one error shape, the UHP error envelope body
 * ({type, code, message, param, detail}). UHP codes are used as they are;
 * PAI-only conditions carry the vendor prefix `pai_` (UHP errors.md: vendor
 * codes need a prefix). An unknown code is treated as its `type`.
 */

import { UHP_ERROR_CODES, type UhpErrorCode } from "./uhp-vocab.js";

export { UHP_ERROR_CODES };

export type PaiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "harness_error"
  | "server_error";

export const PAI_ERROR_CODES = [
  "pai_loop_stopped",
  "pai_merge_conflict",
  "pai_spec_conflict",
  "pai_malformed_tool_call",
  "pai_degenerate_answer",
  "pai_parent_gone",
  "pai_external_signal",
  "pai_idempotency_conflict",
] as const;
export type PaiVendorCode = (typeof PAI_ERROR_CODES)[number];
export type PaiErrorCode = UhpErrorCode | PaiVendorCode;

export interface PaiError {
  type: PaiErrorType;
  code: string;
  message: string;
  param: string | null;
  detail: Record<string, unknown> | null;
}

const TYPE_OF: Record<string, PaiErrorType> = {
  invalid_input: "invalid_request_error",
  unsupported_protocol_version: "invalid_request_error",
  harness_not_found: "invalid_request_error",
  response_not_found: "invalid_request_error",
  session_not_found: "invalid_request_error",
  file_not_found: "invalid_request_error",
  session_expired: "invalid_request_error",
  harness_mismatch: "invalid_request_error",
  session_busy: "invalid_request_error",
  harness_busy: "invalid_request_error",
  file_too_large: "invalid_request_error",
  model_unavailable: "invalid_request_error",
  unsupported_base: "invalid_request_error",
  pai_idempotency_conflict: "invalid_request_error",
  missing_credential: "authentication_error",
  invalid_credential: "authentication_error",
  insufficient_scope: "permission_error",
  rate_limited: "rate_limit_error",
  quota_exhausted: "rate_limit_error",
  harness_unavailable: "server_error",
  harness_error: "harness_error",
  provider_error: "harness_error",
  timeout: "harness_error",
  cancelled: "harness_error",
  pai_loop_stopped: "harness_error",
  pai_merge_conflict: "harness_error",
  pai_spec_conflict: "harness_error",
  pai_malformed_tool_call: "harness_error",
  pai_degenerate_answer: "harness_error",
  pai_parent_gone: "harness_error",
  pai_external_signal: "harness_error",
};


export function isKnownErrorCode(code: unknown): boolean {
  return typeof code === "string" && code in TYPE_OF;
}

/** The `type` of a code; an unknown code with the vendor prefix is a harness_error, any other unknown one a server_error. */
export function errorTypeOf(code: string): PaiErrorType {
  return TYPE_OF[code] ?? (code.startsWith("pai_") ? "harness_error" : "server_error");
}

export function paiError(code: string, message: string, extra: { param?: string | null; detail?: Record<string, unknown> | null; type?: PaiErrorType } = {}): PaiError {
  return { type: extra.type ?? errorTypeOf(code), code, message, param: extra.param ?? null, detail: extra.detail ?? null };
}

/** Retry table (UHP errors.md §4): worth trying again, here or on another provider. quota_exhausted is never retried. */
export function retriable(code: string): boolean {
  return code === "rate_limited" || code === "harness_unavailable" || code === "provider_error" || code === "timeout" || code === "model_unavailable" || code === "session_busy";
}

/** Each endreason.ts reason as a code; a normal exit has none. */
export function endReasonCode(reason: string | undefined): PaiErrorCode | null {
  switch (reason) {
    case undefined:
    case "exit":
      return null;
    case "deadline":
      return "timeout";
    case "loop-stopped":
      return "pai_loop_stopped";
    case "pai-worker-kill":
    case "client-gone":
      return "cancelled";
    case "parent-gone":
      return "pai_parent_gone";
    case "external-signal":
      return "pai_external_signal";
    case "malformed-tool-call":
      return "pai_malformed_tool_call";
    case "degenerate-answer":
      return "pai_degenerate_answer";
    default:
      return null;
  }
}

/** The PaiError for an ended run (status.error), or null on a normal exit. */
export function endError(reason: string | undefined, note?: string): PaiError | null {
  const code = endReasonCode(reason);
  return code ? paiError(code, note ?? reason ?? code) : null;
}

/** Any thrown value as a PaiError (a PaiError passes through). */
export function toPaiError(e: unknown, fallbackCode = "harness_error"): PaiError {
  if (e && typeof e === "object" && "code" in e && "type" in e && "message" in e) return e as PaiError;
  return paiError(fallbackCode, e instanceof Error ? e.message : String(e));
}

/** Throwable carrying a PaiError. */
export class PaiErrorException extends Error {
  readonly error: PaiError;
  constructor(error: PaiError) {
    super(error.message);
    this.name = "PaiErrorException";
    this.error = error;
  }
}

