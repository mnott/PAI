/**
 * Review-gated lessons: a short curated memory layer.
 *
 * One Markdown file per lesson under `<PAI home>/lessons/<slug>.md` with YAML
 * frontmatter, so the memory indexer finds them. Candidates (proposed from
 * transcripts or added by hand) only reach agents once approved.
 */

import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { paiConfigFilePath } from "../daemon/config.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { paiHomePath } from "../config/pai-home.js";
import { redactSecrets } from "../utils/redact.js";

export type LessonState = "candidate" | "approved" | "rejected" | "superseded";
export type LessonKind = "workflow" | "correction" | "debugging" | "gotcha" | "convention";

export const LESSON_STATES: LessonState[] = ["candidate", "approved", "rejected", "superseded"];
export const LESSON_KINDS: LessonKind[] = ["workflow", "correction", "debugging", "gotcha", "convention"];

export interface Lesson {
  id: string;
  title: string;
  state: LessonState;
  kind: LessonKind;
  applies_when: string;
  project: string;
  evidence: string[];
  created: string;
  updated: string;
  superseded_by?: string;
  promoted_to?: string[];
  body: string;
}

export interface LessonInput {
  title: string;
  kind: LessonKind;
  applies_when: string;
  project?: string;
  evidence?: string[];
  body?: string;
}

const TRANSITIONS: Record<LessonState, LessonState[]> = {
  candidate: ["approved", "rejected"],
  approved: ["superseded"],
  rejected: ["candidate"],
  superseded: [],
};

/** The lessons directory (`<PAI home>/lessons`). */
export function lessonsDir(): string {
  return paiHomePath("lessons");
}

function lessonPath(id: string): string {
  return join(lessonsDir(), `${id}.md`);
}

/** Lower-case, dash-separated slug of a title (max 60 chars). */
export function slugify(title: string): string {
  const s = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "lesson";
}

