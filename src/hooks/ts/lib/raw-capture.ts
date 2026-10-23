/**
 * Safe append for the history/raw-outputs JSONL captures: secrets masked,
 * private modes, bounded size.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import { maskSecrets } from './loop-guard.js';
import { sha256 } from '../../../utils/hash.js';

export const RAW_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated backups kept per file; a busy day rotates more than once. */
export const RAW_CAPTURE_BACKUPS = 5;

/**
 * Local YYYY-MM-DD for `now` (never toISOString: UTC can name the wrong day
 * near a timezone boundary). Same local-date rule as getEventsFilePath().
 */
export function localCaptureDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Deterministic 16-hex id for a captured event: sha256 of the joined parts. */
export function captureEventId(parts: { sessionId?: string; toolUseId?: string; event?: string; ts?: string }): string {
  const joined = `${parts.sessionId ?? ""}|${parts.toolUseId ?? ""}|${parts.event ?? ""}|${parts.ts ?? ""}`;
  return sha256(joined).slice(0, 16);
}

/** Deep copy with every string value passed through the loop guard's secret-line masking. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** Rotated backups of `file`, oldest first: legacy `.N` (N=1 newest) sort before the stamped `.<ms>-<pid>` ones. */
function backupsOf(file: string): string[] {
  const dir = dirname(file);
  const base = basename(file);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const key = (n: string): [number, number] => {
    const rest = n.slice(base.length + 1);
    const m = /^(\d+)-(\d+)$/.exec(rest);
    return m ? [1, Number(m[1])] : [0, -Number(rest)];
  };
  return names
    .filter((n) => n.startsWith(`${base}.`) && /^(\d+|\d+-\d+)$/.test(n.slice(base.length + 1)))
    .sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1]; })
    .map((n) => join(dir, n));
}

/**
 * Append one JSON line to `file` (directory 0700, file 0600). When the file
 * would exceed `maxBytes` it is renamed in one atomic step to `<file>.<ms>-<pid>`
 * (two racing hooks cannot overwrite each other's backup), then the oldest backups
 * beyond RAW_CAPTURE_BACKUPS are removed. Legacy `<file>.N` backups still count.
 */
export function appendRawCapture(file: string, dir: string, line: string, maxBytes = RAW_CAPTURE_MAX_BYTES): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size + Buffer.byteLength(line) > maxBytes) {
      let ms = Date.now();
      while (existsSync(`${file}.${ms}-${process.pid}`)) ms++; // same process, same millisecond
      try { renameSync(file, `${file}.${ms}-${process.pid}`); } catch { /* another hook rotated it */ }
      for (const old of backupsOf(file).slice(0, -RAW_CAPTURE_BACKUPS)) {
        try { unlinkSync(old); } catch { /* already pruned */ }
      }
    }
  } catch {
    // no file yet
  }
  appendFileSync(file, line, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}
