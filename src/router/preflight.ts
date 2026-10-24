/**
 * Upstream preflight: can THIS process resolve and TCP+TLS-connect to the hosts the router talks to?
 * Used by a successor router before it takes over, and by the daemon's watchdog as its own reference reading.
 * No auth, no request body: the connection is closed after the handshake.
 */

import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { connect as tcpConnect } from "node:net";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { paiHomePath } from "../config/pai-home.js";

export interface PreflightResult {
  ok: boolean;
  host: string;
  /** Error code (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ...) when not ok. */
  code?: string;
}

export const PREFLIGHT_TIMEOUT_MS = 5000;

/** Resolve `url`'s host, then connect (TLS for https, plain TCP otherwise) within `timeoutMs`. */
export async function checkUpstream(url: string, timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<PreflightResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, host: url, code: "EINVAL" };
  }
  const host = u.hostname;
  const tls = u.protocol === "https:";
  const port = Number(u.port) || (tls ? 443 : 80);
  const timer = new Promise<PreflightResult>((r) => setTimeout(() => r({ ok: false, host, code: "ETIMEDOUT" }), timeoutMs).unref());
  const attempt = (async (): Promise<PreflightResult> => {
    try {
      await lookup(host);
    } catch (e) {
      return { ok: false, host, code: (e as NodeJS.ErrnoException).code ?? "ENOTFOUND" };
    }
    return new Promise<PreflightResult>((resolve) => {
      const sock = tls ? tlsConnect({ host, port, servername: host }) : tcpConnect({ host, port });
      sock.once(tls ? "secureConnect" : "connect", () => {
        sock.destroy();
        resolve({ ok: true, host });
      });
      sock.once("error", (e: NodeJS.ErrnoException) => {
        sock.destroy();
        resolve({ ok: false, host, code: e.code ?? "ECONNREFUSED" });
      });
    });
  })();
  return Promise.race([attempt, timer]);
}

export type UpstreamProbe = (url: string) => Promise<PreflightResult>;

/** The Anthropic upstream decides; other cloud providers are reported but never block. */
export async function preflightUpstreams(claudeUpstream: string, cloudBaseUrls: string[], probe: UpstreamProbe = checkUpstream): Promise<{ claude: PreflightResult; others: PreflightResult[] }> {
  const [claude, ...others] = await Promise.all([claudeUpstream, ...cloudBaseUrls].map((u) => probe(u)));
  return { claude: claude!, others };
}

export function abortMessage(host: string, code: string | undefined, oldPid: number | undefined): string {
  return `router restart aborted: successor cannot reach ${host}: ${code ?? "unknown"}; old router ${oldPid ?? "none"} keeps serving`;
}

/** Upstream-failure streak the router keeps for the daemon's watchdog. */
export const routerUpstreamHealthFile = (): string => paiHomePath("router.upstream-health");

export interface UpstreamHealth {
  pid: number;
  streak: number;
  /** ms epoch of the first failure in the current streak. */
  since: number;
  code?: string;
}

const NETWORK_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

/** Counts consecutive cloud-upstream network failures; a success resets it. Failures older than `windowMs` start a new streak. */
export function createUpstreamStreak(opts: { pid?: number; now?: () => number; write?: (h: UpstreamHealth | undefined) => void; windowMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? 60_000;
  const pid = opts.pid ?? process.pid;
  const write = opts.write ?? ((h) => {
    try {
      if (h) writeFileSync(routerUpstreamHealthFile(), JSON.stringify(h));
      else rmSync(routerUpstreamHealthFile(), { force: true });
    } catch {
      /* best effort */
    }
  });
  let cur: UpstreamHealth | undefined;
  return {
    failure(code: string | undefined): void {
      if (!code || !NETWORK_CODES.has(code)) return;
      const t = now();
      cur = cur && t - cur.since <= windowMs ? { ...cur, streak: cur.streak + 1, code } : { pid, streak: 1, since: t, code };
      write(cur);
    },
    success(): void {
      if (!cur) return;
      cur = undefined;
      write(undefined);
    },
  };
}

export function readUpstreamHealth(pid: number, now = Date.now(), windowMs = 60_000): UpstreamHealth | undefined {
  try {
    const h = JSON.parse(readFileSync(routerUpstreamHealthFile(), "utf8")) as UpstreamHealth;
    return h.pid === pid && now - h.since <= windowMs ? h : undefined;
  } catch {
    return undefined;
  }
}
