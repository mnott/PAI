/**
 * Review-gated lessons: a short curated memory layer.
 *
 * One Markdown file per lesson under `<PAI home>/lessons/<slug>.md` with YAML
 * frontmatter, so the memory indexer finds them. Candidates (proposed from
 * transcripts or added by hand) only reach agents once approved.
 */

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

export function parseLesson(text: string, fallbackId = ""): Lesson {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("lesson has no YAML frontmatter");
  const f = (parse(m[1]!) ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
  const lesson: Lesson = {
    id: str(f.id) || fallbackId,
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
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