export function serializeLesson(l: Lesson): string {
  const { body, ...front } = l;
  const data: Record<string, unknown> = { ...front };
  if (data.superseded_by === undefined) delete data.superseded_by;
  if (data.promoted_to === undefined) delete data.promoted_to;
  return `---\n${stringify(data)}---\n\n${body.trim()}\n`;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseLesson(text: string, fallbackId = ""): Lesson {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("lesson has no YAML frontmatter");
  const f = (parse(m[1]!) ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
  const lesson: Lesson = {
    id: SLUG_RE.test(str(f.id)) ? str(f.id) : fallbackId,
    title: str(f.title),
    state: str(f.state) as LessonState,
    kind: str(f.kind) as LessonKind,
    applies_when: str(f.applies_when),
    project: str(f.project) || "global",
    evidence: Array.isArray(f.evidence) ? f.evidence.map(String) : [],
    created: str(f.created),
    updated: str(f.updated),
    body: m[2]!.trim(),
  };
  if (f.superseded_by) lesson.superseded_by = str(f.superseded_by);
  if (Array.isArray(f.promoted_to)) lesson.promoted_to = f.promoted_to.map(String);
  if (!LESSON_STATES.includes(lesson.state)) throw new Error(`invalid lesson state "${lesson.state}"`);
  return lesson;
}

/** Atomic write: temp file in the same directory, then rename. */
function writeLesson(l: Lesson): void {
  mkdirSync(lessonsDir(), { recursive: true });
  const dest = lessonPath(l.id);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeLesson(l));
  renameSync(tmp, dest);
}

/** All lessons, oldest first; unreadable files are skipped. */
export function listLessons(filter: { state?: LessonState; project?: string } = {}): Lesson[] {
  let files: string[];
  try {
    files = readdirSync(lessonsDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Lesson[] = [];
  for (const f of files) {
    try {
      out.push(parseLesson(readFileSync(join(lessonsDir(), f), "utf8"), basename(f, ".md")));
    } catch {
      continue;
    }
  }
  return out
    .filter((l) => (!filter.state || l.state === filter.state) && (!filter.project || l.project === filter.project))
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

export function getLesson(id: string): Lesson | null {
  if (!SLUG_RE.test(id)) return null;
  const p = lessonPath(id);
  if (!existsSync(p)) return null;
  return parseLesson(readFileSync(p, "utf8"), id);
}

/** Add a candidate lesson; the slug comes from the title, made unique with -2, -3, ... */
export function addLesson(input: LessonInput): Lesson {
  if (!LESSON_KINDS.includes(input.kind)) throw new Error(`invalid kind "${input.kind}" (${LESSON_KINDS.join("|")})`);
  const title = redactSecrets(input.title);
  const base = slugify(title);
  let id = base;
  for (let n = 2; existsSync(lessonPath(id)); n++) id = `${base}-${n}`;
  const now = new Date().toISOString();
  const lesson: Lesson = {
    id,
    title,
    state: "candidate",
    kind: input.kind,
    applies_when: input.applies_when,
    project: input.project || "global",
    evidence: input.evidence ?? [],
    created: now,
    updated: now,
    body: redactSecrets(input.body ?? ""),
  };
  writeLesson(lesson);
  return lesson;
}

/** Move a lesson to a new state along an allowed transition. */
export function setState(id: string, state: LessonState, opts: { supersededBy?: string } = {}): Lesson {
  const lesson = getLesson(id);
  if (!lesson) throw new Error(`lesson not found: ${id}`);
  if (!TRANSITIONS[lesson.state].includes(state)) throw new Error(`illegal transition ${lesson.state} -> ${state}`);
  if (state === "superseded") {
    const by = opts.supersededBy;
    if (!by) throw new Error("superseding needs supersededBy");
    if (by === id || getLesson(by)?.state !== "approved") throw new Error(`superseding lesson must exist and be approved: ${by}`);
    lesson.superseded_by = by;
  }
  lesson.state = state;
  lesson.updated = new Date().toISOString();
  writeLesson(lesson);
  return lesson;
}

/** Skill descriptions are capped at 1024 chars. */
const DESCRIPTION_MAX = 1024;

/**
 * Promote an approved lesson to a project skill: `<projectDir>/.claude/skills/<slug>/SKILL.md`
 * (and with `agentsDir` also `<projectDir>/.agents/skills/<slug>/SKILL.md`).
 * Refuses to overwrite an existing SKILL.md unless `force`. Records the written
 * paths in the lesson's `promoted_to` and returns them.
 */
export function promoteLesson(id: string, opts: { projectDir: string; force?: boolean; agentsDir?: boolean }): string[] {
  const lesson = getLesson(id);
  if (!lesson) throw new Error(`lesson not found: ${id}`);
  if (lesson.state !== "approved") throw new Error(`only approved lessons can be promoted (this one is ${lesson.state})`);
  const slug = slugify(lesson.title);
  const description = `${lesson.title}. USE WHEN ${lesson.applies_when}.`.slice(0, DESCRIPTION_MAX);
  const provenance: Record<string, unknown> = {
    lesson: lesson.id,
    evidence: lesson.evidence,
    promoted: new Date().toISOString(),
  };
  const frontmatter = `---\n${stringify({ name: slug, description, provenance })}---\n\n${lesson.body.trim()}\n\nSource: lesson ${lesson.id}\n`;
  const dirs = [join(opts.projectDir, ".claude", "skills", slug)];
  if (opts.agentsDir) dirs.push(join(opts.projectDir, ".agents", "skills", slug));
  const paths = dirs.map((d) => join(d, "SKILL.md"));
  if (!opts.force) {
    const existing = paths.filter((p) => existsSync(p));
    if (existing.length > 0) throw new Error(`skill already exists: ${existing.join(", ")} (use force to overwrite)`);
  }
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, frontmatter);
  }
  lesson.promoted_to = paths;
  lesson.updated = new Date().toISOString();
  writeLesson(lesson);
  return paths;
}

/** A correction signal must sit in the first 30 chars of the message; later words are not corrections. */
const CORRECTION = [/^\s*no\b[,.!]/i, /\bdon'?t\b/i, /\bnever\b/i, /\bwrong\b/i, /\bthat'?s not\b/i, /\bnein\b/i, /\bfalsch\b/i];
const CORRECTION_WINDOW = 30;

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** Candidate lessons from user messages in a transcript that look like corrections. Deterministic; adds nothing. */
export function proposeFromTranscript(transcriptPath: string): LessonInput[] {
  const sessionId = basename(transcriptPath, ".jsonl");
  const out: LessonInput[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "user" || ev.isMeta) continue;
    const text = userText(ev.message?.content).trim();
    if (!text || text.startsWith("<") || !CORRECTION.some((re) => re.test(text.slice(0, CORRECTION_WINDOW)))) continue;
    const title = redactSecrets(text.replace(/\s+/g, " ")).slice(0, 80);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, kind: "correction", applies_when: "", evidence: [sessionId], body: redactSecrets(text).slice(0, 600) });
  }
  return out;
}

