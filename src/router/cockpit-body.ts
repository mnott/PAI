/**
 * cockpit-body.ts — the one JSON body reader behind every cockpit POST route.
 * It resolves to a plain object or rejects with BadBodyError, so no handler
 * ever destructures `null`, an array or a number.
 */

export class BadBodyError extends Error {}

/** Parse request text as a JSON object ("" is `{}`); anything else is a BadBodyError. */
export function parseJsonObject(raw: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    throw new BadBodyError("body is not valid JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadBodyError("body must be a JSON object");
  return v as Record<string, unknown>;
}

/** Read a request body (via `readBody`) and parse it as a JSON object. */
export function readJsonObject<R>(readBody: (req: R) => Promise<string>, req: R): Promise<Record<string, unknown>> {
  return readBody(req).then(parseJsonObject);
}

/** Status for a body-read failure: 400 for a bad body (or oversize), else 500. */
export function bodyErrorStatus(e: unknown): number {
  return e instanceof BadBodyError || (e instanceof Error && e.message === "body too large") ? 400 : 500;
}
