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
import { encodeDir } from "../cli/utils.js";
import { firstTurnBreakdown, type FirstTurnBreakdown } from "./first-turn.js";
import { loadConfig } from "../daemon/config.js";
import { deriveSessionTrigger, type WindowSource, type SessionTriggerSource } from "./context-trigger.js";

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
  firstTurn: FirstTurnBreakdown | null;
  /** The session's own context window (from its transcript, or the last
   *  assistant model id — see context-trigger.ts), never a constant assumed
   *  for every session. */
  window: number;
  windowSource: WindowSource;
  /** The compaction trigger this window derives to — what `threshold`
   *  (turnsAboveThreshold, and the caller's ctxThreshold for severity) was
   *  actually set from, unless `--ctx-threshold` overrode it. */
  trigger: number;
  autocompactPct: number;
  triggerSource: SessionTriggerSource;
}

/**
 * `threshold`, when given (`--ctx-threshold`), is an explicit override for
 * both the per-turn "above threshold" count and the trigger reported below.
 * Left undefined, the trigger — and the threshold used to parse the
 * transcript — are DERIVED from the session's own window and this project's
 * own measured/configured compaction trigger (deriveSessionTrigger), never
 * assumed to be 200k regardless of the session.
 */
export async function auditSession(path?: string, threshold?: number): Promise<SessionReportOutput | null> {
  const target = path ?? newestSessionLog();
  if (!target) return null;
  const keepaliveWord = loadConfig().sessions.cacheKeepalive.prompt;
  const derived = deriveSessionTrigger(target);
  const effectiveThreshold = threshold ?? derived.trigger;
  const report = await parseSessionUsage(target, effectiveThreshold, keepaliveWord);
  const total = totalUsageTokens(report.totals) || 1;
  const percentages: Record<string, number> = {};
  for (const [key, value] of Object.entries(report.totals)) {
    percentages[key] = (100 * value) / total;
  }
  return {
    ...report,
    totalTokens: total,
    percentages,
    firstTurn: firstTurnBreakdown(target),
    window: derived.window,
    windowSource: derived.windowSource,
    trigger: effectiveThreshold,
    autocompactPct: derived.autocompactPct,
    triggerSource: threshold !== undefined ? "override" : derived.triggerSource,
  };
}

export interface SessionHistoryRow {
  path: string;
  sessionId: string;
  firstTurnAt: string | null;
  firstTurnContext: number | null;
  turns: number;
  models: Record<string, number>;
  switches: number;
  fallbacks: number;
}

/**
 * First-turn context of every session transcript in this project's
 * `~/.claude/projects/<encoded-cwd>` directory, newest first — the readings
 * needed to see when a step change (model switch, hook growth) happened
 * across sessions without an ad-hoc script.
 */
export async function sessionHistory(cwd: string, limit = 20): Promise<SessionHistoryRow[]> {
  const dir = join(homedir(), ".claude", "projects", encodeDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const rows: SessionHistoryRow[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const report = await parseSessionUsage(path);
    if (report.turns === 0) continue;
    rows.push({
      path,
      sessionId: entry.replace(/\.jsonl$/, ""),
      firstTurnAt: report.firstTurnAt,
      firstTurnContext: report.firstTurnContext,
      turns: report.turns,
      models: report.models,
      switches: report.modelSwitches.length,
      fallbacks: report.fallbacks.length,
    });
  }

  rows.sort((a, b) => {
    if (a.firstTurnAt === null && b.firstTurnAt === null) return 0;
    if (a.firstTurnAt === null) return 1;
    if (b.firstTurnAt === null) return -1;
    return b.firstTurnAt.localeCompare(a.firstTurnAt);
  });

  return rows.slice(0, limit);
}
