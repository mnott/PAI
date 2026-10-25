/**
 * idempotency.ts — `Idempotency-Key` for worker starts (UHP tasks.md §6): a
 * repeated key returns the FIRST run and starts no second one; the same key
 * with a different request is refused (`invalid_input`). Entries live 24 h in
 * `<logDir>/idempotency/`. A claim is created exclusively, so two racing
 * callers cannot both start.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiError, PaiErrorException } from "./errors.js";

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

interface Entry {
  hash: string;
  workerId: string;
  createdAt: number;
}

const dirOf = (logDir: string): string => join(logDir, "idempotency");
const fileOf = (logDir: string, key: string): string => join(dirOf(logDir), createHash("sha256").update(key).digest("hex").slice(0, 40) + ".json");

/** Stable hash of the request fields that define "the same run". */
export function requestHash(req: unknown): string {
  return createHash("sha256").update(JSON.stringify(req) ?? "").digest("hex");
}

function read(path: string, now: number): Entry | null {
  try {
    const e = JSON.parse(readFileSync(path, "utf8")) as Entry;
    if (now - e.createdAt > IDEMPOTENCY_TTL_MS) {
      rmSync(path, { force: true });
      return null;
    }
    return e;
  } catch {
    return null;
  }
}

export type IdempotencyClaim =
  | { kind: "new"; record: (workerId: string) => void; release: () => void }
  | { kind: "replay"; workerId: string };

/**
 * Claim `key` for a request. "replay": the first run's id (waits up to
 * `waitMs` while the first caller has not recorded its id yet). "new": the
 * caller starts the run and calls `record(workerId)` once it exists, or
 * `release()` when it failed to start (so a retry can run).
 */
export async function claimIdempotency(logDir: string, key: string, req: unknown, opts: { now?: number; waitMs?: number } = {}): Promise<IdempotencyClaim> {
  const now = opts.now ?? Date.now();
  const hash = requestHash(req);
  mkdirSync(dirOf(logDir), { recursive: true });
  const path = fileOf(logDir, key);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ hash, workerId: "", createdAt: now } satisfies Entry), { flag: "wx" });
      return {
        kind: "new",
        record: (workerId) => writeFileSync(path, JSON.stringify({ hash, workerId, createdAt: now } satisfies Entry)),
        release: () => rmSync(path, { force: true }),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const deadline = Date.now() + (opts.waitMs ?? 10_000);
    let entry = read(path, now);
    while (entry && !entry.workerId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      entry = read(path, now);
    }
    if (!entry) continue; // expired or released: claim again
    if (entry.hash !== hash) {
      throw new PaiErrorException(paiError("invalid_input", "Idempotency-Key was already used with a different request", { param: "idempotency_key" }));
    }
    if (!entry.workerId) throw new PaiErrorException(paiError("session_busy", "the first request for this Idempotency-Key is still starting", { param: "idempotency_key" }));
    return { kind: "replay", workerId: entry.workerId };
  }
  throw new PaiErrorException(paiError("harness_error", "could not claim the Idempotency-Key"));
}

/** Drop entries past the TTL; returns how many. */
export function sweepIdempotency(logDir: string, now = Date.now()): number {
  const dir = dirOf(logDir);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > IDEMPOTENCY_TTL_MS) {
        rmSync(p, { force: true });
        n++;
      }
    } catch {
      /* gone */
    }
  }
  return n;
}
