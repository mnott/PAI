/**
 * orchestrate-merge.ts — several `pai worker run --class orchestrate` requests for the same repo
 * that arrive within workers.orchestrate.mergeWindowSec become ONE L1 job with numbered parts
 * (eval night 2026-11-15/16: grouping 2 related tasks per L1 saved money, 1 task per L1 cost more).
 *
 * Each repo has a queue file <logDir>/orchestrate-merge/<key>.json. The first request opens it and
 * leads: it waits out the window, closes the queue and starts one L1 on the combined brief. A request
 * that finds an open queue appends itself and follows: it prints which job it joined and exits 0
 * (the leader's worker id is the one to wait on). A lone request runs unchanged. Queue steps
 * (join / close) run under a short mkdir lock; the decision functions are pure.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MERGE_WINDOW_SEC = 20;

export interface MergeRequest {
  /** The requesting process. */
  pid: number;
  label: string;
  prompt: string;
  /** Epoch ms of the request. */
  at: number;
}

export interface MergeQueue {
  repo: string;
  /** Epoch ms the window closes (first request + window). */
  until: number;
  closed?: boolean;
  /** The leader's worker id, once started. */
  leaderId?: string;
  requests: MergeRequest[];
}

export type JoinResult =
  | { role: "leader"; queue: MergeQueue }
  | { role: "follower"; queue: MergeQueue; part: number };

/** Pure: what a new request does to the repo's queue (null = none yet). */
export function joinQueue(queue: MergeQueue | null, repo: string, req: MergeRequest, windowSec: number): JoinResult {
  if (queue && !queue.closed && req.at < queue.until) {
    const next = { ...queue, requests: [...queue.requests, req] };
    return { role: "follower", queue: next, part: next.requests.length };
  }
  return { role: "leader", queue: { repo, until: req.at + windowSec * 1000, requests: [req] } };
}

/** Pure: the one brief an L1 gets for the merged requests (numbered parts, each request's own text unchanged). */
export function mergedBrief(reqs: MergeRequest[]): { prompt: string; label: string } {
  if (reqs.length === 1) return { prompt: reqs[0].prompt, label: reqs[0].label };
  const head =
    `This is ONE orchestration job with ${reqs.length} numbered parts, requested together for the same repository. ` +
    "Plan them as a whole (shared files, one order), dispatch every part's children first, and report each part in your R message as `part N: …` (c=, t= and z= cover all parts).";
  const parts = reqs.map((r, i) => `## Part ${i + 1}: ${r.label}\n\n${r.prompt.trim()}`);
  return { prompt: `${head}\n\n${parts.join("\n\n")}`, label: `${reqs.length} parts: ${reqs.map((r) => r.label).join(" + ")}`.slice(0, 120) };
}

/** The line printed for every merged request. */
export const mergeNotice = (reqs: MergeRequest[]): string =>
  `pai worker: merged ${reqs.length} orchestrate requests for one repo into one L1 job: ${reqs.map((r, i) => `part ${i + 1} = ${r.label}`).join("; ")}`;

const dirOf = (logDir: string): string => join(logDir, "orchestrate-merge");
const queueFile = (logDir: string, repo: string): string => join(dirOf(logDir), `${createHash("sha1").update(repo).digest("hex").slice(0, 16)}.json`);

export function readQueue(logDir: string, repo: string): MergeQueue | null {
  try {
    return JSON.parse(readFileSync(queueFile(logDir, repo), "utf8")) as MergeQueue;
  } catch {
    return null;
  }
}

function writeQueue(logDir: string, repo: string, q: MergeQueue): void {
  const f = queueFile(logDir, repo);
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(q), "utf8");
  renameSync(tmp, f);
}

/** Run `fn` holding the repo's short queue lock (mkdir is atomic); a lock older than 10 s is stale and taken over. */
export async function withQueueLock<T>(logDir: string, repo: string, fn: () => T, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  mkdirSync(dirOf(logDir), { recursive: true });
  const lock = `${queueFile(logDir, repo)}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i >= 100) {
        try {
          rmdirSync(lock);
        } catch {
          /* held by a live peer: retry */
        }
        i = 0;
      }
      await sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Register a request: leads a new queue or joins an open one. */
export function joinRepoQueue(logDir: string, repo: string, req: MergeRequest, windowSec: number): Promise<JoinResult> {
  return withQueueLock(logDir, repo, () => {
    const r = joinQueue(readQueue(logDir, repo), repo, req, windowSec);
    writeQueue(logDir, repo, r.queue);
    return r;
  });
}

/** Leader: close the queue (later requests start a new one) and return every request in it, own first. */
export function closeQueue(logDir: string, repo: string): Promise<MergeRequest[]> {
  return withQueueLock(logDir, repo, () => {
    const q = readQueue(logDir, repo);
    if (!q) return [];
    writeQueue(logDir, repo, { ...q, closed: true });
    return q.requests;
  });
}

/** Leader: publish the worker id the followers point at. */
export function announceLeader(logDir: string, repo: string, id: string): Promise<void> {
  return withQueueLock(logDir, repo, () => {
    const q = readQueue(logDir, repo);
    if (q) writeQueue(logDir, repo, { ...q, leaderId: id });
  });
}

/** Follower: wait (bounded) for the leader's worker id. */
export async function waitLeaderId(logDir: string, repo: string, maxMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), now: () => number = Date.now): Promise<string | undefined> {
  const end = now() + maxMs;
  while (now() < end) {
    const id = readQueue(logDir, repo)?.leaderId;
    if (id) return id;
    await sleep(500);
  }
  return undefined;
}

export const queueExists = (logDir: string, repo: string): boolean => existsSync(queueFile(logDir, repo));
