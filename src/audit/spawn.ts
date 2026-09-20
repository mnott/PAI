/**
 * `pai audit tokens spawn` — spawn-overhead comparison from existing logs,
 * no new LLM calls: Agent-tool subagents vs. pai workers (split further into
 * interactive/pane vs. headless -p), each read for first-turn context.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { parseSessionUsage } from "./session-usage.js";

export interface SpawnLogReading {
  path: string;
  firstTurnContext: number | null;
  model: string | null;
}

export interface SpawnGroupStats {
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  models: string[];
}

export interface SpawnReport {
  agentSubagents: SpawnGroupStats;
  workersInteractive: SpawnGroupStats;
  workersHeadless: SpawnGroupStats;
}

function newestN(paths: string[], n: number): string[] {
  return paths
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n)
    .map((entry) => entry.path);
}

/** Newest N ~/.claude/projects/<project>/<session>/subagents/*.jsonl files. */
export function newestAgentSubagentLogs(n = 10): string[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  const found: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const sessionsRoot = join(projectsDir, projectDir);
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(sessionsRoot);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const subagentsDir = join(sessionsRoot, sessionDir, "subagents");
      let files: string[];
      try {
        files = readdirSync(subagentsDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith(".jsonl")) found.push(join(subagentsDir, file));
      }
    }
  }
  return newestN(found, n);
}

/** Newest N pai-worker event-mirror *.jsonl files (excludes *.inbox.jsonl). */
export function newestWorkerLogs(logDir: string, n = 10): string[] {
  let files: string[];
  try {
    files = readdirSync(logDir);
  } catch {
    return [];
  }
  const eventLogs = files
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".inbox.jsonl"))
    .map((f) => join(logDir, f));
  return newestN(eventLogs, n);
}

function workerIdFromLogPath(path: string): string {
  return path
    .split("/")
    .pop()!
    .replace(/\.jsonl$/, "");
}

/** Read `<id>.status` next to a worker event log; null if missing/unreadable. */
function readWorkerStatus(logDir: string, id: string): { outputFormat?: string } | null {
  const statusFile = join(logDir, `${id}.status`);
  if (!existsSync(statusFile)) return null;
  try {
    return JSON.parse(readFileSync(statusFile, "utf8")) as { outputFormat?: string };
  } catch {
    return null;
  }
}

async function readOne(path: string): Promise<SpawnLogReading> {
  const report = await parseSessionUsage(path);
  const model = Object.keys(report.models)[0] ?? null;
  return { path, firstTurnContext: report.firstTurnContext, model };
}

function summarize(readings: SpawnLogReading[]): SpawnGroupStats {
  const contexts = readings.map((r) => r.firstTurnContext).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const models = [...new Set(readings.map((r) => r.model).filter((m): m is string => !!m))];
  if (contexts.length === 0) return { count: readings.length, min: null, median: null, max: null, models };
  const mid = Math.floor(contexts.length / 2);
  const median = contexts.length % 2 ? contexts[mid] : (contexts[mid - 1] + contexts[mid]) / 2;
  return { count: readings.length, min: contexts[0], median, max: contexts[contexts.length - 1], models };
}

export async function auditSpawn(n = 10): Promise<SpawnReport> {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);

  const agentLogs = newestAgentSubagentLogs(n);
  const agentReadings = await Promise.all(agentLogs.map(readOne));

  const workerLogs = newestWorkerLogs(logDir, n);
  const workerReadings = await Promise.all(workerLogs.map(readOne));

  const interactive: SpawnLogReading[] = [];
  const headless: SpawnLogReading[] = [];
  for (const reading of workerReadings) {
    const status = readWorkerStatus(logDir, workerIdFromLogPath(reading.path));
    if (status?.outputFormat) headless.push(reading);
    else interactive.push(reading);
  }

  return {
    agentSubagents: summarize(agentReadings),
    workersInteractive: summarize(interactive),
    workersHeadless: summarize(headless),
  };
}
