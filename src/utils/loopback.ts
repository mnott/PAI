/**
 * loopback.ts — the one definition of "this machine" for every local listener
 * and probe. A protocol constant (not policy): whether a service is reachable
 * beyond loopback is `router.bind`, never this.
 */

/** IPv4 loopback address every PAI local service binds to and probes. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Hostname (as URL.hostname reports it) that names this machine. */
export function isLoopbackHostname(h: string): boolean {
  return h === LOOPBACK_HOST || h === "localhost" || h === "::1" || h === "[::1]";
}

/** True when the URL's host is loopback; false for anything unparsable. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** http://127.0.0.1:<port><path> */
export function loopbackUrl(port: number | string, path = ""): string {
  return `http://${LOOPBACK_HOST}:${port}${path}`;
}
