/**
 * `pai audit tokens schedule` — anything that wakes up more often than the
 * measured cache TTL burns a full cache-write every time, since the
 * previous cache entry has already expired.
 */

import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheCreationSplit } from "./session-usage.js";

const DEFAULT_TTL_SECONDS = 3600;

/** Which ephemeral cache dominates a session's cache writes, as a TTL in seconds. */
export function cacheTtlSeconds(split: CacheCreationSplit | null | undefined): number {
  if (!split || split.ephemeral5m + split.ephemeral1h === 0) return DEFAULT_TTL_SECONDS;
  return split.ephemeral1h >= split.ephemeral5m ? 3600 : 300;
}

export interface LaunchAgentEntry {
  path: string;
  label: string | null;
  startInterval: number | null;
  startCalendarInterval: unknown;
  keepAlive: unknown;
  programArgs: string[];
  exceedsTtl: boolean;
}

interface PlistJson {
  Label?: string;
  StartInterval?: number;
  StartCalendarInterval?: unknown;
  KeepAlive?: unknown;
  ProgramArguments?: string[];
}

function readPlistJson(path: string): PlistJson | null {
  try {
    const out = execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
    return JSON.parse(out) as PlistJson;
  } catch {
    return null;
  }
}

export function listLaunchAgents(ttlSeconds: number): LaunchAgentEntry[] {
  const dir = join(homedir(), "Library", "LaunchAgents");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".plist"));
  } catch {
    return [];
  }
  const entries: LaunchAgentEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const plist = readPlistJson(path);
    const startInterval = plist?.StartInterval ?? null;
    entries.push({
      path,
      label: plist?.Label ?? null,
      startInterval,
      startCalendarInterval: plist?.StartCalendarInterval ?? null,
      keepAlive: plist?.KeepAlive ?? null,
      programArgs: (plist?.ProgramArguments ?? []).slice(0, 2),
      exceedsTtl: startInterval !== null && startInterval > ttlSeconds,
    });
  }
  return entries;
}

export function readCrontab(): string[] {
  try {
    const out = execFileSync("crontab", ["-l"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  } catch {
    return [];
  }
}

export interface ScheduleReport {
  ttlSeconds: number;
  agents: LaunchAgentEntry[];
  crontabLines: string[];
}

export function auditSchedule(ttlSeconds = DEFAULT_TTL_SECONDS): ScheduleReport {
  return { ttlSeconds, agents: listLaunchAgents(ttlSeconds), crontabLines: readCrontab() };
}

export { DEFAULT_TTL_SECONDS };
