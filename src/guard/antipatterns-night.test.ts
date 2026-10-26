import { describe, it, expect } from "vitest";
import { evaluate, type Decision, type GuardContext } from "./evaluate.js";
import { emptyLoopState, type LoopState } from "../hooks/ts/lib/loop-guard.js";
import { activeAntipattern } from "../hooks/ts/lib/antipatterns.js";
import { repairMangledScratch } from "../hooks/ts/lib/path-repair.js";
import type { FiringInput } from "../hooks/ts/lib/antipattern-log.js";

const cwd = process.cwd();
const word = (n: number): string => String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + (Math.floor(n / 26) % 26)) + String.fromCharCode(97 + (Math.floor(n / 676) % 26));
const OUT = "/nonexistent-antipattern-test/out";

/** Feeds tool calls through evaluate(), threading the loop state like the hook does. */
function session() {
  let state: LoopState = emptyLoopState();
  let seq = 0;
  const ctx = (): GuardContext => ({ env: {}, record: () => undefined, loop: { state, now: 1 } });
  const call = (tool: string, input: Record<string, unknown>): Decision => {
    const d = evaluate({ kind: "tool_call", tool, input, cwd }, ctx());
    state = d.loop!.state;
    return d;
  };
  return {
    write: (file = `${OUT}/${seq++}.py`, content = "x") => call("Write", { file_path: file, content }),
    // distinct bodies (letters: numbers are normalised away): near-identical commands would trip growing-command first
    heredoc: (file: string, body: string) => {
      const n = seq++;
      return call("Bash", { command: `cat > ${file} <<'EOF'\n${body} ${times(30, (k) => word(n * 31 + k)).join(" ")}\nEOF` });
    },
    read: (file_path = "package.json") => call("Read", { file_path }),
    missing: () => call("Read", { file_path: `${OUT}/missing-${seq++}.py` }),
    glob: () => call("Glob", { pattern: "*.py", path: `${OUT}/dir-${seq++}` }),
    grep: () => call("Grep", { pattern: "x", path: `${OUT}/dir-${seq++}` }),
    run: (command = "node a.js") => call("Bash", { command }),
  };
}

function times<T>(n: number, f: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => f(i));
}
describe("evaluate: distinct-rewrites (enforce, counts Bash writes)", () => {
  it("is shipped stable and enforcing", () => {
    expect(activeAntipattern("distinct-rewrites")).toMatchObject({ status: "stable", mode: "enforce" });
  });

  it("match: 8 distinct Writes of one file note at the 8th", () => {
    const s = session();
    const ds = times(8, (i) => s.write("/nonexistent-antipattern-test/f.py", `v${i}`));
    expect(ds[7]).toMatchObject({ action: "note", patternId: "distinct-rewrites", mode: "enforce" });
    expect(ds.slice(0, 7).every((d) => d.action === "allow")).toBe(true);
  });

  it("match: 8 heredoc rewrites of one file through Bash note too", () => {
    const s = session();
    const ds = times(8, (i) => s.heredoc("dbg.mjs", `console.log(${i})`));
    expect(ds[7]).toMatchObject({ action: "note", patternId: "distinct-rewrites", mode: "enforce" });
    expect(ds[7].message).toContain("dbg.mjs");
  });

  it("match: Write and Bash writes of one file add up", () => {
    const s = session();
    const ds = [...times(4, (i) => s.write("/nonexistent-antipattern-test/f.py", `v${i}`)), ...times(4, (i) => s.heredoc("/nonexistent-antipattern-test/f.py", `b${i}`))];
    expect(ds[7]).toMatchObject({ action: "note", patternId: "distinct-rewrites" });
  });

  it("no_match: a test run between the heredoc writes resets the count", () => {
    const s = session();
    const ds = times(16, (i) => (i % 4 === 3 ? s.run("node dbg.mjs") : s.heredoc("dbg.mjs", `v${i}`)));
    expect(ds.some((d) => d.patternId === "distinct-rewrites")).toBe(false);
  });

  it("no_match: heredoc writes of different files", () => {
    const s = session();
    const ds = times(12, (i) => s.heredoc(`dbg${i}.mjs`, `v${i}`));
    expect(ds.some((d) => d.patternId === "distinct-rewrites")).toBe(false);
  });
});

describe("evaluate: runaway-new-files", () => {
  const p = activeAntipattern("runaway-new-files");
  const noteAt = p.detector.params.note_at as number;
  const stopAt = p.detector.params.stop_at as number;

  it("is shipped stable and enforcing with tunable numeric params", () => {
    expect(p).toMatchObject({ status: "stable", mode: "enforce", action: "note" });
    expect([noteAt, stopAt]).toEqual([60, 150]);
  });

  it("match: notes once at the note threshold, stops at the stop threshold", () => {
    const s = session();
    const ds = times(stopAt, () => s.write());
    expect(ds[noteAt - 2].action).toBe("allow");
    expect(ds[noteAt - 1]).toMatchObject({ action: "note", patternId: "runaway-new-files", mode: "enforce" });
    expect(ds.slice(noteAt, stopAt - 1).every((d) => d.action === "allow")).toBe(true);
    expect(ds[stopAt - 1]).toMatchObject({ action: "stop", patternId: "runaway-new-files" });
    expect(ds[stopAt - 1].message).toContain(`${stopAt} new files`);
  });

  it("match: bare Bash heredoc writes of new files count", () => {
    const s = session();
    const ds = times(noteAt, (i) => s.heredoc(`${OUT}/b${i}.py`, "x"));
    expect(ds[noteAt - 1]).toMatchObject({ action: "note", patternId: "runaway-new-files" });
  });

  it("no_match: a Read, a Bash run or Grep in between resets the streak", () => {
    for (const reset of [(s: ReturnType<typeof session>) => s.read(), (s: ReturnType<typeof session>) => s.run(), (s: ReturnType<typeof session>) => s.run("grep -n x a.js")]) {
      const s = session();
      const ds = times(noteAt * 3, (i) => (i % (noteAt - 10) === noteAt - 11 ? reset(s) : s.write()));
      expect(ds.some((d) => d.patternId === "runaway-new-files"), String(reset)).toBe(false);
    }
  });

  it("no_match: a scaffold of fewer files than the note threshold", () => {
    const s = session();
    s.read();
    expect(times(noteAt - 1, () => s.write()).every((d) => d.action === "allow")).toBe(true);
  });

  it("no_match: rewriting files that already exist is not a new file", () => {
    const s = session();
    expect(times(noteAt * 2, () => s.write("package.json")).some((d) => d.patternId === "runaway-new-files")).toBe(false);
  });
});