/** Sends one prompt to a model and returns its text; null when no model answered. */
export type ModelClient = (prompt: string) => Promise<string | null>;

export interface DraftOpts {
  /** Model seam (tests inject); default: the running local model, else the routed default. */
  client?: ModelClient;
  /** Max characters of user text per model call. */
  chunkChars?: number;
}

/** Minimum strength a drafted lesson needs to be kept. */
const MIN_STRENGTH = 3;
const CONTEXT_CHARS = 300;
const USER_CHARS = 1500;
const CHUNK_CHARS = 12000;

interface Turn {
  user: string;
  before: string;
}

function stripNoise(text: string): string {
  return text
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|command-[a-z]+|task-notification|tool_use_error)>[\s\S]*?<\/\1>/g, "")
    .replace(/<\/?[a-z][a-z-]*>/g, "")
    .trim();
}

/** The real user messages of a transcript, each with the assistant text just before it (truncated). */
export function extractTurns(transcriptPath: string): Turn[] {
  const turns: Turn[] = [];
  let lastAssistant = "";
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      const t = userText(ev.message?.content).trim();
      if (t) lastAssistant = t;
    } else if (ev.type === "user" && !ev.isMeta) {
      const text = stripNoise(userText(ev.message?.content));
      if (!text) continue;
      turns.push({ user: text.slice(0, USER_CHARS), before: lastAssistant.replace(/\s+/g, " ").slice(0, CONTEXT_CHARS) });
      lastAssistant = "";
    }
  }
  return turns;
}

function draftPrompt(chunk: Turn[]): string {
  const msgs = chunk
    .map((t, i) => `[${i + 1}]${t.before ? `\nassistant before: ${t.before}` : ""}\nuser: ${t.user}`)
    .join("\n\n");
  return (
    "You review a coding-assistant session for durable lessons. Below are the user's messages, each with the assistant text just before it.\n" +
    'Return ONLY a JSON array (no prose) of lessons, each {"title","kind","applies_when","body","evidence_quote","strength","standing"}.\n' +
    `kind is one of ${LESSON_KINDS.join("|")}. evidence_quote is copied verbatim from the user message.\n` +
    "standing is true when the user states a rule for all future work, false for an instruction about the current task only. " +
    "strength is 1-5: 5 = a rule for all future work using words like always/never/must/impossible, or a correction the user repeats; 1 = a one-off instruction for the current task.\n" +
    "Include a lesson ONLY where the user corrects the assistant's behaviour or states a standing rule. " +
    "Return nothing for questions, approvals or chatter. If there is none, return [].\n" +
    'Example standing rule: user "never commit before the tests pass" -> {"standing":true,"strength":5}.\n' +
    'Example one-off instruction: user "change the README teaser to two lines" -> {"standing":false,"strength":1}.\n\n' +
    msgs
  );
}

