/**
 * Refresh ~/.claude/CLAUDE.md from a new template without losing the user's edits.
 *
 * The file is only replaced when it is byte-identical to what the previous
 * template rendered to (so nothing of the user's is lost) and a timestamped
 * backup is written first. Any other content, or an unknown previous rendering,
 * counts as user-edited: the new version goes beside it as CLAUDE.md.pai-new.
 */

import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type ClaudeMdRefresh =
  | { action: "replaced"; backup: string }
  | { action: "wrote-beside"; newPath: string }
  | { action: "unchanged" };

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-pai-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function refreshClaudeMd(
  claudeMd: string,
  newRendered: string,
  previousRendered: string | null,
  now: Date = new Date(),
): ClaudeMdRefresh {
  const current = readFileSync(claudeMd, "utf8");
  if (current === newRendered) return { action: "unchanged" };

  if (previousRendered === null || current.trimEnd() !== previousRendered.trimEnd()) {
    const newPath = `${claudeMd}.pai-new`;
    writeAtomic(newPath, newRendered);
    return { action: "wrote-beside", newPath };
  }

  const backup = `${claudeMd}.bak-${stamp(now)}`;
  copyFileSync(claudeMd, backup);
  writeAtomic(claudeMd, newRendered);
  return { action: "replaced", backup };
}
