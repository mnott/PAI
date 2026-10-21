/**
 * timeouts.ts — request/probe timeouts shared by more than one module, defined
 * once. Operator-tunable limits live in config (e.g. router.drainMs); these
 * are the fixed budgets of a liveness probe on this machine.
 */

/** Liveness probe of a local server (HTTP or TCP) on loopback or the LAN. */
export const LOCAL_PROBE_TIMEOUT_MS = 2000;

/** `tailscale status --json` on this machine. */
export const TAILSCALE_STATUS_TIMEOUT_MS = 3000;
