/**
 * Safe append for the history/raw-outputs JSONL captures: secrets masked,
 * private modes, bounded size.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { maskSecrets } from './loop-guard.js';
import { sha256 } from '../../../utils/hash.js';

export const RAW_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

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

/**
 * Append one JSON line to `file` (directory 0700, file 0600). When the file
 * would exceed `maxBytes` it is rotated to `<file>.1` (one backup kept).
 */
export function appendRawCapture(file: string, dir: string, line: string, maxBytes = RAW_CAPTURE_MAX_BYTES): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // no file yet
  }
  appendFileSync(file, line, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}
