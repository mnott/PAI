/**
 * cockpit-stale.ts — the one marker a cockpit payload carries when it is degraded for a
 * transient reason (a timeout, an unavailable backend). The page keeps rendering the last
 * good payload of that endpoint for `holdLastGoodSecs` instead of the degraded one.
 */

export interface Stale {
  /** epoch ms the degradation was seen */
  since: number;
  reason: string;
}

/** `{ stale }` for a reason, `{}` when the payload is good (spread it into the payload). */
export function staleMark(now: number, reason: string | null | undefined): { stale?: Stale } {
  return reason ? { stale: { since: now, reason } } : {};
}