/** The cap on drafted lessons: `lessons.draft.max` of the effective config (shipped default in config.yaml). */
function draftMax(): number {
  const l = effectiveMainConfig(paiConfigFilePath())["lessons"];
  const d = l && typeof l === "object" ? (l as Record<string, unknown>)["draft"] : undefined;
  const m = d && typeof d === "object" ? (d as Record<string, unknown>)["max"] : undefined;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 1) throw new Error("config lessons.draft.max must be a positive integer");
  return m;
}

/** Words that state a rule for all future work (English and German), case-insensitive, word boundaries. */
const RULE_WORDS = [
  /\balways\b/i, /\bnever\b/i, /\bmust\b/i, /\bmust\s+not\b/i, /\bimpossible\b/i, /\bevery\s+time\b/i,
  /\bno\s+exception\b/i, /\bfrom\s+now\s+on\b/i, /\bimmer\b/i, /\bnie\b/i, /\bniemals\b/i, /\bmuss\b/i, /\bdarf\s+nicht\b/i,
];
/** A concrete file, button, section or document to change right now. */
const NOW_TARGETS = [
  /\breadme\b/i, /\bbutton\b/i, /\btile\b/i, /\bsection\b/i, /\bdocument\b/i, /\bsvg\b/i, /\bpng\b/i, /\bcockpit\b/i,
  /[./][\w/-]*\.[a-z0-9]{1,5}\b/i, /\bfile\b/i,
];

/**
 * Deterministic score of an evidence quote (the user's own words), added to the
 * model's strength: +2 rule words, +1 emphasis (an ALL-CAPS word of 4+ letters,
 * "!"), +1 drafted from 2+ chunks, -2 a concrete now-change target (path,
 * README, button, tile, svg, cockpit) with no rule word.
 */
