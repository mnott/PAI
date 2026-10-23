/**
 * note-sessions-backfill.ts — give existing session notes their `sessions:` frontmatter.
 *
 * A note at <projects>/<encoded>/Notes/YYYY/MM/NNNN - date - title.md belongs to the transcripts in
 * <projects>/<encoded>/*.jsonl whose first..last timestamps overlap the note's life (creation to last
 * modification). A `<!-- SESSION: id -->` marker naming an existing transcript decides on its own.
 * Notes are only written when the match is clear: one session, or a small set that each overlap for
 * a meaningful stretch. Everything else is reported as ambiguous (too many) or none.
 */

import { createReadStream, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { addNoteSession, parseNoteSessions } from "./note-sessions.js";

export interface SessionSpan {
  id: string;
  startMs: number;
  endMs: number;
}

export const MAX_SET = 3;
/** an overlap shorter than this does not count as covering the note */
export const MIN_OVERLAP_MS = 60_000;

/** Sessions whose span overlaps [from, to]; a note touched at one instant counts as a point. */
export function matchSessions(spans: SessionSpan[], from: number, to: number): { kind: "mapped" | "ambiguous" | "none"; ids: string[] } {
  if (to < from) [from, to] = [to, from];
  const hit = spans
    .map((s) => ({ s, overlap: Math.min(s.endMs, to) - Math.max(s.startMs, from) }))
    .filter((x) => x.overlap >= 0)
    .sort((a, b) => a.s.startMs - b.s.startMs);
  if (hit.length === 0) return { kind: "none", ids: [] };
  if (hit.length === 1) return { kind: "mapped", ids: [hit[0].s.id] };
  const real = hit.filter((x) => x.overlap >= MIN_OVERLAP_MS);
  if (real.length >= 1 && real.length <= MAX_SET && hit.length <= MAX_SET) return { kind: "mapped", ids: real.map((x) => x.s.id) };
  return { kind: "ambiguous", ids: [] };
}

async function firstLastTs(file: string): Promise<{ first: number; last: number } | null> {
  let first = 0;
  let last = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = line.match(/"timestamp":"([^"]+)"/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    if (!first) first = t;
    last = t;
  }
  return first ? { first, last } : null;
}

/** First/last timestamp of every transcript directly under `dir`. */
export async function transcriptSpans(dir: string): Promise<SessionSpan[]> {
  const out: SessionSpan[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const r = await firstLastTs(join(dir, n)).catch(() => null);
    if (r) out.push({ id: n.slice(0, -6).toLowerCase(), startMs: r.first, endMs: r.last });
  }
  return out;
}

function noteFiles(notesDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let es: string[] = [];
    try {
      es = readdirSync(d);
    } catch {
      return;
    }
    for (const e of es) {
      const p = join(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/^\d{3,4}[\s_-].*\.md$/.test(e)) out.push(p);
    }
  };
  walk(notesDir);
  return out;
}

export interface BackfillReport {
  notes: number;
  mapped: number;
  ambiguous: number;
  none: number;
  /** notes that already had a sessions list */
  already: number;
  /** note path -> ids written (or that would be) */
  plan: { note: string; ids: string[] }[];
}

/** Backfill the notes in `notesDirs` (default: the central Notes of the transcript dir `projectDir`). Writes only when `dryRun` is false. */
export async function backfillProjectDir(
  projectDir: string,
  dryRun: boolean,
  notesDirs: string[] = [join(projectDir, "Notes")],
  windowOf: (st: Stats) => [number, number] = (st) => [st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs, st.mtimeMs]
): Promise<BackfillReport> {
  const rep: BackfillReport = { notes: 0, mapped: 0, ambiguous: 0, none: 0, already: 0, plan: [] };
  const spans = await transcriptSpans(projectDir);
  const known = new Set(spans.map((s) => s.id));
  for (const note of notesDirs.flatMap(noteFiles)) {
    rep.notes++;
    const text = readFileSync(note, "utf8");
    if (parseNoteSessions(text).length > 0) {
      rep.already++;
      continue;
    }
    const marker = text.match(/<!--\s*SESSION:\s*([0-9a-f-]{36})\s*-->/i)?.[1]?.toLowerCase();
    let ids: string[] = [];
    let kind: "mapped" | "ambiguous" | "none" = "none";
    if (marker && known.has(marker)) {
      ids = [marker];
      kind = "mapped";
    } else {
      ({ kind, ids } = matchSessions(spans, ...windowOf(statSync(note))));
    }
    rep[kind]++;
    if (kind !== "mapped") continue;
    rep.plan.push({ note, ids });
    if (!dryRun) for (const id of ids) addNoteSession(note, id);
  }
  return rep;
}
