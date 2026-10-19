/**
 * claude-json.ts — safe read/write for ~/.claude.json
 *
 * This file is not ours. It holds every MCP server registration plus Claude
 * Code's own per-project state — on a working machine, hundreds of kilobytes
 * that no one can reconstruct by hand. PAI only ever adds one key to it.
 *
 * The previous implementation (duplicated in mcp.ts and daemon.ts) did:
 *
 *     try { return JSON.parse(read(path)); } catch { return {}; }
 *
 * followed by a full-file write. A malformed or transiently unreadable file
 * therefore became an empty object, and the next write replaced the user's
 * entire config with just PAI's entry. No error, no backup, exit code 0.
 *
 * The precondition is unlikely, which is exactly the problem: `pai setup` is
 * advertised as idempotent and safe to re-run, so it is what people run when
 * something is already broken — the state in which the file is most likely to
 * be malformed.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertTestWriteAllowed } from "./test-isolation.js";

/** Resolved at call time so a changed HOME (tests) is honoured. */
export function claudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}


/**
 * Read ~/.claude.json.
 *
 * A missing file is a legitimate first-run state and yields {}. Anything else
 * — malformed JSON, permissions, a half-written file — throws. Returning {}
 * for an unreadable file is what turns a read problem into data loss on the
 * next write.
 */
export function readClaudeJson(): Record<string, unknown> {
  if (!existsSync(claudeJsonPath())) return {};

  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath(), "utf8");
  } catch (e) {
    throw new Error(
      `Could not read ${claudeJsonPath()}: ${e instanceof Error ? e.message : String(e)}\n` +
      `Refusing to continue — writing now would replace your MCP registrations with PAI's alone.`
    );
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${claudeJsonPath()} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n` +
      `Refusing to continue — overwriting it would destroy every MCP server registration it holds.\n` +
      `Fix the file, or move it aside and let Claude Code recreate it, then re-run this command.`
    );
  }
}

/**
 * Write ~/.claude.json, keeping a backup and never leaving it half-written.
 *
 * Writes to a temp file and renames: rename is atomic within a filesystem, so
 * a crash mid-write leaves the original intact rather than truncated. The
 * previous direct writeFileSync could truncate the file and then fail.
 */
export function writeClaudeJson(data: Record<string, unknown>): void {
  assertTestWriteAllowed(claudeJsonPath());
  const serialized = JSON.stringify(data, null, 2) + "\n";

  if (existsSync(claudeJsonPath())) {
    try {
      copyFileSync(claudeJsonPath(), backupPath());
    } catch (e) {
      throw new Error(
        `Could not back up ${claudeJsonPath()} to ${backupPath()}: ${e instanceof Error ? e.message : String(e)}\n` +
        `Refusing to write without a backup.`
      );
    }
  }

  const tmp = `${claudeJsonPath()}.tmp-pai-${process.pid}`;
  try {
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, claudeJsonPath());
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error(
      `Failed to write ${claudeJsonPath()}: ${e instanceof Error ? e.message : String(e)}\n` +
      `The original is unchanged${existsSync(backupPath()) ? `; a backup is at ${backupPath()}` : ""}.`
    );
  }
}

function backupPath(): string {
  return `${claudeJsonPath()}.bak-pai`;
}

/** Where the pre-write backup is kept, for messages to the user. */
export function claudeJsonBackupPath(): string {
  return backupPath();
}

/**
 * Mark `absPath` as trusted in Claude Code's per-project state
 * (projects[<path>].hasTrustDialogAccepted), so launching it skips the
 * "trust this folder" dialog. Goes through readClaudeJson/writeClaudeJson, so
 * a malformed file throws instead of being replaced. Returns false when the
 * path was already trusted (nothing written).
 */
export function trustProjectPath(absPath: string): boolean {
  const config = readClaudeJson();
  const projects =
    typeof config.projects === "object" && config.projects !== null ? (config.projects as Record<string, unknown>) : {};
  const entry =
    typeof projects[absPath] === "object" && projects[absPath] !== null ? (projects[absPath] as Record<string, unknown>) : {};
  if (entry.hasTrustDialogAccepted === true) return false;
  writeClaudeJson({ ...config, projects: { ...projects, [absPath]: { ...entry, hasTrustDialogAccepted: true } } });
  return true;
}