export function deterministicScore(quote: string, count: number): number {
  const hasRule = RULE_WORDS.some((re) => re.test(quote));
  let score = 0;
  if (hasRule) score += 2;
  if (/(^|\s)[A-Z]{4,}(\s|$)/.test(quote) || /\/[^\s/]+\//.test(quote) || quote.includes("!")) score += 1;
  if (count >= 2) score += 1;
  if (!hasRule && NOW_TARGETS.some((re) => re.test(quote))) score -= 2;
  return score;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function nearIdentical(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.8;
}

/** Parse the model's reply into valid lesson items; anything malformed is dropped. */
function parseDraft(reply: string): Array<Record<string, string> & { strength: number; standing: boolean }> {
  const s = reply.indexOf("[");
  const e = reply.lastIndexOf("]");
  if (s < 0 || e <= s) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(reply.slice(s, e + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<Record<string, string> & { strength: number; standing: boolean }> = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const ok = ["title", "kind", "applies_when", "body", "evidence_quote"].every((k) => typeof o[k] === "string" && (o[k] as string).trim());
    if (!ok || !LESSON_KINDS.includes(o.kind as LessonKind)) continue;
    const strength = Number(o.strength);
    if (!Number.isFinite(strength)) continue;
    out.push({ ...(o as Record<string, string>), strength, standing: o.standing === true } as Record<string, string> & { strength: number; standing: boolean });
  }
  return out;
}

/** The default model client: the running local model's endpoint, else the routed default (a headless claude spawn). */
async function defaultClient(): Promise<ModelClient> {
  try {
    const cfgMod = await import("../workers/config.js");
    const { resolveLocalProvider } = await import("../workers/local-provider.js");
    const { workersLogDir } = await import("../workers/paths.js");
    const { workers } = cfgMod.readWorkersSection();
    const { name } = await resolveLocalProvider(workers, workersLogDir(workers));
    const p = workers.providers[name]!;
    const model = cfgMod.resolveModelCapability(p, "default");
    const base = p.baseUrl.replace(/\/+$/, "");
    const openai = p.protocol === "openai";
    return async (prompt) => {
      const res = await fetch(openai ? `${base}/chat/completions` : `${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer local", "x-api-key": "local", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, temperature: 0, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok) throw new Error(`model endpoint ${res.status}`);
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type: string; text?: string }> };
      if (openai) return j.choices?.[0]?.message?.content ?? null;
      return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") || null;
    };
  } catch {
    const { spawnClaude } = await import("./kg-extraction.js");
    return (prompt) => spawnClaude(prompt, "sonnet");
  }
}

/** A drafted lesson with the ranking inputs it was kept for. */
export interface RankedDraft {
  lesson: LessonInput;
  strength: number;
  /** Deterministic score of the evidence quote; final rank = strength + this. */
  evidenceScore: number;
  /** In how many chunks the same rule was drafted. */
  count: number;
}

/**
 * Candidate lessons drafted by a model from the user's corrections and standing
 * rules in a transcript. Adds nothing. A failing model or unparseable reply
 * yields no candidates for that chunk. Output is redacted, grounded in a real
 * user message, and deduped against existing lessons and itself. Every chunk is
 * drafted first; non-standing and weak (strength < 3) items are dropped, near
 * duplicates merged (counting occurrences), then ranked by strength plus a
 * deterministic score of the evidence quote (`deterministicScore`), ties on the
 * final rank by occurrences, and capped at `lessons.draft.max`.
 */
export async function draftRankedFromTranscript(transcriptPath: string, opts: DraftOpts = {}): Promise<RankedDraft[]> {
  const sessionId = basename(transcriptPath, ".jsonl");
  const turns = extractTurns(transcriptPath);
  const limit = opts.chunkChars ?? CHUNK_CHARS;
  const chunks: Turn[][] = [];
  let cur: Turn[] = [];
  let size = 0;
  for (const t of turns) {
    const n = t.user.length + t.before.length;
    if (cur.length && size + n > limit) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(t);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  if (chunks.length === 0) return [];

  const max = draftMax();
  const client = opts.client ?? (await defaultClient());
  const known = listLessons();
  const slugs = new Set(known.map((l) => l.id));
  const knownBodies = known.map((l) => l.body);
  const all = norm(turns.map((t) => t.user).join("\n"));
  const found: RankedDraft[] = [];
  for (const chunk of chunks) {
    let reply: string | null = null;
    try {
      reply = await client(draftPrompt(chunk));
    } catch {
      continue;
    }
    if (!reply) continue;
    const seen = new Set<RankedDraft>();
    for (const it of parseDraft(reply)) {
      if (!it.standing || it.strength < MIN_STRENGTH) continue;
      const quote = it.evidence_quote.trim();
      if (!all.includes(norm(quote))) continue;
      const title = redactSecrets(it.title.replace(/\s+/g, " ")).slice(0, 120);
      const body = redactSecrets(it.body.trim());
      const slug = slugify(title);
      if (slugs.has(slug) || knownBodies.some((b) => nearIdentical(b, body))) continue;
      const strength = Math.min(5, it.strength);
      const dup = found.find((f) => f.lesson.title !== undefined && slugify(f.lesson.title) === slug || nearIdentical(f.lesson.body ?? "", body));
      if (dup) {
        if (!seen.has(dup)) dup.count++;
        seen.add(dup);
        dup.strength = Math.max(dup.strength, strength);
        continue;
      }
      const d: RankedDraft = {
        lesson: { title, kind: it.kind as LessonKind, applies_when: redactSecrets(it.applies_when.trim()), evidence: [sessionId, redactSecrets(quote)], body },
        strength,
        evidenceScore: deterministicScore(quote, 1),
        count: 1,
      };
      seen.add(d);
      found.push(d);
    }
  }
  for (const d of found) d.evidenceScore = deterministicScore(d.lesson.evidence?.[1] ?? "", d.count);
  return found.sort((a, b) => b.strength + b.evidenceScore - (a.strength + a.evidenceScore) || b.count - a.count).slice(0, max);
}

export async function draftFromTranscript(transcriptPath: string, opts: DraftOpts = {}): Promise<LessonInput[]> {
  return (await draftRankedFromTranscript(transcriptPath, opts)).map((d) => d.lesson);
}
