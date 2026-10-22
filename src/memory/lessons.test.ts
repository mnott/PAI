import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLesson, getLesson, lessonsDir, listLessons, proposeFromTranscript, setState } from "./lessons.js";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-lessons-test-"));
  prev = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

const input = (title: string) => ({ title, kind: "gotcha" as const, applies_when: "when testing", body: "Do the thing." });

describe("lessons", () => {
  it("adds a candidate and reads it back", () => {
    const l = addLesson({ ...input("Run tsc first"), project: "demo", evidence: ["s1"] });
    expect(l.id).toBe("run-tsc-first");
    expect(getLesson(l.id)).toMatchObject({ state: "candidate", project: "demo", evidence: ["s1"], body: "Do the thing." });
  });

  it("makes slugs unique by suffix", () => {
    expect(addLesson(input("Same")).id).toBe("same");
    expect(addLesson(input("Same")).id).toBe("same-2");
    expect(addLesson(input("Same")).id).toBe("same-3");
  });

  it("filters by state and project", () => {
    const a = addLesson({ ...input("A"), project: "p1" });
    addLesson(input("B"));
    setState(a.id, "approved");
    expect(listLessons({ state: "approved" }).map((l) => l.id)).toEqual(["a"]);
    expect(listLessons({ project: "global" }).map((l) => l.id)).toEqual(["b"]);
    expect(listLessons()).toHaveLength(2);
  });

  it("approves, rejects and re-opens", () => {
    const a = addLesson(input("A"));
    expect(setState(a.id, "rejected").state).toBe("rejected");
    expect(setState(a.id, "candidate").state).toBe("candidate");
    expect(setState(a.id, "approved").state).toBe("approved");
  });

  it("supersedes only by an existing approved lesson", () => {
    const a = addLesson(input("A"));
    const b = addLesson(input("B"));
    setState(a.id, "approved");
    expect(() => setState(a.id, "superseded")).toThrow(/supersededBy/);
    expect(() => setState(a.id, "superseded", { supersededBy: b.id })).toThrow(/approved/);
    expect(() => setState(a.id, "superseded", { supersededBy: "nope" })).toThrow(/approved/);
    setState(b.id, "approved");
    expect(setState(a.id, "superseded", { supersededBy: b.id })).toMatchObject({ state: "superseded", superseded_by: "b" });
  });

  it("throws on illegal transitions", () => {
    const a = addLesson(input("A"));
    expect(() => setState(a.id, "superseded", { supersededBy: "x" })).toThrow(/illegal/);
    setState(a.id, "approved");
    expect(() => setState(a.id, "rejected")).toThrow(/illegal/);
    expect(() => setState("missing", "approved")).toThrow(/not found/);
  });

  it("leaves no temp file behind", () => {
    const a = addLesson(input("A"));
    setState(a.id, "approved");
    expect(readdirSync(lessonsDir())).toEqual(["a.md"]);
  });
});

describe("proposeFromTranscript", () => {
  it("finds corrections and ignores normal messages", () => {
    const dir = join(home, "t");
    mkdirSync(dir);
    const path = join(dir, "sess-123.jsonl");
    const ev = (type: string, content: unknown) => JSON.stringify({ type, message: { content } });
    writeFileSync(path, [
      ev("user", "Please add a function that sums a list"),
      ev("assistant", [{ type: "text", text: "Done" }]),
      ev("user", [{ type: "text", text: "No, don't use var here. Use const." }]),
      ev("user", "Das ist falsch, nimm bitte die andere Datei"),
      "not json",
    ].join("\n"));
    const out = proposeFromTranscript(path);
    expect(out.map((o) => o.title)).toEqual(["No, don't use var here. Use const.", "Das ist falsch, nimm bitte die andere Datei"]);
    expect(out[0]).toMatchObject({ applies_when: "", evidence: ["sess-123"] });
  });
});
