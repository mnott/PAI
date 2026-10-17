/**
 * Session names live in Claude's clc registry (~/.claude/session.json):
 * { sessions: [ { name, resume|session (uuid), directory } ] }.
 * Renaming rewrites that one entry, leaving every other field alone.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const clcRegistryPath = (home = homedir()) => join(home, ".claude", "session.json");

interface Entry {
  name?: string;
  resume?: string;
  session?: string;
  directory?: string;
  [k: string]: unknown;
}

export function renameSession(
  uuid: string,
  newName: string,
  directory: string | undefined,
  path = clcRegistryPath()
): { previous?: string } {
  const data: { sessions?: Entry[]; [k: string]: unknown } = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { sessions?: Entry[] })
    : {};
  const sessions = (data.sessions ??= []);
  const hit = sessions.find((e) => e.resume === uuid || e.session === uuid);
  let previous: string | undefined;
  if (hit) {
    previous = hit.name;
    hit.name = newName;
  } else {
    sessions.push({ name: newName, resume: uuid, ...(directory ? { directory } : {}) });
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
  return { previous };
}
