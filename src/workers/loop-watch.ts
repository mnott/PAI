/**
 * loop-watch.ts — detect and respond to repeated failing tool calls.
 *
 * Scans running workers for repeated failing tool calls, and:
 * - warns local workers (via say) when 3+ calls fail
 * - stops local workers (via kill) when 6+ calls fail
 * - warns cloud workers (no say) when 3+ calls fail
 */

import { eventsPath } from "./paths.js";
import { WorkerStatus } from "./status.js";
import { detectRepeatLoop, loopAction, type RepeatLoop } from "./repeat-loop.js";

export const LOOP_NOTE = "you have repeated the same failing call 3 times; the file already contains this text or your old_string is wrong: re-read the file region or move on";

export interface LoopFinding {
  worker: string;
  action: "warn" | "stop";
  loop: RepeatLoop;
  local: boolean;
}

export interface LoopDeps {
  readEvents?: (logDir: string, id: string) => unknown[];
  say?: (logDir: string, id: string, text: string) => Promise<unknown>;
  kill?: (pid: number) => void;
}

export async function checkLoops(logDir: string, statuses: WorkerStatus[], sent: Record<string, string>, deps: LoopDeps = {}): Promise<LoopFinding[]> {
  const {
    readEvents = async (logDir, id) => {
      const path = eventsPath(logDir, id);
      const fs = await import("node:fs");
      try {
        const data = fs.readFileSync(path, "utf8");
        const lines = data.split("\n");
        const events: unknown[] = [];
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            events.push(JSON.parse(line));
          } catch {
            // skip bad lines
          }
        }
        return events;
      } catch (err: any) {
        // Return empty array if file doesn't exist or can't be read
        if (err.code === "ENOENT") {
          return [];
        }
        throw err;
      }
    },
    say = async (logDir, id, text) => {
      const { sayToWorker } = await import("./operator.js");
      return sayToWorker(logDir, id, text);
    },
    kill = (pid: number) => {
      process.kill(pid, "SIGTERM");
    },
  } = deps;

  const findings: LoopFinding[] = [];

  for (const status of statuses) {
    if (status.state !== "running") continue;

    try {
      const events = await readEvents(logDir, status.id);
      const loop = detectRepeatLoop(events);
      if (!loop) continue;

      const action = loopAction(loop.count);
      if (action === "none") continue;

      const local = status.provider !== "anthropic";
      const dedupKey = `${action}:${loop.name}:${loop.input.slice(0, 80)}`;
      if (sent[status.id] === dedupKey) continue;
      sent[status.id] = dedupKey;

      if (action === "warn" && local) {
        try {
          await say(logDir, status.id, LOOP_NOTE);
        } catch {
          // errors swallowed
        }
      } else if (action === "stop") {
        try {
          kill(status.pid);
        } catch {
          // errors swallowed
        }
      }

      findings.push({
        worker: status.id,
        action,
        loop,
        local,
      });
    } catch {
      // If a single worker's processing fails, skip it and continue with others
      // This prevents one broken worker from stopping the entire loop detection
    }
  }

  return findings;
}