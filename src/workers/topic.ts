/**
 * topic.ts — the topic of a job: the one label that groups related work in the queue.
 *
 * Set with `--topic`; a child of a running worker inherits its parent's topic; a continuation
 * (resume, reroute, escalation, fall-through) keeps the topic of the run it continues. A job with
 * none of these has no topic: it is never guessed from the label.
 */

import { loadStatus } from "./status.js";

/** Longest topic kept; the cockpit chip shortens it further (TOPIC_CHIP_MAX). */
export const TOPIC_MAX = 60;
/** Chip text width in the cockpit and the tables. */
export const TOPIC_CHIP_MAX = 16;

export function normalizeTopic(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX);
  return t || undefined;
}

/** "code graph" fits; "a very long topic name" becomes "a very long top…". */
export function topicChip(topic: string, max = TOPIC_CHIP_MAX): string {
  return topic.length > max ? topic.slice(0, max - 1) + "…" : topic;
}

export function resolveTopic(
  logDir: string,
  explicit: unknown,
  continued: Array<string | undefined>,
  parent: string | null | undefined
): string | undefined {
  const own = normalizeTopic(explicit) ?? normalizeTopic(process.env.PAI_TOPIC);
  if (own) return own;
  for (const id of continued) {
    const t = id ? normalizeTopic(loadStatus(logDir, id)?.topic) : undefined;
    if (t) return t;
  }
  return parent ? normalizeTopic(loadStatus(logDir, parent)?.topic) : undefined;
}