describe("evaluate: missing-path-streak", () => {
  const streak = activeAntipattern("missing-path-streak").detector.params.streak as number;

  it("is shipped stable and enforcing, default 10", () => {
    expect(activeAntipattern("missing-path-streak")).toMatchObject({ status: "stable", mode: "enforce", action: "stop" });
    expect(streak).toBe(10);
  });

  it("match: the 10th missing Read in a row stops with the message", () => {
    const s = session();
    const ds = times(streak, () => s.missing());
    expect(ds.slice(0, streak - 1).every((d) => d.action === "allow")).toBe(true);
    expect(ds[streak - 1]).toMatchObject({ action: "stop", patternId: "missing-path-streak", mode: "enforce" });
    expect(ds[streak - 1].message).toContain(`${streak} Reads in a row hit paths that do not exist`);
  });

  it("match: Glob and Grep with a missing path count with Read", () => {
    const s = session();
    const ds = times(streak, (i) => [s.missing, s.glob, s.grep][i % 3]());
    expect(ds[streak - 1].patternId).toBe("missing-path-streak");
  });

  it("no_match: a Write, a successful Read or a Bash call between resets", () => {
    for (const reset of [(s: ReturnType<typeof session>) => s.write(), (s: ReturnType<typeof session>) => s.read(), (s: ReturnType<typeof session>) => s.run()]) {
      const s = session();
      const ds = times(streak * 3, (i) => (i % (streak - 1) === streak - 2 ? reset(s) : s.missing()));
      expect(ds.some((d) => d.patternId === "missing-path-streak"), String(reset)).toBe(false);
    }
  });

  it("no_match: ten reads of existing files", () => {
    const s = session();
    expect(times(streak * 2, () => s.read()).some((d) => d.patternId === "missing-path-streak")).toBe(false);
  });
});

describe("mangled-var-folders-path repair", () => {
  const worker = { PAI_WORKER: "1" };
  const call = (tool: string, file_path: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv = worker) => {
    const fired: FiringInput[] = [];
    const out = repairMangledScratch({ tool_name: tool, cwd: "/w", tool_input: { file_path, content: "x" } }, env, exists, (f) => fired.push(f));
    return { out: out ? (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string; updatedInput?: { file_path: string } } }).hookSpecificOutput : null, fired };
  };
  const real = "/var/folders/ab/cdef/T/pai-scratch/x/a.sh";

  it("match: /Users/folders/... Write is repaired to the real scratch dir when it exists, and recorded", () => {
    const { out, fired } = call("Write", "/Users/folders/ab/cdef/pai-scratch/x/a.sh", (p) => p === "/var/folders/ab/cdef/T/pai-scratch");
    expect(out).toMatchObject({ permissionDecision: "allow", updatedInput: { file_path: real } });
    expect(fired).toEqual([expect.objectContaining({ id: "mangled-var-folders-path", category: "paths", action: "note", mode: "enforce" })]);
  });

  it("match: /var/folders/<a>/<b>/pai-scratch (only T missing) and a Read are repaired too", () => {
    const { out } = call("Read", "/var/folders/ab/cdef/pai-scratch/x/a.sh", () => true);
    expect(out).toMatchObject({ permissionDecision: "allow", updatedInput: { file_path: real } });
  });

  it("match: an Edit cannot be rewritten, so it is denied with the exact path", () => {
    const { out } = call("Edit", "/Users/folders/ab/cdef/pai-scratch/x/a.sh", () => true);
    expect(out?.permissionDecision).toBe("deny");
    expect(out?.permissionDecisionReason).toContain(real);
  });

  it("match: denies with the hint when the real scratch dir does not exist", () => {
    const { out, fired } = call("Write", "/Users/folders/ab/cdef/pai-scratch/x/a.sh", () => false);
    expect(out?.permissionDecision).toBe("deny");
    expect(out?.permissionDecisionReason).toContain("$TMPDIR");
    expect(fired[0]).toMatchObject({ action: "deny" });
  });

  it("no_match: other paths and non-workers are untouched and nothing is recorded", () => {
    for (const p of ["/Users/someone/folders/a.sh", real, "/Users/folders/ab/cdef/other/a.sh"]) {
      const { out, fired } = call("Write", p, () => true);
      expect(out, p).toBeNull();
      expect(fired, p).toEqual([]);
    }
    expect(call("Write", "/Users/folders/ab/cdef/pai-scratch/x/a.sh", () => true, {}).out).toBeNull();
  });
});
