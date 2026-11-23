/**
 * Parse cache for the config readers. An entry is valid while the
 * (mtimeMs, size) of its file — and of any `deps` files — is unchanged, read
 * with one statSync each (cachedParseRaw: at most one per second per file, for hot read loops). Values are handed out as structuredClone
 * copies so a caller that mutates its result cannot corrupt the cached one.
 */
import { statSync } from "node:fs";

const entries = new Map<string, { sig: string; value: unknown }>();

/** Counts real parses, for diagnostics. */
export const parseCacheStats = { parses: 0 };

/** A file's stat is re-read at most once per this window, so a burst of lookups costs one stat. */
export const SIGNATURE_MEMO_MS = 1000;
const sigMemo = new Map<string, { at: number; sig: string | null }>();

function signature(paths: string[], memo = false): string | null {
  if (!memo) return statSignature(paths);
  const now = Date.now();
  const memoKey = paths.join("\0");
  const m = sigMemo.get(memoKey);
  if (m && now - m.at >= 0 && now - m.at < SIGNATURE_MEMO_MS) return m.sig;
  const sig = statSignature(paths);
  sigMemo.set(memoKey, { at: now, sig });
  return sig;
}

function statSignature(paths: string[]): string | null {
  try {
    return paths
      .map((p) => {
        const st = statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      })
      .join("|");
  } catch {
    return null;
  }
}

/** The `parse` result for `path`, re-run only when the file (or a dep) changed. Unreadable files are parsed uncached so errors surface as before. */
export function cachedParse<T>(path: string, parse: () => T, namespace = "", deps: string[] = []): T {
  const key = `${namespace}\0${path}`;
  const sig = signature([path, ...deps]);
  if (sig === null) {
    entries.delete(key);
    parseCacheStats.parses++;
    return parse();
  }
  const hit = entries.get(key);
  if (hit && hit.sig === sig) return structuredClone(hit.value) as T;
  parseCacheStats.parses++;
  const value = parse();
  entries.set(key, { sig, value: structuredClone(value) });
  return value;
}

/**
 * cachedParse for values read through a copy-on-write wrapper: the cached value is handed out as it
 * is (no structuredClone per hit), and this invalidates its key so the next read re-parses from disk.
 * A caller that mutates its result must call invalidateParse first, or work on a clone.
 */
export function cachedParseRaw<T>(path: string, parse: () => T, namespace = "", deps: string[] = []): T {
  const key = `${namespace}\0${path}`;
  const sig = signature([path, ...deps], true);
  if (sig === null) {
    entries.delete(key);
    parseCacheStats.parses++;
    return parse();
  }
  const hit = entries.get(key);
  if (hit && hit.sig === sig) return hit.value as T;
  parseCacheStats.parses++;
  const value = parse();
  entries.set(key, { sig, value });
  return value;
}

/** Drops one key's entry, so the next cached read of that file re-parses. */
export function invalidateParse(path: string, namespace = ""): void {
  entries.delete(`${namespace}\0${path}`);
  sigMemo.clear();
}

/** Drops every entry. */
export function clearParseCache(): void {
  entries.clear();
  sigMemo.clear();
  parseCacheStats.parses = 0;
}
