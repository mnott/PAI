/**
 * auth.ts — bearer tokens for the UHP server. The tokens file holds sha256
 * hashes only; the raw token is shown once by `pai uhp token create`. Unknown
 * and revoked tokens fail with the same body (security.md: no enumeration).
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../config/atomic-file.js";
import { UhpHttpError } from "./errors.js";

export interface TokenRecord {
  /** Public id of the token (the principal objects are scoped to). */
  id: string;
  name: string;
  hash: string;
  createdAt: string;
  revoked?: boolean;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function readTokens(path: string): TokenRecord[] {
  if (!existsSync(path)) return [];
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { tokens?: TokenRecord[] };
    return Array.isArray(j.tokens) ? j.tokens : [];
  } catch {
    return [];
  }
}

function writeTokens(path: string, tokens: TokenRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ tokens }, null, 2) + "\n");
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/** Mint a token; returns the raw value (never stored) and its record. */
export function createToken(path: string, name: string, now = new Date()): { token: string; record: TokenRecord } {
  const token = `uhp_${randomBytes(24).toString("hex")}`;
  const record: TokenRecord = { id: `tok_${randomBytes(6).toString("hex")}`, name, hash: sha256(token), createdAt: now.toISOString() };
  writeTokens(path, [...readTokens(path), record]);
  return { token, record };
}

/** Revoke by id or name; true when a live token matched. Takes effect on the next request. */
export function revokeToken(path: string, idOrName: string): boolean {
  const all = readTokens(path);
  let hit = false;
  for (const t of all) {
    if (!t.revoked && (t.id === idOrName || t.name === idOrName)) {
      t.revoked = true;
      hit = true;
    }
  }
  if (hit) writeTokens(path, all);
  return hit;
}

/** The principal (token id) behind an Authorization header, or the 401 to send. */
export function authenticate(path: string, header: string | undefined): string {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) {
    throw new UhpHttpError(401, "authentication_error", "missing_credential", "Authorization: Bearer <token> is required", null, null, {
      "WWW-Authenticate": "Bearer",
    });
  }
  const h = sha256(m[1]!);
  const t = readTokens(path).find((x) => x.hash === h && !x.revoked);
  if (!t) {
    throw new UhpHttpError(401, "authentication_error", "invalid_credential", "the credential is not valid", null, null, { "WWW-Authenticate": "Bearer" });
  }
  return t.id;
}
