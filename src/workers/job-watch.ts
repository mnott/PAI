/**
 * job-watch.ts — does a worker own a build/test job, or wait on a growing log, within a budget window?
 * The checkpoint used to read only the instant state: a build that ran 00:17-00:20 and failed
 * seconds before the 00:20:44 checkpoint left an empty queue, so a worker that had just waited on it
 * (`pai worker wait-on --log`) was stopped for "no progress". The watch is sampled between checkpoints
 * and remembers when a job was last seen, so a job that ran inside the window still counts.
 */
import { statSync } from "node:fs";
import { buildsDir, listBuildsSync } from "../builds/queue.js";
import { loadStatus } from "./status.js";

/** A build/test ticket of this worker (running, or waiting for a slot) whose gate process is alive. */
export function ownsLiveBuildJob(wid: string, dir: string = buildsDir()): boolean {
  try {
    return listBuildsSync(dir).some((t) => t.worker === wid && (t.state === "running" || t.state === "waiting"));
  } catch {
    return false;
  }
}

/** The log the worker is waiting on (`pai worker wait-on --log`) was written at or after `sinceMs`. */
export function waitedLogGrowing(logDir: string, wid: string, sinceMs: number): boolean {
  try {
    const log = loadStatus(logDir, wid)?.waitingOn?.log;
    return !!log && statSync(log).mtimeMs >= sinceMs;
  } catch {
    return false;
  }
}

export interface JobWatchOpts {
  wid: string;
  logDir: string;
  dir?: string;
  now?: () => number;
}

export interface JobWatch {
  /** Look now; remembers the time when a job or a growing waited-on log is seen. */
  sample(): boolean;
  /** A job was seen at any sample since `sinceMs` (and one is looked for now). */
  activeSince(sinceMs: number): boolean;
}

export function createJobWatch(o: JobWatchOpts): JobWatch {
  const now = o.now ?? Date.now;
  let lastSeen = 0;
  let lastSample = now();
  const sample = (): boolean => {
    const t = now();
    const hit = ownsLiveBuildJob(o.wid, o.dir) || waitedLogGrowing(o.logDir, o.wid, lastSample);
    lastSample = t;
    if (hit) lastSeen = t;
    return hit;
  };
  return {
    sample,
    activeSince: (sinceMs) => {
      sample();
      return lastSeen > 0 && lastSeen >= sinceMs;
    },
  };
}
