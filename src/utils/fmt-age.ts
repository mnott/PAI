/** Compact age of an elapsed duration: `5m`, `3h`, `2d`, optionally `1mo`. */
export function fmtAge(ms: number, opts: { dayAfterHours: number; months?: boolean }): string {
  const min = Math.floor(ms / 60_000);
  const hr = Math.floor(ms / 3_600_000);
  if (hr < 1) return `${min}m`;
  if (hr < opts.dayAfterHours) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return opts.months && day >= 30 ? `${Math.floor(day / 30)}mo` : `${day}d`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Local-time stamp of an instant with its relative age: `05:53 (2 min ago)`
 * when it happened today, `2026-10-22 21:44 (8 h ago)` when it did not.
 */
export function fmtSeenLocal(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const ageMin = Math.max(0, Math.floor((now - d.getTime()) / 60_000));
  const age = ageMin < 60 ? `${ageMin} min` : `${Math.floor(ageMin / 60)} h`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === new Date(now).getFullYear() &&
    d.getMonth() === new Date(now).getMonth() &&
    d.getDate() === new Date(now).getDate();
  return sameDay ? `${time} (${age} ago)` : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time} (${age} ago)`;
}
