/**
 * Parse cache for the config readers. An entry is valid while the
 * (mtimeMs, size) of its file — and of any `deps` files — is unchanged, read
 * with one statSync each; no TTL. Values are handed out as structuredClone
 * copies so a caller that mutates its result cannot corrupt the cached one.
 */
import { statSync } from "node:fs";

const entries = new Map<string, { sig: string; value: unknown }>();

/** Counts real parses, for diagnostics. */
export const parseCacheStats = { parses: 0 };

function signature(paths: string[]): string | null {
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

/** Drops every entry. */
export function clearParseCache(): void {
  entries.clear();
  parseCacheStats.parses = 0;
}
