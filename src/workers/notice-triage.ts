/**
 * notice-triage.ts — urgent vs routine, and the routine digest.
 *
 * Every machine notice that reaches a session costs one full main-context
 * turn (2026-11-19: the L0 woke for every "finished rc=0", every [model] tool
 * error the worker fixes itself, every test-count reminder, every stall of a
 * worker merely in line). Most of them need no action, so they stop waking the
 * session: each notice is classified at its source —
 *
 *   urgent  — failed/killed workers needing a decision, [harness] tool errors,
 *             stopped-for-review, guard-denial loops and loop-guard stops,
 *             daemon/router health, budget/gatekeeper requests. Sent
 *             immediately, exactly as before.
 *   routine — finished rc=0, [model]/[unknown] single tool-error occurrences,
 *             in-line stall notices, test-count reminders. They land in a
 *             per-session digest file (<logDir>/supervision/<session>.digest)
 *             and are delivered as ONE mailbox message at most every
 *             notices.digest.everyMinutes (config, default 30), and only when
 *             the digest is non-empty. The test-count reminder ([pai tests]) is
 *             sent at most once per day: a later reminder that day replaces
 *             the earlier one in the digest.
 *
 * The triage itself is pure (classifyNotice); batching and delivery are the
 * exported functions below, injected-clock-testable without AIBroker.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { supervisionDirPath } from "./supervision.js";
import type { Messenger, RunOrigin } from "./run-events.js";

export type NoticePriority = "urgent" | "routine";

/** The daily cap of the test-count reminder ([pai tests] …). */
const TESTS_REMINDER_MS = 86_400_000;
/** A digest older than this is stale context, not news: it is dropped unsent. */
export const DIGEST_MAX_AGE_MS = 24 * 3_600_000;

/**
 * The one classification table. First match wins; an unrecognised notice stays
 * urgent — silence about the unknown is what made the 2026-10-17 incident.
 */
export function classifyNotice(text: string): NoticePriority {
  const t = text.trim();
  // test-count reminder: routine (its own once-per-day cap lives in the digest).
  if (t.startsWith("[pai tests]")) return "routine";
  // tool-error alerts carry their class tag; harness faults stay immediate,
  // model and unknown single occurrences are the worker's own business.
  if (t.startsWith("[harness]")) return "urgent";
  if (/^\[model( ×\d+)?\]/.test(t) || t.startsWith("[unknown]") || t.startsWith("[benign]")) return "routine";
  // supervision one-liners and the trouble watcher's stall line: a worker that
  // merely waits (in line at the engine, or quiet while running) is routine —
  // thrashing, sleeping and looping keep acting on their own.
  if (/worker \S+ .*stalled \d+m no turns/.test(t)) return "routine";
  if (/has produced no output for \d+ min while running/.test(t)) return "routine";
  // finished rc=0: nothing to decide. A failed/killed/lost worker is urgent.
  if (/worker \S+ .*finished rc=0\b/.test(t)) return "routine";
  return "urgent";
}

/** The digest interval in ms from notices.digest.everyMinutes (default 30); broken values fall back. */
export function digestIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  let minutes = 30;
  try {
    const n = effectiveMainConfig(paiConfigFilePath()).notices as Record<string, unknown> | undefined;
    const d = typeof n?.digest === "object" && n.digest !== null ? (n.digest as Record<string, unknown>) : {};
    if (typeof d.everyMinutes === "number" && Number.isFinite(d.everyMinutes) && d.everyMinutes > 0) minutes = d.everyMinutes;
  } catch {
    /* the shipped default stands */
  }
  const raw = env.PAI_NOTICE_DIGEST_MINUTES;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) minutes = n;
  }
  return minutes * 60_000;
}

export function digestPath(logDir: string, session: string): string {
  return join(supervisionDirPath(logDir), `${session}.digest`);
}
function lastSentPath(logDir: string, session: string): string {
  return join(supervisionDirPath(logDir), `${session}.digest.sent`);
}

/**
 * Add one routine notice to the session's digest. Lines are unique; a new
 * [pai tests] reminder replaces the day's earlier one (the once-per-day cap:
 * at most one reminder ever sits in the digest). Returns false when the daily
 * cap already holds an entry of the same repo today.
 */
