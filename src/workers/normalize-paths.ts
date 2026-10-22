/**
 * Home-relative paths in workers.yaml. The loader expands a leading `~` (expandHome) in every path-valued
 * field; config is written the same way so it never hardcodes the user's home directory.
 * String-level on purpose: only the exact home prefix on path-valued lines changes, comments and layout stay.
 */
import { homedir } from "node:os";

/** Fields whose value is a filesystem path that the loader runs through expandHome. */
export const PATH_KEYS = ["key_file", "config", "python", "script", "start", "location", "model"] as const;

export interface PathChange {
  line: number;
  field: string;
  old: string;
  new: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite `<path key>: <home>/…` to `<path key>: ~/…` (quoted or bare); every other line is untouched. */
export function normalizePathsText(text: string, home: string = homedir()): { text: string; changes: PathChange[] } {
  const changes: PathChange[] = [];
  if (!home || home === "/") return { text, changes };
  const re = new RegExp(`^(\\s*(?:-\\s+)?(${PATH_KEYS.join("|")}):\\s*["']?)${escapeRe(home)}(?=/|["']?\\s*(?:#|$))`);
  const lines = text.split("\n").map((l, i) => {
    const m = re.exec(l);
    if (!m) return l;
    const out = m[1] + "~" + l.slice(m[0].length);
    changes.push({ line: i + 1, field: m[2]!, old: l.trim().split("#")[0]!.trim(), new: out.trim().split("#")[0]!.trim() });
    return out;
  });
  return { text: lines.join("\n"), changes };
}
