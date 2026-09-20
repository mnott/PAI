/**
 * adapter-content.ts — PAI_HOME/agents and PAI_HOME/commands: the operator's
 * authored Agent/Command .md content, made PAI-owned with an adapter symlink
 * back at ~/.claude/Agents and ~/.claude/Commands so Claude Code still loads
 * them from its fixed harness paths (confirmed empirically: Claude Code
 * follows a directory symlink for .claude/agents/ — see docs/workers-config.md,
 * "Where PAI lives"). Unlike Hooks/Skills (individual files symlinked by the
 * build's --sync step), these were real, un-owned files with no PAI copy to
 * symlink from — this module is what gives them one.
 */

import { existsSync, lstatSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { paiHomePath, migratePaiDir, type MigrateDirResult } from "./pai-home.js";

export interface MigrateContentDirResult extends MigrateDirResult {
  symlinked: boolean;
  symlinkNote?: string;
}

function oldAgentsDir(): string {
  return join(homedir(), ".claude", "Agents");
}

function oldCommandsDir(): string {
  return join(homedir(), ".claude", "Commands");
}

function migrateContentDirWithSymlink(
  newDir: string,
  oldDir: string,
  opts: { dryRun?: boolean } = {}
): MigrateContentDirResult {
  // Already a symlink (presumably to newDir, from an earlier run) — nothing to do.
  if (existsSync(oldDir) && lstatSync(oldDir).isSymbolicLink()) {
    return {
      fromDir: null,
      toDir: newDir,
      dryRun: !!opts.dryRun,
      note: `already symlinked (${oldDir} → ${newDir})`,
      symlinked: true,
    };
  }

  const result = migratePaiDir(newDir, [oldDir], opts);
  if (opts.dryRun || result.fromDir === null) {
    return { ...result, symlinked: false };
  }

  if (existsSync(oldDir)) {
    // migratePaiDir leaves the old dir in place (not renamed aside) when a
    // same-named entry already existed at newDir — never symlink over
    // whatever real content is left behind in that case.
    return {
      ...result,
      symlinked: false,
      symlinkNote: `${oldDir} still has entries after migration (${result.note ?? "see above"}) — not symlinked`,
    };
  }

  try {
    symlinkSync(newDir, oldDir);
    return { ...result, symlinked: true };
  } catch (e) {
    return { ...result, symlinked: false, symlinkNote: e instanceof Error ? e.message : String(e) };
  }
}

/** Move ~/.claude/Agents/*.md into PAI_HOME/agents/, then symlink it back. */
export function migrateAgentsDir(opts: { dryRun?: boolean } = {}): MigrateContentDirResult {
  return migrateContentDirWithSymlink(paiHomePath("agents"), oldAgentsDir(), opts);
}

/** Move ~/.claude/Commands/*.md into PAI_HOME/commands/, then symlink it back. */
export function migrateCommandsDir(opts: { dryRun?: boolean } = {}): MigrateContentDirResult {
  return migrateContentDirWithSymlink(paiHomePath("commands"), oldCommandsDir(), opts);
}
