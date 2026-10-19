/**
 * cockpit-auth.ts — the router beyond loopback.
 *
 * The router's default bind is 127.0.0.1 and none of this file runs. Setting
 * `router.bind` in the main config ("tailscale" — the utun address inside
 * Tailscale's CGNAT range, or an explicit IPv4) opens a second listener on
 * that address and changes two things:
 *
 *   - /v1/* (the ANTHROPIC_BASE_URL route, whose requests carry the Max login
 *     pass-through) still only accepts remote addresses that are loopback or
 *     inside 100.64.0.0/10; anything else gets 403 before any routing.
 *   - the cockpit GET routes need the cockpit token (?token=, Authorization:
 *     Bearer, or the cookie the first token-authenticated hit sets). It is
 *     generated on first start and kept at ~/.claude/pai/router-cockpit.token,
 *     mode 0600; the full token URL is printed once at startup.
 *
 * 0.0.0.0 is refused outright: the loopback listener already serves the local
 * side, and a wildcard bind would put /v1 on the LAN.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { dirname } from "node:path";
import type http from "node:http";
import { paiHomePath } from "../config/pai-home.js";

export const LOOPBACK = "127.0.0.1";

/** The /v1 remote rule: loopback (any 127/8, ::1, v4-mapped) or the tailnet. */
export function defaultV1Guard(remoteAddress: string | undefined): boolean {
  return isLoopbackAddress(remoteAddress) || inTailscaleRange(remoteAddress);
}

/** Strip the ::ffff: IPv4-mapped prefix (Node reports v4 peers this way on v6 sockets). */
export function normalizeIp(ip: string | undefined): string {
  const a = (ip ?? "").trim().toLowerCase();
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  const a = normalizeIp(ip);
  return a === "::1" || a.startsWith("127.");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

export function inTailscaleRange(ip: string | undefined): boolean {
  const n = ipv4ToInt(normalizeIp(ip));
  if (n === null) return false;
  const mask = 0xffc00000; // /10
  return (n & mask) === 0x64400000; // 100.64.0.0
}

/**
 * router.bind → a concrete address. "loopback" (also empty/unset) is
 * 127.0.0.1; "tailscale" resolves the utun/tailscale interface's IPv4 inside
 * 100.64.0.0/10 (null when Tailscale is down); anything else must be a dotted
 * quad — 0.0.0.0 and every non-IPv4 value are refused (null).
 */
export function resolveBindAddress(
  bind: string | undefined,
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces
): string | null {
  const v = (bind ?? "").trim().toLowerCase();
  if (!v || v === "loopback") return LOOPBACK;
  if (v === "tailscale") {
    let fallback: string | undefined;
    for (const [name, addrs] of Object.entries(interfaces() ?? {})) {
      for (const a of addrs ?? []) {
        if (a.family !== "IPv4" && (a.family as unknown) !== 4) continue;
        if (!inTailscaleRange(a.address)) continue;
        // Tailscale names its interface utun<n> on macOS, tailscale0 elsewhere.
        if (/^(utun|tailscale)/i.test(name)) return a.address;
        fallback ??= a.address;
      }
    }
    return fallback ?? null;
  }
  if (v === "0.0.0.0" || v === "::" || v === "*") return null;
  return ipv4ToInt(v) !== null ? v : null;
}

/** Lazy so tests (PAI_HOME redirected) and installs never bake in a home path. */
export function cockpitTokenFile(): string {
  return paiHomePath("router-cockpit.token");
}

/**
 * The cockpit token: read from disk, generated on first start (32 random
 * bytes, base64url) and written 0600.
 */
export function readOrCreateCockpitToken(file: string = cockpitTokenFile()): string {
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* first start */
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600); // umask can soften the create mode
  return token;
}

/** Length-independent constant-time compare: both sides digest to 32 bytes. */
function tokenEq(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * True when the request carries the cockpit token: ?token=, an
 * `Authorization: Bearer <token>` header, or the pai_cockpit cookie the first
 * token-authenticated response set (so the page's own fetches pass).
 */
export function cockpitTokenOk(
  url: string | undefined,
  headers: http.IncomingHttpHeaders,
  token: string
): boolean {
  let q: string | null = null;
  try {
    q = new URL(url ?? "/", "http://localhost").searchParams.get("token");
  } catch {
    /* unparseable url — fall through to header/cookie */
  }
  if (q && tokenEq(q, token)) return true;
  const m = /^Bearer\s+(\S+)$/i.exec((headers.authorization ?? "").trim());
  if (m && tokenEq(m[1]!, token)) return true;
  for (const part of (headers.cookie ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "pai_cockpit" && tokenEq(rest.join("="), token)) return true;
  }
  return false;
}

/** Anything the cockpit handler serves (handleCockpit) — kept import-free. */
export type CockpitHandler = (req: http.IncomingMessage, res: http.ServerResponse) => boolean;

export function isCockpitPath(path: string): boolean {
  return path === "/cockpit" || path.startsWith("/cockpit/");
}

/**
 * The cockpit write actions (POST): the queue pull-forward endpoints. They
 * carry the same token auth as the GET routes — the wrapper below checks
 * every /cockpit/* path whatever the method.
 */
export const COCKPIT_WRITE_PATHS = ["/cockpit/queue/next", "/cockpit/queue/front", "/cockpit/queue/up", "/cockpit/queue/move"] as const;

export function isCockpitWrite(path: string): boolean {
  return (COCKPIT_WRITE_PATHS as readonly string[]).includes(path);
}

/**
 * Wrap the cockpit handler with the token check for non-loopback binds. The
 * first token-authenticated response sets an HttpOnly cookie so the page's
 * relative fetches (/cockpit/data, ...) authenticate without carrying the
 * token themselves. Non-cockpit paths pass through untouched (the router
 * 404s them).
 */
export function withCockpitToken(token: string, inner: CockpitHandler): CockpitHandler {
  return (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (!isCockpitPath(path)) return inner(req, res);
    if (!cockpitTokenOk(req.url, req.headers, token)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("pai cockpit: token required (?token= or Authorization: Bearer)");
      return true;
    }
    const cookie = req.headers.cookie;
    if (!cookie || !cookie.split(";").some((c) => c.trim().startsWith("pai_cockpit="))) {
      res.setHeader("Set-Cookie", `pai_cockpit=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return inner(req, res);
  };
}

/**
 * The address to show a human for a bind address: the tailnet hostname
 * (macbook-mn style, from `tailscale status --json`) when the address is the
 * machine's own Tailscale IP, else the address itself.
 */
export async function displayHost(addr: string): Promise<string> {
  if (!inTailscaleRange(addr)) return addr;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("tailscale", ["status", "--json"], { timeout: 3000 });
    const self = (JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
    if (self?.DNSName && self.TailscaleIPs?.includes(addr)) return self.DNSName.replace(/\.$/, "");
  } catch {
    /* no tailscale CLI in scope — the IP is fine */
  }
  return addr;
}