export function appendDigest(logDir: string, session: string, text: string, now = Date.now()): boolean {
  const path = digestPath(logDir, session);
  let lines: string[] = [];
  try {
    if (existsSync(path)) lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    /* a missing digest starts empty */
  }
  const bodyOf = (l: string): string => l.replace(/^\d+ /, "");
  const repoOf = (l: string): string | null => /^\[pai tests\] (\S+) has/.exec(bodyOf(l))?.[1] ?? null;
  if (text.startsWith("[pai tests]")) {
    const repo = repoOf(stamp(text, now));
    // today's cap: an entry recorded within the last day stays, a fresh one replaces it
    const freshToday = lines.some((l) => repoOf(l) === repo && now - stampOf(l) < TESTS_REMINDER_MS);
    if (freshToday) return false;
    lines = lines.filter((l) => repoOf(l) !== repo);
  } else if (lines.map(bodyOf).includes(text)) {
    return false; // the same line queued once is enough
  }
  mkdirSync(supervisionDirPath(logDir), { recursive: true });
  writeFileSync(path, `${lines.concat(stamp(text, now)).join("\n")}\n`, "utf8");
  return true;
}

/** The digest's lines carry a `<stamp> ` prefix so the daily cap can age them. */
function stamp(text: string, now: number): string {
  return `${now} ${text.replace(/\s+/g, " ").trim()}`;
}
function stampOf(line: string): number {
  const n = Number(/^(\d+) /.exec(line)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

/** One mailbox message for the whole digest: a count line, then one line per notice. */
export function composeDigest(lines: string[]): string {
  const body = lines.map((l) => `- ${l.replace(/^\d+ /, "")}`);
  return `[digest ×${lines.length}] routine notices since the last delivery:\n${body.join("\n")}`;
}

/**
 * Deliver the session's digest when it is due: non-empty, and at most once per
 * digestIntervalMs. An empty digest sends nothing; a digest older than
 * DIGEST_MAX_AGE_MS is dropped unsent (stale context). On a failed send the
 * digest stays queued and the retry waits for the next interval. Returns true
 * when a message was sent.
 */
export async function flushDigest(
  logDir: string,
  session: string,
  msg: Pick<Messenger, "toSession">,
  origin: RunOrigin,
  now = Date.now()
): Promise<boolean> {
  const path = digestPath(logDir, session);
  let lines: string[] = [];
  try {
    if (existsSync(path)) lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return false;
  }
  if (!lines.length) return false;
  const sentPath = lastSentPath(logDir, session);
  let lastSent = 0;
  try {
    lastSent = Number(readFileSync(sentPath, "utf8").trim()) || 0;
  } catch {
    /* never sent */
  }
  if (now - lastSent < digestIntervalMs()) return false;
  // the age runs on the OLDEST line: a day-old backlog is stale context even
  // when a fresh notice joined it since
  const ages = lines.map(stampOf).filter((t) => t > 0);
  if (ages.length && now - Math.min(...ages) > DIGEST_MAX_AGE_MS) {
    try {
      unlinkSync(path);
    } catch {
      /* gone already */
    }
    return false;
  }
  const ok = await msg.toSession(origin, composeDigest(lines)).catch(() => false);
  if (!ok) return false;
  // delivered: the digest empties, and the interval clock starts here
  try {
    unlinkSync(path);
    writeFileSync(sentPath, String(now), "utf8");
  } catch {
    /* a lost receipt only risks one early re-send */
  }
  return true;
}

/** Sessions with a queued digest (their key is the file name). */
export function digestSessions(logDir: string): string[] {
  const dir = supervisionDirPath(logDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".digest")).map((f) => f.slice(0, -".digest".length));
  } catch {
    // a dir that vanishes mid-scan has nothing to flush
    return [];
  }
}

/**
 * One routine notice from anywhere outside the supervision tick (the test-count
 * alarm): urgent lines pass through untouched, routine ones join the origin's
 * digest and are delivered by the daemon's digest pass. The key is the env
 * session id when there is one (what flushDigests resolves a pane for), else
 * the best target the origin carries; without any origin nothing queues and
 * the caller keeps its own delivery path.
 */
export async function routeNotice(
  logDir: string,
  msg: Pick<Messenger, "toSession">,
  origin: RunOrigin,
  text: string,
  now = Date.now()
): Promise<boolean> {
  if (classifyNotice(text) === "urgent") return msg.toSession(origin, text);
  const key = origin.claudeSession || origin.iterm || origin.host || origin.name;
  if (!key) return false;
  return appendDigest(logDir, key, text, now);
}
