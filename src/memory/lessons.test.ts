import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { addLesson, draftFromTranscript, getLesson, lessonsDir, listLessons, promoteLesson, proposeFromTranscript, setState } from "./lessons.js";
import { fakeAnthropic } from "../utils/fake-secret.js";

let home: string;
let project: string;
let prev: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-lessons-test-"));
  project = mkdtempSync(join(tmpdir(), "pai-lessons-proj-"));
  prev = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
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

describe("promoteLesson", () => {
  const approved = () => {
    const l = addLesson({ ...input("Run tsc first"), evidence: ["s1", "s2"] });
    setState(l.id, "approved");
    return l;
  };
  const skillPath = (slug: string) => join(project, ".claude", "skills", slug, "SKILL.md");

  it("writes a skill with valid frontmatter for an approved lesson", () => {
    const l = approved();
    const paths = promoteLesson(l.id, { projectDir: project });
    expect(paths).toEqual([skillPath("run-tsc-first")]);
    expect(existsSync(paths[0]!)).toBe(true);
    const text = readFileSync(paths[0]!, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    expect(m).not.toBeNull();
    const f = parse(m![1]!) as Record<string, unknown>;
    expect(f.name).toBe("run-tsc-first");
    expect(String(f.description)).toBe("Run tsc first. USE WHEN when testing.");
    expect(String(f.description).length).toBeLessThan(1024);
    const prov = f.provenance as Record<string, unknown>;
    expect(prov.lesson).toBe(l.id);
    expect(prov.evidence).toEqual(["s1", "s2"]);
    expect(typeof prov.promoted).toBe("string");
    expect(m![2]!).toContain("Do the thing.");
    expect(m![2]!).toContain(`Source: lesson ${l.id}`);
  });

  it("refuses a candidate", () => {
    const l = addLesson(input("A"));
    expect(() => promoteLesson(l.id, { projectDir: project })).toThrow(/approved/);
    expect(existsSync(skillPath("a"))).toBe(false);
  });

  it("refuses to overwrite without force, overwrites with force", () => {
    const l = approved();
    promoteLesson(l.id, { projectDir: project });
    expect(() => promoteLesson(l.id, { projectDir: project })).toThrow(/already exists/);
    const paths = promoteLesson(l.id, { projectDir: project, force: true });
    expect(paths).toEqual([skillPath("run-tsc-first")]);
    expect(existsSync(paths[0]!)).toBe(true);
  });

  it("with agentsDir writes both dirs", () => {
    const l = approved();
    const paths = promoteLesson(l.id, { projectDir: project, agentsDir: true });
    expect(paths).toEqual([skillPath("run-tsc-first"), join(project, ".agents", "skills", "run-tsc-first", "SKILL.md")]);
    for (const p of paths) expect(existsSync(p)).toBe(true);
  });

  it("records promoted_to in the lesson", () => {
    const l = approved();
    const paths = promoteLesson(l.id, { projectDir: project });
    expect(getLesson(l.id)?.promoted_to).toEqual(paths);
  });
});

describe("addLesson redaction", () => {
  it("redacts title and body", () => {
    const l = addLesson({ title: "use token=abc123 here", kind: "gotcha", applies_when: "", body: "password: hunter2" });
    expect(l.title).toBe("use token=[REDACTED] here");
    expect(l.body).toBe("password: [REDACTED]");
    expect(getLesson(l.id)?.body).not.toContain("hunter2");
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
  it("needs the signal at the start and redacts secrets", () => {
    const dir = join(home, "t2");
    mkdirSync(dir);
    const path = join(dir, "sess-9.jsonl");
    const ev = (content: string) => JSON.stringify({ type: "user", message: { content } });
    writeFileSync(path, [
      ev("Please run the build and stop when it is green, never mind the lint warnings at all"),
      ev("Das ist nicht schlimm, mach weiter und nie vergessen"),
      ev("No, use password=hunter2 for the db"),
    ].join("\n"));
    const out = proposeFromTranscript(path);
    expect(out.map((o) => o.title)).toEqual(["No, use password=[REDACTED] for the db"]);
    expect(out[0].body).not.toContain("hunter2");
  });
});

describe("lesson id confinement", () => {
  it("ignores a frontmatter id that is not a slug; nothing is written outside lessons/", () => {
    mkdirSync(lessonsDir(), { recursive: true });
    writeFileSync(join(lessonsDir(), "legit.md"), `---\nid: ../../../escaped\ntitle: t\nstate: candidate\nkind: gotcha\n---\n\nbody\n`);
    expect(getLesson("legit")?.id).toBe("legit");
    setState("legit", "approved");
    expect(existsSync(join(home, "..", "escaped.md"))).toBe(false);
    expect(existsSync(join(home, "escaped.md"))).toBe(false);
    expect(getLesson("legit")?.state).toBe("approved");
    expect(readdirSync(lessonsDir())).toEqual(["legit.md"]);
  });
});

describe("draftFromTranscript", () => {
  const ev = (type: string, text: string) => JSON.stringify({ type, message: { content: [{ type: "text", text }] } });
  // Fake token-shaped fixture assembled at runtime so no scanner flags a literal.
  const ANTHROPIC = fakeAnthropic("abcdefghijklmnopqrstuvwxyz0123456789", "-api03");
  const fixture = () => {
    const p = join(project, "sess-1.jsonl");
    writeFileSync(p, [
      ev("user", "<system-reminder>ignore me</system-reminder>add a flag to the CLI"),
      ev("assistant", "Done, I used memory to remember the port."),
      ev("user", `memory is unreliable, it needs to be instrumented. deterministic. token ${ANTHROPIC}`),
      ev("user", "now run the tests"),
      ev("user", "it must be IMPOSSIBLE to start any command not in a pane"),
      ev("user", "please rename the file"),
      ev("user", "what does this do?"),
    ].join("\n"));
    return p;
  };
  const good = [
    { title: "Instrument, do not trust memory", kind: "correction", applies_when: "relying on recall", body: "Make it deterministic.", evidence_quote: `memory is unreliable, it needs to be instrumented. deterministic. token ${ANTHROPIC}`, strength: 5, standing: true },
    { title: "Commands only in panes", kind: "convention", applies_when: "starting commands", body: "Starting outside a pane must be impossible.", evidence_quote: "it must be IMPOSSIBLE to start any command not in a pane", strength: 4, standing: true },
    { title: "Invented", kind: "gotcha", applies_when: "x", body: "never said", evidence_quote: "not in the transcript" },
    { title: "bad kind", kind: "nope", applies_when: "x", body: "y", evidence_quote: "now run the tests" },
  ];

  it("yields the two corrections, redacted, with session evidence", async () => {
    const out = await draftFromTranscript(fixture(), { client: async () => JSON.stringify(good) });
    expect(out.map((l) => l.title)).toEqual(["Instrument, do not trust memory", "Commands only in panes"]);
    expect(out[0]!.evidence![0]).toBe("sess-1");
    expect(JSON.stringify(out)).not.toContain(ANTHROPIC);
  });

  const item = (title: string, quote: string, strength: number, standing = true) =>
    ({ title, kind: "convention", applies_when: "always", body: `${title} body text`, evidence_quote: quote, strength, standing });
  const bigFixture = () => {
    const p = join(project, "sess-2.jsonl");
    writeFileSync(p, ["alpha rule one", "beta rule two", "gamma rule three", "delta rule four"].map((t) => ev("user", t)).join("\n"));
    return p;
  };
  const perChunk = (replies: unknown[][]) => {
    let i = 0;
    return async () => JSON.stringify(replies[i++] ?? []);
  };

  it("ranks an item repeated across chunks above single ones", async () => {
    const out = await draftFromTranscript(bigFixture(), { chunkChars: 1, client: perChunk([
      [item("Single alpha", "alpha rule one", 3)],
      [item("Repeated beta", "beta rule two", 3)],
      [item("Repeated beta", "beta rule two", 3)],
      [item("Repeated beta", "beta rule two", 3), item("Single delta", "delta rule four", 3)],
    ]) });
    expect(out[0]!.title).toBe("Repeated beta");
    expect(out).toHaveLength(3);
  });

  it("keeps a strength-5 item from the last chunk past the cap", async () => {
    const fill = Array.from({ length: 10 }, (_, i) => item(`Filler ${["apple", "brick", "cedar", "daisy", "ember", "fjord", "gravel", "hazel", "indigo", "jasper"][i]}`, "alpha rule one", 3));
    const out = await draftFromTranscript(bigFixture(), { chunkChars: 1, client: perChunk([fill, [], [], [item("Late strong", "delta rule four", 5)]]) });
    expect(out).toHaveLength(10);
    expect(out[0]!.title).toBe("Late strong");
  });

  it("drops standing:false and weak items", async () => {
    const out = await draftFromTranscript(bigFixture(), { client: async () => JSON.stringify([
      item("One off", "alpha rule one", 5, false), item("Weak", "beta rule two", 2), item("Keeper", "gamma rule three", 3),
    ]) });
    expect(out.map((l) => l.title)).toEqual(["Keeper"]);
  });

  it("yields none on invalid JSON and on a throwing client", async () => {
    expect(await draftFromTranscript(fixture(), { client: async () => "not json {" })).toEqual([]);
    expect(await draftFromTranscript(fixture(), { client: async () => { throw new Error("down"); } })).toEqual([]);
  });

  it("skips lessons that already exist", async () => {
    addLesson({ title: "Commands only in panes", kind: "gotcha", applies_when: "x" });
    const out = await draftFromTranscript(fixture(), { client: async () => JSON.stringify(good) });
    expect(out.map((l) => l.title)).toEqual(["Instrument, do not trust memory"]);
  });
});
