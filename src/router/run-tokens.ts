/**
 * run-tokens.ts — per-run placeholder credentials ("keyless workers").
 *
 * `pai worker run` mints a random token, registers token -> provider here
 * (over the router's local control path, /_pai/run-tokens) and gives the
 * engine only the token and the router base URL. The router swaps in the
 * provider's real key (prepare() reads the key file) so the key never enters
 * a worker's environment, config file or process list. In memory only, with a
 * TTL (worker deadline + slack); revoked when the run ends, and a sweep drops
 * the entries of runs whose process died without revoking.
 */

import { randomBytes } from "node:crypto";

export const RUN_TOKEN_PREFIX = "pai-run-";
export const RUN_TOKEN_PATH = "/_pai/run-tokens";
/** Slack on top of a run's deadline before its token expires on its own. */
export const RUN_TOKEN_SLACK_MS = 10 * 60_000;

export function mintRunToken(): string {
  return RUN_TOKEN_PREFIX + randomBytes(24).toString("hex");
}

interface Entry {
  provider: string;
  runId: string;
  /** Tenant of the run (its project's tenant); absent: local. */
  tenant?: string;
  expiresAt: number;
  /** the run process; a dead one is swept */
  pid?: number;
}

export class RunTokens {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly alive: (pid: number) => boolean = pidAlive
  ) {}

  register(token: string, provider: string, runId: string, ttlMs: number, pid?: number, tenant?: string): void {
    this.entries.set(token, { provider, runId, expiresAt: this.now() + ttlMs, ...(pid ? { pid } : {}), ...(tenant ? { tenant } : {}) });
  }

  /** The provider a live token belongs to; null when unknown, revoked or expired. */
  resolve(token: string): string | null {
    const e = this.entries.get(token);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(token);
      return null;
    }
    return e.provider;
  }

  /** Tenant and run id of a live token (the principal of proxy requests carrying it); null when unknown or expired. */
  principalOf(token: string): { tenant: string; runId: string } | null {
    if (!this.resolve(token)) return null;
    const e = this.entries.get(token)!;
    return { tenant: e.tenant ?? "local", runId: e.runId };
  }

  /** Revoke by token or by run id; returns how many entries went. */
  revoke(by: { token?: string; runId?: string }): number {
    let n = 0;
    for (const [t, e] of this.entries) {
      if ((by.token && t === by.token) || (by.runId && e.runId === by.runId)) {
        this.entries.delete(t);
        n++;
      }
    }
    return n;
  }

  /** Drop expired entries and those whose run process is gone. */
  sweep(): number {
    let n = 0;
    for (const [t, e] of this.entries) {
      if (e.expiresAt <= this.now() || (e.pid !== undefined && !this.alive(e.pid))) {
        this.entries.delete(t);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The credential a request carries: Bearer or x-api-key. */
export function requestToken(headers: Record<string, string | string[] | undefined>): string | null {
  const a = headers.authorization;
  const bearer = (Array.isArray(a) ? a[0] : a)?.replace(/^Bearer\s+/i, "").trim();
  const k = headers["x-api-key"];
  const key = (Array.isArray(k) ? k[0] : k)?.trim();
  return bearer || key || null;
}

/** Shared by the router process (one registry per process). */
export const runTokens = new RunTokens();
