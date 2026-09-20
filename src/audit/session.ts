/**
 * `pai audit tokens session` — where a live session's context budget
 * actually goes: cache reads vs. cache writes vs. fresh input vs. output,
 * and the cache-TTL split (ephemeral 5m vs 1h) that says which cache the
 * session is riding.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSessionUsage, totalUsageTokens, type SessionUsageReport } from "./session-usage.js";

/** Newest *.jsonl under ~/.claude/projects, excluding subagents/. */
export function newestSessionLog(): string | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  let best: { path: string; mtime: number } | null = null;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    const dirPath = join(projectsDir, projectDir);
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, entry);
      let mtime: number;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { path: filePath, mtime };
    }
  }
  return best?.path ?? null;
}

export interface SessionReportOutput extends SessionUsageReport {
  totalTokens: number;
  percentages: Record<string, number>;
}

export async function auditSession(path?: string): Promise<SessionReportOutput | null> {
  const target = path ?? newestSessionLog();
  if (!target) return null;
  const report = await parseSessionUsage(target);
  const total = totalUsageTokens(report.totals) || 1;
  const percentages: Record<string, number> = {};
  for (const [key, value] of Object.entries(report.totals)) {
    percentages[key] = (100 * value) / total;
  }
  return { ...report, totalTokens: total, percentages };
}
