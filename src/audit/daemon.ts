/**
 * `pai audit tokens daemon` — how much LLM work the background daemon does
 * on its own, parsed from its plain-text log: model spawns, prompt sizes,
 * KG-extraction parse failures, and work-queue job throughput.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonLogPath } from "../runtime-paths.js";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.pai.pai-daemon.plist");

/** StandardErrorPath from the launchd plist, falling back to the runtime default. */
export function resolveDaemonLogPath(): string {
  if (existsSync(PLIST_PATH)) {
    const plist = readFileSync(PLIST_PATH, "utf8");
    const match = plist.match(/<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return match[1];
  }
  return daemonLogPath();
}

export interface ModelSpawnStats {
  count: number;
  avgPromptChars: number;
}

export interface DaemonReport {
  logPath: string;
  windowStart: string | null;
  spawnsByModel: Record<string, ModelSpawnStats>;
  kgParseFailures: number;
  /** Every "[kg-extraction] ..." log line, of any outcome (diagnostic only). */
  kgExtractionLines: number;
  /**
   * kgParseFailures / total session-summary spawns. KG extraction runs once
   * per successful session-summary spawn (session-summary-worker.ts calls
   * extractAndStoreTriples() right after producing a summary) and only ever
   * logs on failure — there is no per-call success line — so the spawn count
   * is the only available denominator for a failure rate.
   */
  kgParseFailureRate: number;
  jobCounts: Record<string, { processing: number; completed: number }>;
}

const SPAWN_LINE = /\[session-summary\] Sending (\d+) char prompt to (\S+?)\.\.\./;
const KG_EXTRACTION_LINE = /^\[kg-extraction\]/;
const KG_PARSE_FAILED = /\[kg-extraction\] JSON parse failed/;
const PROCESSING_LINE = /\[work-queue-worker\] Processing (\S+) \(/;
const COMPLETED_LINE = /\[work-queue-worker\] Completed (\S+) \(/;

export function auditDaemon(logPath = resolveDaemonLogPath()): DaemonReport {
  const spawnsByModel: Record<string, { count: number; totalChars: number }> = {};
  const jobCounts: Record<string, { processing: number; completed: number }> = {};
  let kgParseFailures = 0;
  let kgExtractionLines = 0;
  let windowStart: string | null = null;

  if (existsSync(logPath)) {
    try {
      windowStart = statSync(logPath).birthtime.toISOString();
    } catch {
      windowStart = null;
    }
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      const spawnMatch = line.match(SPAWN_LINE);
      if (spawnMatch) {
        const chars = Number(spawnMatch[1]);
        const model = spawnMatch[2];
        const entry = (spawnsByModel[model] ??= { count: 0, totalChars: 0 });
        entry.count++;
        entry.totalChars += chars;
        continue;
      }
      if (KG_EXTRACTION_LINE.test(line)) {
        kgExtractionLines++;
        if (KG_PARSE_FAILED.test(line)) kgParseFailures++;
        continue;
      }
      const processingMatch = line.match(PROCESSING_LINE);
      if (processingMatch) {
        (jobCounts[processingMatch[1]] ??= { processing: 0, completed: 0 }).processing++;
        continue;
      }
      const completedMatch = line.match(COMPLETED_LINE);
      if (completedMatch) {
        (jobCounts[completedMatch[1]] ??= { processing: 0, completed: 0 }).completed++;
      }
    }
  }

  const spawns: Record<string, ModelSpawnStats> = {};
  for (const [model, { count, totalChars }] of Object.entries(spawnsByModel)) {
    spawns[model] = { count, avgPromptChars: count ? Math.round(totalChars / count) : 0 };
  }

  const totalSpawns = Object.values(spawns).reduce((sum, s) => sum + s.count, 0);
  const kgParseFailureRate = totalSpawns ? kgParseFailures / totalSpawns : 0;

  return {
    logPath,
    windowStart,
    spawnsByModel: spawns,
    kgParseFailures,
    kgExtractionLines,
    kgParseFailureRate,
    jobCounts,
  };
}
