/**
 * json-store.ts — read/write JSON config files without destroying them
 *
 * The failure this exists to prevent:
 *
 *     try { return JSON.parse(read(path)); } catch { return {}; }
 *     ... later ...
 *     write(path, JSON.stringify(ourData));
 *
 * An unreadable file becomes an empty object, and the next write makes that
 * permanent. Silently, exit code 0. This shape appeared three times in this
 * repo against three different files, and twice in AIBroker.
 *
 * The distinction that matters is between *missing* and *unreadable*:
 *
 *   missing     — legitimate first run. Start fresh; writing is safe.
 *   unreadable  — the file exists and we could not parse it. Those bytes are
 *                 the only copy of something. Never overwrite them.
 *
 * Collapsing the second into the first is the bug.
 *
 * NOT everything deserves this guard. For a transient buffer — an undelivered
 * message queue, a cache — starting fresh IS the correct recovery, and
 * refusing to write would disable the feature permanently. Use `writeJsonAtomic`
 * alone there: it still prevents a crash from truncating a good file, without
 * blocking recovery. Reserve `readJsonStrict` for data a user cannot rebuild.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Read a JSON file, distinguishing "absent" from "damaged".
 *
 * @param path   file to read
 * @param label  how to name it to the user, e.g. "~/.claude.json"
 * @throws if the file exists but cannot be read or parsed
 */
export function readJsonStrict(path: string, label = path): Record<string, unknown> {
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `Could not read ${label}: ${e instanceof Error ? e.message : String(e)}\n` +
      `Refusing to continue — writing now would replace its contents with ours alone.`
    );
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${label} exists but is not valid JSON: ${e instanceof Error ? e.message : String(e)}\n` +
      `Refusing to continue — overwriting it would destroy whatever it holds.\n` +
      `Repair the file, or move it aside and re-run this command.`
    );
  }
}

/**
 * Write JSON without risking the existing file.
 *
 * Keeps a `.bak-pai` copy of the previous contents, then writes to a temp file
 * and renames. Rename is atomic within a filesystem, so a crash mid-write
 * leaves the original intact rather than truncated — which is how these files
 * become corrupt in the first place.
 */
export function writeJsonAtomic(
  path: string,
  data: Record<string, unknown>,
  opts: { backup?: boolean; label?: string } = {}
): void {
  const { backup = true, label = path } = opts;
  const serialized = JSON.stringify(data, null, 2) + "\n";

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (backup && existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak-pai`);
    } catch (e) {
      throw new Error(
        `Could not back up ${label}: ${e instanceof Error ? e.message : String(e)}\n` +
        `Refusing to write without a backup.`
      );
    }
  }

  const tmp = `${path}.tmp-pai-${process.pid}`;
  try {
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw new Error(
      `Failed to write ${label}: ${e instanceof Error ? e.message : String(e)}\n` +
      `The original is unchanged.`
    );
  }
}
