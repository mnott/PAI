/**
 * loopback-guard.ts — the one request guard for every local HTTP server.
 *
 * A listener bound to loopback is still reachable by a web page in the user's
 * browser: a cross-origin POST with a text/plain body needs no preflight, and
 * DNS rebinding makes an attacker's hostname resolve to 127.0.0.1. For every
 * state-changing request the guard therefore requires
 *   - Host: a loopback host (or one `allowHost` accepts) on the server's own port,
 *   - no Origin, or an Origin equal to that same Host (the page the server serves),
 *   - no `Sec-Fetch-Site: cross-site`,
 *   - Content-Type application/json when `requireJson` is set.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackHostname } from "./loopback.js";

export interface LoopbackGuardOptions {
  /** Also accept this hostname (as URL.hostname reports it), e.g. tailnet names for the router. */
  allowHost?: (hostname: string) => boolean;
  /** Refuse a body that is not application/json (415). */
  requireJson?: boolean;
  /** Apply the Host / Origin checks to GET / HEAD / OPTIONS too (reads of private data, e.g. prompt search). */
  guardSafeMethods?: boolean;
}

export interface GuardRefusal {
  status: 403 | 415;
  message: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** null = allowed, otherwise the refusal to send. Safe methods always pass. */
export function loopbackRefusal(req: IncomingMessage, opts: LoopbackGuardOptions = {}): GuardRefusal | null {
  if (!opts.guardSafeMethods && SAFE_METHODS.has((req.method ?? "GET").toUpperCase())) return null;
  const host = req.headers.host;
  if (typeof host !== "string" || !URL.canParse(`http://${host}`)) return { status: 403, message: "host refused" };
  const parsed = new URL(`http://${host}`);
  if (!isLoopbackHostname(parsed.hostname) && !opts.allowHost?.(parsed.hostname)) return { status: 403, message: "host refused" };
  const ownPort = req.socket?.localPort;
  if (ownPort !== undefined && Number(parsed.port || 80) !== ownPort) return { status: 403, message: "host refused" };
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs !== "same-origin" && sfs !== "none") return { status: 403, message: "cross-origin request refused" };
  const origin = req.headers.origin;
  if (origin !== undefined && !(typeof origin === "string" && URL.canParse(origin) && new URL(origin).protocol === "http:" && new URL(origin).host === parsed.host)) {
    return { status: 403, message: "cross-origin request refused" };
  }
  if (opts.requireJson) {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return { status: 415, message: "content-type must be application/json" };
  }
  return null;
}

/** True when the request was refused (the reply is already sent). */
export function refuseUnlessLoopback(req: IncomingMessage, res: ServerResponse, opts: LoopbackGuardOptions = {}): boolean {
  const r = loopbackRefusal(req, opts);
  if (!r) return false;
  const body = JSON.stringify({ ok: false, error: r.message, message: r.message });
  res.writeHead(r.status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
  return true;
}

/** Router hosts: tailnet CGNAT IPs, MagicDNS names and single-label machine names (an attacker cannot register those). */
export function isTailnetOrLocalName(hostname: string): boolean {
  const m = hostname.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127;
  return hostname.endsWith(".ts.net") || /^[a-z0-9-]+$/i.test(hostname) && !/^\d+$/.test(hostname);
}
