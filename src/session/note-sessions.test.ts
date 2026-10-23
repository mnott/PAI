import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addNoteSession, parseNoteSessions, withNoteSession } from "./note-sessions.js";
import { backfillProjectDir, matchSessions } from "./note-sessions-backfill.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const root = mkdtempSync(join(tmpdir(), "note-sessions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("frontmatter write", () => {
  const note = "# Session 0001: x\n\n**Date:** 2026-01-01\n";
  it("adds a minimal block to a note without frontmatter", () => {
    expect(withNoteSession(note, A)).toBe(`---\nsessions: [${A}]\n---\n${note}`);
  });
  it("appends, never overwrites, and is idempotent", () => {
    const one = withNoteSession(note, A);
    const two = withNoteSession(one, B);
    expect(parseNoteSessions(two)).toEqual([A, B]);
    expect(withNoteSession(two, A)).toBe(two);
    expect(two.endsWith(note)).toBe(true);
  });
  it("keeps other frontmatter keys", () => {
    const fm = `---\ntitle: T\n---\n${note}`;
    const out = withNoteSession(fm, A);
    expect(out).toBe(`---\ntitle: T\nsessions: [${A}]\n---\n${note}`);
    expect(parseNoteSessions(withNoteSession(out, B))).toEqual([A, B]);
  });
  it("ignores values that are not session ids", () => {
    expect(withNoteSession(note, "nope")).toBe(note);
  });
  it("writes the file once", () => {
    const f = join(root, "n.md");
    writeFileSync(f, note);
    expect(addNoteSession(f, A)).toBe(true);
    expect(addNoteSession(f, A)).toBe(false);
    expect(addNoteSession(f, undefined)).toBe(false);
    expect(parseNoteSessions(readFileSync(f, "utf8"))).toEqual([A]);
  });
});

describe("matcher", () => {
  const span = (id: string, s: string, e: string) => ({ id, startMs: Date.parse(s), endMs: Date.parse(e) });
  const spans = [span(A, "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"), span(B, "2026-01-01T11:30:00Z", "2026-01-01T12:00:00Z"), span(C, "2026-01-05T10:00:00Z", "2026-01-05T11:00:00Z")];
  const t = (s: string) => Date.parse(s);
  it("one overlapping session maps", () => {
    expect(matchSessions(spans, t("2026-01-01T10:10:00Z"), t("2026-01-01T10:50:00Z"))).toEqual({ kind: "mapped", ids: [A] });
  });
  it("a note spanning two sessions maps to both", () => {
    expect(matchSessions(spans, t("2026-01-01T10:30:00Z"), t("2026-01-01T11:45:00Z"))).toEqual({ kind: "mapped", ids: [A, B] });
  });
  it("no overlap is none", () => {
    expect(matchSessions(spans, t("2026-01-03T00:00:00Z"), t("2026-01-03T01:00:00Z")).kind).toBe("none");
  });
  it("too many sessions is ambiguous", () => {
    const many = [...spans, span("44444444-4444-4444-8444-444444444444", "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z")];
    expect(matchSessions(many, t("2026-01-01T00:00:00Z"), t("2026-01-06T00:00:00Z")).kind).toBe("ambiguous");
  });
});

describe("backfill", () => {
  const dir = join(root, "-proj");
  const line = (ts: string) => JSON.stringify({ type: "user", timestamp: ts }) + "\n";
  const note = (name: string, text: string, when: string) => {
    mkdirSync(join(dir, "Notes", "2026", "01"), { recursive: true });
    const f = join(dir, "Notes", "2026", "01", name);
    writeFileSync(f, text);
    utimesSync(f, new Date(when), new Date(when));
    return f;
  };
  it("counts and writes only clear matches; dry-run writes nothing", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${A}.jsonl`), line("2026-01-01T10:00:00Z") + line("2026-01-01T11:00:00Z"));
    writeFileSync(join(dir, `${B}.jsonl`), line("2026-01-02T10:00:00Z") + line("2026-01-02T11:00:00Z"));
    const hit = note("0001 - 2026-01-01 - Hit.md", "# S\n", "2026-01-01T10:30:00Z");
    note("0002 - 2026-01-03 - Miss.md", "# S\n", "2026-01-03T10:30:00Z");
    const marked = note("0003 - 2026-01-09 - Marked.md", `# S\n<!-- SESSION: ${B} -->\n`, "2026-01-09T10:30:00Z");
    note("0004 - 2026-01-02 - Done.md", `---\nsessions: [${B}]\n---\n# S\n`, "2026-01-02T10:30:00Z");
    // a fresh file's birthtime is "now"; pin the window to a short span ending at mtime
    const win = (st: { mtimeMs: number }): [number, number] => [st.mtimeMs - 600_000, st.mtimeMs];
    const dry = await backfillProjectDir(dir, true, [join(dir, "Notes")], win);
    expect(readFileSync(hit, "utf8")).toBe("# S\n");
    expect(dry).toMatchObject({ notes: 4, already: 1 });
    expect(dry).toMatchObject({ mapped: 2, none: 1, ambiguous: 0 });
    expect(dry.plan.find((p) => p.note === hit)?.ids).toEqual([A]);
    expect(dry.plan.find((p) => p.note === marked)?.ids).toEqual([B]);
    await backfillProjectDir(dir, false, [join(dir, "Notes")], win);
    expect(parseNoteSessions(readFileSync(hit, "utf8"))).toEqual([A]);
    expect(parseNoteSessions(readFileSync(marked, "utf8"))).toEqual([B]);
  });
});
