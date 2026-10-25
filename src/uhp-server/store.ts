/**
 * store.ts — the response index (resp_ id -> worker) and the idempotency
 * store, both plain JSON files under the server's state dir. A response is a
 * worker: the worker's .jsonl and status file are the truth, the index only
 * adds what UHP needs on top (principal scope, session, request, cancel flag).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../config/atomic-file.js";

export interface ResponseRecord {
  id: string;
  workerId: string;
  sessionId: string;
  principal: string;
  harnessId: string;
  provider: string;
  className: string;
  model: string;
  requestedModel?: string;
  createdAt: number;
  input: unknown;
  instructions?: string;
  previousResponseId: string | null;
  store: boolean;
  metadata: Record<string, unknown>;
  cancelRequested?: boolean;
}

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
export const hashOf = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export class UhpStore {
  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(join(dir, "responses"), { recursive: true });
    mkdirSync(join(dir, "idempotency"), { recursive: true });
  }

  private recPath(id: string): string | null {
    return SAFE_ID.test(id) ? join(this.dir, "responses", `${id}.json`) : null;
  }

  put(rec: ResponseRecord): void {
    writeFileAtomic(this.recPath(rec.id)!, JSON.stringify(rec));
  }

  /** The record, only for its own principal: another principal's id is simply not found. */
  get(id: string, principal: string): ResponseRecord | null {
    const p = this.recPath(id);
    if (!p || !existsSync(p)) return null;
    try {
      const r = JSON.parse(readFileSync(p, "utf8")) as ResponseRecord;
      return r.principal === principal ? r : null;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    const p = this.recPath(id);
    if (p && existsSync(p)) unlinkSync(p);
  }

  bySession(sessionId: string, principal: string): ResponseRecord[] {
    const dir = join(this.dir, "responses");
    const out: ResponseRecord[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const r = this.get(f.slice(0, -5), principal);
      if (r && r.sessionId === sessionId) out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  private keyPath(principal: string, key: string): string {
    return join(this.dir, "idempotency", `${hashOf([principal, key])}.json`);
  }

  /** The first request recorded under this key (within 24 h), or null. */
  idempotent(principal: string, key: string): { bodyHash: string; responseId: string } | null {
    const p = this.keyPath(principal, key);
    if (!existsSync(p)) return null;
    try {
      const e = JSON.parse(readFileSync(p, "utf8")) as { bodyHash: string; responseId: string; at: number };
      if (this.now() - e.at > IDEMPOTENCY_TTL_MS) {
        unlinkSync(p);
        return null;
      }
      return e;
    } catch {
      return null;
    }
  }

  recordKey(principal: string, key: string, bodyHash: string, responseId: string): void {
    writeFileAtomic(this.keyPath(principal, key), JSON.stringify({ bodyHash, responseId, at: this.now() }));
  }

  forgetKey(principal: string, key: string): void {
    const p = this.keyPath(principal, key);
    if (existsSync(p)) unlinkSync(p);
  }
}
