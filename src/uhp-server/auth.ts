/**
 * UHP bearer auth. Tokens live as sha256 hashes in <PAI_HOME>/uhp/tokens.json
 * (`pai uhp token create|revoke|list`); the file is re-read per request so a
 * revocation is immediate. Unknown and revoked tokens get the same reply.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { paiHomePath } from "../config/pai-home.js";
import { uhpError } from "./errors.js";

export interface TokenRecord {
  id: string;
  hash: string;
  label: string;
  createdAt: string;
  revokedAt?: string;
  /** Harness ids this token may see; absent = all. Objects outside it answer 404. */
  scope?: string[];
  /** Tenant whose rules and audit log this principal's decisions belong to; absent = local. */
  tenant?: string;
}

export interface Principal {
  tokenId: string;
  scope: string[] | null;
  tenant: string;
}

export function tokensFilePath(override?: string): string {
  return override ?? paiHomePath("uhp", "tokens.json");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readTokens(path: string): TokenRecord[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { tokens?: TokenRecord[] };
  return Array.isArray(raw.tokens) ? raw.tokens : [];
}

function writeTokens(path: string, tokens: TokenRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Create a token; the plaintext is returned once and never stored. */
export function createToken(path: string, label: string, scope?: string[], tenant?: string): { token: string; record: TokenRecord } {
  const token = `uhp_${randomBytes(24).toString("hex")}`;
  const record: TokenRecord = {
    id: `tok_${randomBytes(4).toString("hex")}`,
    hash: hashToken(token),
    label,
    createdAt: new Date().toISOString(),
    ...(scope && scope.length ? { scope } : {}),
    ...(tenant ? { tenant } : {}),
  };
  writeTokens(path, [...readTokens(path), record]);
  return { token, record };
}

export function revokeToken(path: string, id: string): TokenRecord | null {
  const tokens = readTokens(path);
  const hit = tokens.find((t) => t.id === id);
  if (!hit) return null;
  if (!hit.revokedAt) hit.revokedAt = new Date().toISOString();
  writeTokens(path, tokens);
  return hit;
}

/** Principal for the request, or throws 401 missing_credential / invalid_credential. */
export function authenticate(req: IncomingMessage, tokensPath: string): Principal {
  const header = req.headers.authorization;
  if (!header) throw uhpError(401, null, "missing_credential", "Authorization: Bearer <token> is required");
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) throw uhpError(401, null, "missing_credential", "Authorization: Bearer <token> is required");
  const hash = hashToken(m[1]);
  const rec = readTokens(tokensPath).find((t) => t.hash === hash && !t.revokedAt);
  if (!rec) throw uhpError(401, null, "invalid_credential", "The credential is not valid");
  return { tokenId: rec.id, scope: rec.scope ?? null, tenant: rec.tenant ?? "local" };
}

export function inScope(p: Principal, harnessId: string): boolean {
  return !p.scope || p.scope.includes(harnessId);
}
