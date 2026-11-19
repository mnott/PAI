/**
 * whisper-expiry.ts — rule lines that carry their own end: a line starting
 * "UNTIL YYYY-MM-DD HH:MM <rule>" is injected only before that (machine-local)
 * time. The file is left as is; `pai whisper prune` drops expired lines.
 */

const UNTIL = /^UNTIL\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*(.*)$/;

/** The rule text to inject now, "" when the line expired; the line itself when it has no UNTIL prefix. */
export function applyUntil(line: string, now: number = Date.now()): string {
  const m = UNTIL.exec(line);
  if (!m) return line;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (!Number.isFinite(t)) return line;
  return now < t ? m[6]! : "";
}

/** The file text without its expired UNTIL lines. */
export function pruneExpired(text: string, now: number = Date.now()): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split("\n").filter((l) => {
    const t = l.trim();
    if (UNTIL.test(t) && applyUntil(t, now) === "") {
      removed++;
      return false;
    }
    return true;
  });
  return { text: kept.join("\n"), removed };
}
