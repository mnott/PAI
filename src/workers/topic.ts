/**
 * topic.ts — the topic of a job: the one label that groups related work in the queue.
 *
 * Set with `--topic`; a child of a running worker inherits its parent's topic; a continuation
 * (resume, reroute, escalation, fall-through) keeps the topic of the run it continues. A job with
 * none of these gets one word from the small local model (helperPickTopic below): never guessed by
 * the big engine, and never blocks or delays the start.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperComplete, type HelperDeps } from "./helper.js";
import { loadStatus, saveStatus } from "./status.js";

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

// ---- the helper's topic word -------------------------------------------------------------------

/** The closed list: topics already used in the status files, lowercased and single-word. */
export const TOPIC_WORDS = [
  "harness", "workers", "cockpit", "router", "codegraph", "strata", "queue", "supervision",
  "memory", "helpers", "tests", "sessions", "models", "todoist", "guards", "mailbox",
] as const;

/** What the helper may answer with: a word of the closed list, or a new single lowercase word. */
const TOPIC_ANSWER_RE = /^[a-z][a-z0-9]{1,15}$/;

/** The chip's own cap: two words never fit it anyway. */
const HELPER_TOPIC_MAX = 16;

/** "strata", " Topic: queue.", "[\"tests\"]" → the word; prose or a two-word answer → null. */
export function parseTopicWord(text: string): string | null {
  const m = text.toLowerCase().trim().match(/^[\s<["'*]*(?:topic\s*[:\-–—]\s*)?([a-z][a-z0-9]{1,15})\b[>\]"'*]*\s*\.?$/);
  return m ? m[1] : null;
}

/**
 * One topic word for a job with none: the small local model picks from the closed list
 * (or coins one new lowercase word) off the label + the spec's first lines. Cached per
 * worker at <logDir>/<id>.topic, like the TL;DR cache. null = no answer (off, down, busy,
 * junk): nothing is guessed and the job simply has no topic. Blocks at most 10 s.
 */
export async function helperPickTopic(logDir: string, id: string, label: string, specText: string, deps: HelperDeps = {}): Promise<string | null> {
  const f = join(logDir, `${id}.topic`);
  try {
    if (existsSync(f)) return normalizeTopic(readFileSync(f, "utf8").trim()) ?? null;
  } catch {
    /* regenerate */
  }
  const brief = `${label}\n${specText.slice(0, 700)}`.slice(0, 900);
  const text = await helperComplete(
    {
      label: "topic",
      maxTokens: 8,
      timeoutMs: 10_000,
      keep: "head",
      task: `Pick the ONE topic word for this AI-coding-agent job. Prefer one of: ${TOPIC_WORDS.join(", ")}. Only if none fits, coin one new short lowercase English word. Reply with that single word alone, nothing else.`,
      input: brief,
    },
    deps
  );
  if (text === null) return null;
  const w = parseTopicWord(text);
  if (!w) return null;
  const topic = w.slice(0, HELPER_TOPIC_MAX);
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(f, topic + "\n");
  } catch {
    /* the cache is best effort */
  }
  return topic;
}

const started = new Set<string>();

/**
 * Fire-and-forget the topic word of a job that has none: when it lands, it joins the status
 * file (a worker's own periodic writes never drop it). Never blocks a start, never waits on
 * the helper, never falls back to a big engine — when apple-fm is off, down or busy the job
 * simply keeps no topic.
 */
export function pickTopicAsync(logDir: string, id: string, label: string, specText: string, deps: HelperDeps = {}): void {
  if (started.has(id)) return;
  started.add(id);
  void helperPickTopic(logDir, id, label, specText, deps)
    .then((w) => {
      if (!w) return;
      const st = loadStatus(logDir, id);
      if (!st || st.topic) return;
      // external=true: a one-shot writer in another flow of this process (like `pai worker goal`),
      // whose copy is the fresh load — nothing on disk may be overridden by it
      saveStatus(logDir, { ...st, topic: w.slice(0, TOPIC_MAX) }, new Date(), true);
    })
    .catch(() => undefined)
    .finally(() => started.delete(id));
}

/** Test seam: forget in-flight picks. */
export function resetTopicPickState(): void {
  started.clear();
}
