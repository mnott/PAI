/**
 * Upstream preflight: can THIS process resolve and TCP+TLS-connect to the hosts the router talks to?
 * Used by a successor router before it takes over, and by the daemon's watchdog as its own reference reading.
 * No auth, no request body: the connection is closed after the handshake.
 */

import { getServers, lookup, resolve4 } from "node:dns/promises";
import { execFile } from "node:child_process";
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

export function abortMessage(host: string, code: string | undefined, oldPid: number | undefined, diag?: string): string {
  return `router restart aborted: successor cannot reach ${host}: ${code ?? "unknown"}; old router ${oldPid ?? "none"} keeps serving${diag ? `; diag ${diag}` : ""}`;
}

export const DIAG_PROBE_TIMEOUT_MS = 5000;

/** The probes behind a failed-preflight diagnosis; injectable so tests need no network. */
export interface DiagProbes {
  lookup: (host: string) => Promise<unknown>;
  resolve4: (host: string) => Promise<unknown>;
  servers: () => string[];
  /** First address `dscacheutil` (the system resolver, as other processes see it) gives, or "". */
  dscacheutil: (host: string) => Promise<string>;
}

export const defaultDiagProbes: DiagProbes = {
  lookup: (h) => lookup(h),
  resolve4: (h) => resolve4(h),
  servers: () => getServers(),
  dscacheutil: (host) =>
    new Promise((res) => {
      execFile("/usr/bin/dscacheutil", ["-q", "host", "-a", "name", host], { timeout: DIAG_PROBE_TIMEOUT_MS }, (err, out) => {
        res(err ? "" : (/ip_address:\s*(\S+)/.exec(String(out))?.[1] ?? ""));
      });
    }),
};

/** `ok 21ms` or `ENOTFOUND 5003ms`: how a probe ended and how long it took, each bounded by `timeoutMs`. */
async function timed(run: () => Promise<unknown>, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    run().then(() => "ok", (e: NodeJS.ErrnoException) => e?.code ?? "ERR"),
    new Promise<string>((r) => { timer = setTimeout(() => r("ETIMEDOUT"), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return `${outcome} ${Date.now() - t0}ms`;
}

/** What this process sees for `host` right now; run only after a failed preflight. At most 5 s per probe, probes run in parallel. */
export async function diagnoseSuccessor(host: string, probes: DiagProbes = defaultDiagProbes, timeoutMs = DIAG_PROBE_TIMEOUT_MS): Promise<string> {
  const [lk, r4, dsc] = await Promise.all([
    timed(() => probes.lookup(host), timeoutMs),
    timed(() => probes.resolve4(host), timeoutMs),
    Promise.race([probes.dscacheutil(host).catch(() => ""), new Promise<string>((r) => setTimeout(() => r(""), timeoutMs).unref())]),
  ]);
  let servers = "";
  try {
    servers = probes.servers().join(",");
  } catch {
    /* none */
  }
  return `successor lookup=${lk} resolve4=${r4} servers=${servers} dscacheutil=${dsc}`;
}

/** The restarting process's own `lookup(host)`: `lookup=ok` or `lookup=<code>`. */
export async function restarterLookup(host: string, probe: (h: string) => Promise<unknown> = (h) => lookup(h)): Promise<string> {
  try {
    await Promise.race([probe(host), new Promise((_, rej) => setTimeout(() => rej({ code: "ETIMEDOUT" }), DIAG_PROBE_TIMEOUT_MS).unref())]);
    return "restarter lookup=ok";
  } catch (e) {
    return `restarter lookup=${(e as NodeJS.ErrnoException)?.code ?? "ERR"}`;
  }
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
