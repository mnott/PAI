import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { activeAntipattern, fillMessage, getAntipattern, loadAntipatterns, resetAntipatternCache, shippedAntipattern, validateAntipattern, type Antipattern } from "./antipatterns.js";
import { emptyLoopState, recordLoopResult, stepLoopGuard, type LoopState } from "./loop-guard.js";
import { lintRules } from "./rules/lint.js";
import { BUILTIN_RULES } from "./rules/builtin.generated.js";
import { unparsedToolCall } from "../../../workers/run/unparsed-call.js";

/** Runs one sample through the detector of a pattern; true when the pattern fires. */
function fires(ap: Antipattern, sample: string): boolean {
  switch (ap.detector.kind) {
    case "identical-write":
    case "revert": {
      let state: LoopState = emptyLoopState();
      let last: ReturnType<typeof stepLoopGuard> | undefined;
      for (const tok of sample.split(" ")) {
        last = stepLoopGuard(state, "Write", { file_path: "f.txt", content: tok });
        state = last.state;
      }
      return !!last && (last.deny || !!last.note);
    }
    case "growing-command":
    case "repeated-failure": {
      let state: LoopState = emptyLoopState();
      let last: ReturnType<typeof stepLoopGuard> | undefined;
      for (const cmd of sample.split("\n")) {
        last = stepLoopGuard(state, "Bash", { command: cmd });
        state = recordLoopResult(last.state, "Bash", { command: cmd }, "same output");
      }
      return !!last && (ap.detector.kind === "repeated-failure" ? last.deny : last.deny || !!last.note);
    }
    case "unparsed-tool-call":
      return unparsedToolCall(sample) !== null;
    case "missing-path":
      return !existsSync(resolve(sample));
    default:
      throw new Error(`no test adapter for ${ap.detector.kind}`);
  }
}

describe("shipped anti-patterns run their own tests", () => {
  const shipped = loadAntipatterns().filter((a) => a.source === "shipped");
  it("ships the four non-shell categories", () => {
    expect(new Set(shipped.map((a) => a.category))).toEqual(new Set(["tool-loop", "final-text", "paths"]));
    expect(shipped.map((a) => a.id).sort()).toEqual(["does-not-exist", "growing-command", "identical-write", "repeated-failure", "revert", "unparsed-tool-call"]);
  });
  it.each(shipped.map((a) => [a.id, a] as const))("%s", (_id, ap) => {
    expect(ap.tests.match.length).toBeGreaterThan(0);
    expect(ap.tests.no_match.length).toBeGreaterThan(0);
    for (const s of ap.tests.match) expect(fires(ap, s), `should match: ${s}`).toBe(true);
    for (const s of ap.tests.no_match) expect(fires(ap, s), `should not match: ${s}`).toBe(false);
  });
  it("no provenance carries a path or user name", () => {
    for (const a of shipped) expect(JSON.stringify(a.provenance)).not.toMatch(/\/Users\/|\/home\/|@/);
  });
});

describe("shipped shell rules run their own tests", () => {
  it.each(BUILTIN_RULES.map((r) => [r.id, r] as const))("%s", (_id, rule) => {
    const lint = lintRules([rule])[0];
    expect(lint.failures).toEqual([]);
  });
});

describe("loader", () => {
  let home: string;
  let prevHome: string | undefined;
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pai-ap-"));
    prevHome = process.env.PAI_HOME;
    process.env.PAI_HOME = home;
    resetAntipatternCache();
    err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    err.mockRestore();
    if (prevHome === undefined) delete process.env.PAI_HOME;
    else process.env.PAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    resetAntipatternCache();
  });
  const put = (cat: string, name: string, text: string) => {
    mkdirSync(join(home, "antipatterns", cat), { recursive: true });
    writeFileSync(join(home, "antipatterns", cat, name), text);
  };
  const mine = (id: string, stopAt: number) =>
    `id: ${id}\ncategory: tool-loop\ndetector:\n  kind: identical-write\n  params: { note_at: 2, stop_at: ${stopAt}, stop_message: "stop {file} {n}" }\naction: note\nmessage: "note {file}"\n`;

  it("a user id overrides the shipped one", () => {
    expect(activeAntipattern("identical-write").detector.params.stop_at).toBe(20);
    put("tool-loop", "identical-write.yaml", mine("identical-write", 3));
    expect(activeAntipattern("identical-write").detector.params.stop_at).toBe(3);
    expect(shippedAntipattern("identical-write").detector.params.stop_at).toBe(20);
    // the detector reads the override
    let state: LoopState = emptyLoopState();
    const steps = [];
    for (let i = 0; i < 3; i++) {
      const s = stepLoopGuard(state, "Write", { file_path: "f.txt", content: "A" });
      state = s.state;
      steps.push(s);
    }
    expect(steps[2].stop).toBe(true);
    expect(steps[1].note).toBe("note f.txt");
  });

  it("a new user id extends", () => {
    put("tool-loop", "mine.yaml", mine("mine", 5));
    expect(getAntipattern("mine")?.source).toContain("mine.yaml");
    expect(loadAntipatterns("tool-loop").map((a) => a.id)).toContain("mine");
  });

  it("a bad file is skipped with one stderr line, the rest still load", () => {
    put("tool-loop", "bad.yaml", "id: bad\ncategory: tool-loop\ndetector: { kind: nope }\naction: note\nmessage: x\n");
    put("tool-loop", "broken.yaml", "id: [unclosed\n");
    put("tool-loop", "good.yaml", mine("good", 5));
    expect(getAntipattern("good")).toBeDefined();
    expect(getAntipattern("bad")).toBeUndefined();
    const lines = err.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("antipattern"));
    expect(lines.length).toBe(2);
    getAntipattern("good"); // cached: no second report
    expect(err.mock.calls.filter((c: unknown[]) => String(c[0]).includes("antipattern")).length).toBe(2);
  });

  it("a category that does not match its directory is skipped", () => {
    put("paths", "x.yaml", mine("x", 5));
    expect(getAntipattern("x")).toBeUndefined();
  });

  it("_candidates is inactive", () => {
    put("_candidates", "c.yaml", mine("c", 5));
    expect(getAntipattern("c")).toBeUndefined();
  });

  it("hot reloads when the file's mtime changes", () => {
    put("tool-loop", "mine.yaml", mine("mine", 5));
    expect(getAntipattern("mine")?.detector.params.stop_at).toBe(5);
    put("tool-loop", "mine.yaml", mine("mine", 7));
    const t = new Date(Date.now() + 5000);
    utimesSync(join(home, "antipatterns", "tool-loop", "mine.yaml"), t, t);
    expect(getAntipattern("mine")?.detector.params.stop_at).toBe(7);
  });

  it("validateAntipattern names the problem", () => {
    expect(validateAntipattern({ id: "Bad Id" }, null, "t")).toMatch(/id must be/);
    expect(validateAntipattern({ id: "a", category: "nope" }, null, "t")).toMatch(/unknown category/);
    expect(fillMessage("{a} {b}", { a: 1 })).toBe("1 {b}");
  });
});
