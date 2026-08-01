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

export const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
const BACKUP_PATH = `${CLAUDE_JSON_PATH}.bak-pai`;

/**
 * Read ~/.claude.json.
 *
 * A missing file is a legitimate first-run state and yields {}. Anything else
 * — malformed JSON, permissions, a half-written file — throws. Returning {}
 * for an unreadable file is what turns a read problem into data loss on the
 * next write.
 */
export function readClaudeJson(): Record<string, unknown> {
  if (!existsSync(CLAUDE_JSON_PATH)) return {};

  let raw: string;
  try {
    raw = readFileSync(CLAUDE_JSON_PATH, "utf8");
  } catch (e) {
    throw new Error(
      `Could not read ${CLAUDE_JSON_PATH}: ${e instanceof Error ? e.message : String(e)}\n` +
      `Refusing to continue — writing now would replace your MCP registrations with PAI's alone.`
    );
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${CLAUDE_JSON_PATH} is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n` +
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
  const serialized = JSON.stringify(data, null, 2) + "\n";

  if (existsSync(CLAUDE_JSON_PATH)) {
    try {
      copyFileSync(CLAUDE_JSON_PATH, BACKUP_PATH);
    } catch (e) {
      throw new Error(
        `Could not back up ${CLAUDE_JSON_PATH} to ${BACKUP_PATH}: ${e instanceof Error ? e.message : String(e)}\n` +
        `Refusing to write without a backup.`
      );
    }
  }

  const tmp = `${CLAUDE_JSON_PATH}.tmp-pai-${process.pid}`;
  try {
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, CLAUDE_JSON_PATH);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error(
      `Failed to write ${CLAUDE_JSON_PATH}: ${e instanceof Error ? e.message : String(e)}\n` +
      `The original is unchanged${existsSync(BACKUP_PATH) ? `; a backup is at ${BACKUP_PATH}` : ""}.`
    );
  }
}

/** Where the pre-write backup is kept, for messages to the user. */
export function claudeJsonBackupPath(): string {
  return BACKUP_PATH;
}
