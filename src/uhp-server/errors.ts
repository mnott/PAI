/**
 * UHP error envelope: `{error:{type,code,message,param,detail}}` and the one
 * place a response is written, so `UHP-Version` is on every reply (errors and
 * 404s included).
 */

import type { ServerResponse } from "node:http";

export const UHP_VERSIONS = ["2026-10-19"] as const;
export const UHP_DEFAULT_VERSION = UHP_VERSIONS[0];

export type UhpErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "harness_error"
  | "server_error";

export interface UhpErrorBody {
  error: { type: UhpErrorType; code: string; message: string; param: string | null; detail: Record<string, unknown> | null };
}

export class UhpError extends Error {
  constructor(readonly status: number, readonly body: UhpErrorBody) {
    super(body.error.message);
  }
}

function typeOf(status: number): UhpErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

/** Build an error; `type` defaults from the status (401 authentication_error, 403 permission_error, 429 rate_limit_error, 5xx server_error, else invalid_request_error). */
export function uhpError(
  status: number,
  type: UhpErrorType | null,
  code: string,
  message: string,
  param: string | null = null,
  detail: Record<string, unknown> | null = null
): UhpError {
  return new UhpError(status, { error: { type: type ?? typeOf(status), code, message, param, detail } });
}

export function unsupportedVersion(requested: string): UhpError {
  return uhpError(400, null, "unsupported_protocol_version", `UHP version ${requested} is not supported`, "UHP-Version", {
    supported: [...UHP_VERSIONS],
  });
}

/** Write a JSON reply with the UHP-Version header; `version` is the one served. */
export function sendJson(res: ServerResponse, status: number, body: unknown, version: string = UHP_DEFAULT_VERSION): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "uhp-version": version,
    "cache-control": "no-store",
  });
  res.end(text);
}

export function sendError(res: ServerResponse, e: UhpError, version?: string): void {
  sendJson(res, e.status, e.body, version);
}
