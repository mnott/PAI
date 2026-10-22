/**
 * settings-file.ts — the one place PAI writes Claude Code settings files.
 *
 * A pinned provider token must never sit in argv (every local user reads it
 * with `ps`) or in a world-readable file, so a settings object that carries a
 * secret travels only as a file created 0600, and is removed when its run (or
 * pool slot) ends. `pai worker gc` sweeps whatever a crash left behind.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readWorkersSection } from "./config.js";
import { workersLogDir } from "./paths.js";
import { isLive, loadStatuses } from "./status.js";

const SUFFIX = ".settings.json";
const DAY_MS = 24 * 3600_000;

/** Write `text` owner-only; chmod too, since the mode of an existing file is not touched by writeFileSync. */
export function writePrivateFile(path: string, text: string): void {
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Where pin files live: <logDir>/settings, owner-only. */
export function pinDir(): string {
  const dir = join(workersLogDir(readWorkersSection().workers), "settings");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Write a settings object that carries a secret to a fresh 0600 file; returns its path. */
export function writePinFile(settings: unknown): string {
  const text = JSON.stringify(settings);
  // named by content: an identical pin from this process reuses its file
  const path = join(pinDir(), `pin-${process.pid}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}${SUFFIX}`);
  writePrivateFile(path, text);
  return path;
}

/** Remove the settings files an argv names (`--settings <file>`); missing files are fine. */
export function removeSettingsFiles(argv: readonly string[] | undefined): void {
  if (!argv) return;
  argv.forEach((a, i) => {
    if (a !== "--settings") return;
    const p = argv[i + 1];
    if (p && p.endsWith(SUFFIX)) rmSync(p, { force: true });
  });
}

/**
 * Settings files older than a day whose run is no longer live: every
 * `<wid>.settings.json` in the log dir, pool slot files, and pin files.
 * Returns the paths removed (or that would be).
 */
export function gcSettingsFiles(logDir: string, dryRun = false, now = Date.now()): string[] {
  const live = new Set(loadStatuses(logDir).filter((s) => isLive(s)).map((s) => s.id));
  const out: string[] = [];
  for (const dir of [logDir, join(logDir, "settings")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      if (live.has(name.slice(0, -SUFFIX.length))) continue;
      const path = join(dir, name);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime < DAY_MS) continue;
      if (!dryRun) rmSync(path, { force: true });
      out.push(path);
    }
  }
  return out;
}

/** Remove the pin files this process wrote (their names carry its pid). */
export function removePinFilesOfProcess(pid = process.pid): void {
  let dir: string;
  try {
    dir = join(workersLogDir(readWorkersSection().workers), "settings");
  } catch {
    return;
  }
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (name.startsWith(`pin-${pid}-`) && name.endsWith(SUFFIX)) rmSync(join(dir, name), { force: true });
}

/** A run's own settings: the slim profile file and this process's pin files. */
export function removeRunSettings(logDir: string, wid: string): void {
  rmSync(join(logDir, `${wid}${SUFFIX}`), { force: true });
  removePinFilesOfProcess();
}
