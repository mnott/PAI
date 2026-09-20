/**
 * `pai audit tokens spawn` — spawn-overhead comparison from existing logs,
 * no new LLM calls: Agent-tool subagents vs. pai workers (split further into
 * interactive/pane vs. headless -p), each read for first-turn context.
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWorkersSection } from "../workers/config.js";
import { workersLogDir } from "../workers/paths.js";
import { parseSessionUsage } from "./session-usage.js";
import { countTokens } from "./tokens.js";

export type SpawnGroupName = "agentSubagents" | "workersInteractive" | "workersHeadless";

export interface SpawnLogReading {
  path: string;
  firstTurnContext: number | null;
  model: string | null;
  promptTokens: number | null;
  overhead: number | null;
  group: SpawnGroupName;
}

export interface SpawnGroupStats {
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  medianOverhead: number | null;
  models: string[];
}

export interface SpawnReport {
  agentSubagents: SpawnGroupStats;
  workersInteractive: SpawnGroupStats;
  workersHeadless: SpawnGroupStats;
  readings: SpawnLogReading[];
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

interface UserLine {
  type?: string;
  session_id?: string;
  message?: { content?: string | Array<{ text?: string }> };
}

/** Token count of the first `type:"user"` message's text, or null if none found. */
export async function firstUserPromptTokens(path: string): Promise<number | null> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let obj: UserLine;
      try {
        obj = JSON.parse(raw) as UserLine;
      } catch {
        continue;
      }
      if (obj.type !== "user") continue;
      const content = obj.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => part?.text ?? "").join(" ")
            : "";
      return countTokens(text);
    }
  } finally {
    rl.close();
  }
  return null;
}

/** `session_id` off the first record that carries one, or null if none do. */
export async function firstSessionId(path: string): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let obj: UserLine;
      try {
        obj = JSON.parse(raw) as UserLine;
      } catch {
        continue;
      }
      if (obj.session_id) return obj.session_id;
    }
  } finally {
    rl.close();
  }
  return null;
}

/** `~/.claude/projects/**\/<sessionId>.jsonl`, searched only under the projects dir. */
export function findSessionTranscript(
  sessionId: string,
  projectsDir: string = join(homedir(), ".claude", "projects")
): string | null {
  const target = `${sessionId}.jsonl`;
  const stack = [projectsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === target) {
        return full;
      }
    }
  }
  return null;
}

/**
 * The mirror log has no `type:"user"` record (worker event mirrors carry
 * system/assistant/result records only, never the -p prompt itself), so
 * fall back to the session's own transcript under ~/.claude/projects,
 * located via whichever record in the mirror log carries a `session_id`.
 */
async function resolvePromptTokens(mirrorPath: string): Promise<number | null> {
  const direct = await firstUserPromptTokens(mirrorPath);
  if (direct !== null) return direct;
  const sessionId = await firstSessionId(mirrorPath);
  if (!sessionId) return null;
  const transcript = findSessionTranscript(sessionId);
  if (!transcript) return null;
  return firstUserPromptTokens(transcript);
}

async function readOne(path: string, group: SpawnGroupName): Promise<SpawnLogReading> {
  const [report, promptTokens] = await Promise.all([parseSessionUsage(path), resolvePromptTokens(path)]);
  const model = Object.keys(report.models)[0] ?? null;
  const overhead =
    report.firstTurnContext !== null && promptTokens !== null ? report.firstTurnContext - promptTokens : null;
  return { path, firstTurnContext: report.firstTurnContext, model, promptTokens, overhead, group };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(readings: SpawnLogReading[]): SpawnGroupStats {
  const contexts = readings.map((r) => r.firstTurnContext).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const overheads = readings.map((r) => r.overhead).filter((v): v is number => v !== null);
  const models = [...new Set(readings.map((r) => r.model).filter((m): m is string => !!m))];
  if (contexts.length === 0) {
    return { count: readings.length, min: null, median: null, max: null, medianOverhead: median(overheads), models };
  }
  return {
    count: readings.length,
    min: contexts[0],
    median: median(contexts),
    max: contexts[contexts.length - 1],
    medianOverhead: median(overheads),
    models,
  };
}

export async function auditSpawn(n = 10): Promise<SpawnReport> {
  const { workers } = readWorkersSection();
  const logDir = workersLogDir(workers);

  const agentLogs = newestAgentSubagentLogs(n);
  const agentReadings = await Promise.all(agentLogs.map((path) => readOne(path, "agentSubagents")));

  const workerLogs = newestWorkerLogs(logDir, n);
  const workerReadings = await Promise.all(workerLogs.map((path) => readOne(path, "workersInteractive")));

  const interactive: SpawnLogReading[] = [];
  const headless: SpawnLogReading[] = [];
  for (const reading of workerReadings) {
    const status = readWorkerStatus(logDir, workerIdFromLogPath(reading.path));
    if (status?.outputFormat) headless.push({ ...reading, group: "workersHeadless" });
    else interactive.push(reading);
  }

  return {
    agentSubagents: summarize(agentReadings),
    workersInteractive: summarize(interactive),
    workersHeadless: summarize(headless),
    readings: [...agentReadings, ...interactive, ...headless],
  };
}
