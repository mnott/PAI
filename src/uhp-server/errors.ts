/**
 * errors.ts — the UHP error envelope and the version constants of the server.
 * Every response, errors included, carries `UHP-Version`; an error body is
 * `{"error":{"type","code","message","param","detail"}}` (errors.md §1).
 */

export const UHP_VERSIONS = ["2026-10-19"] as const;
export const UHP_DEFAULT_VERSION = UHP_VERSIONS[0];

export type UhpErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "harness_error"
  | "server_error";

export class UhpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly type: UhpErrorType,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly detail: Record<string, unknown> | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "UhpHttpError";
  }
}

export const invalidInput = (message: string, param?: string): UhpHttpError =>
  new UhpHttpError(400, "invalid_request_error", "invalid_input", message, param ?? null);

export const notFound = (code: string, message: string): UhpHttpError =>
  new UhpHttpError(404, "invalid_request_error", code, message);

export function errorBody(e: UhpHttpError): { error: { type: string; code: string; message: string; param: string | null; detail: Record<string, unknown> | null } } {
  return { error: { type: e.type, code: e.code, message: e.message, param: e.param, detail: e.detail } };
}

/** What a caller sees of an unexpected failure: no stack, no path, a correlation id the log carries. */
export function internalError(correlationId: string): UhpHttpError {
  return new UhpHttpError(500, "server_error", "server_error", "internal error", null, { correlation_id: correlationId });
}
