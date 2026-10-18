/** Compact age of an elapsed duration: `5m`, `3h`, `2d`, optionally `1mo`. */
export function fmtAge(ms: number, opts: { dayAfterHours: number; months?: boolean }): string {
  const min = Math.floor(ms / 60_000);
  const hr = Math.floor(ms / 3_600_000);
  if (hr < 1) return `${min}m`;
  if (hr < opts.dayAfterHours) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return opts.months && day >= 30 ? `${Math.floor(day / 30)}mo` : `${day}d`;
}
