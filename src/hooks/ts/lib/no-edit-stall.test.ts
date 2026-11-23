import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { workerCanEdit } from "../../../workers/run/argv.js";
import { bashWritesRepoFile, emptyLoopState, loopDenyReason, looksRed, recordLoopResult, stallSequence, stepLoopGuard, type LoopState, type LoopStep } from "./loop-guard.js";
import { activeAntipattern, resetAntipatternCache, shippedAntipattern } from "./antipatterns.js";
import { paramsForModel, perModelEntry } from "./antipattern-lifecycle.js";

const yamlDoc = parse(readFileSync("antipatterns/tool-loop/no-edit-stall.yaml", "utf8"));
const params = yamlDoc.detector.params as Record<string, unknown>;

const MIN = 60_000;
type Call = [string, Record<string, unknown> | string];
// real files, so the missing-path rule stays out of the way
const FILES = readdirSync("src/hooks/ts/lib").filter((f) => f.endsWith(".ts")).sort().map((f) => `src/hooks/ts/lib/${f}`);
const rd = (i: number): Call => ["Read", { file_path: FILES[i % FILES.length] }];
const E: Call = ["Edit", { file_path: "src/a.ts" }];

function run(calls: Call[], times?: number[]): LoopStep[] {
  let state: LoopState = emptyLoopState();
  const out: LoopStep[] = [];
  calls.forEach(([tool, input], i) => {
    const r = stepLoopGuard(state, tool, input, null, times ? times[i] : 1_000_000 + i, process.cwd());
    state = r.state;
    out.push(r);
  });
  return out;
}
const reads = (n: number, from = 0): Call[] => Array.from({ length: n }, (_, i) => rd(from + i));
const stalls = (steps: LoopStep[]): number[] => steps.map((s, i) => (s.id === "no-edit-stall" ? i : -1)).filter((i) => i >= 0);

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.PAI_WORKER_CAN_EDIT;
  process.env.PAI_WORKER_CAN_EDIT = "1";
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_WORKER_CAN_EDIT;
  else process.env.PAI_WORKER_CAN_EDIT = prev;
});

describe("workerCanEdit (PAI_WORKER_CAN_EDIT)", () => {
  it("is true for the default grant and for Edit/Write plus Bash", () => {
    expect(workerCanEdit([])).toBe(true);
    expect(workerCanEdit(["Read,Edit,Bash"])).toBe(true);
    expect(workerCanEdit(["Write", "Bash(git *)"])).toBe(true);
  });
  it("is false for read-only and eval sets", () => {
    expect(workerCanEdit(["Read,Grep,Glob,Bash"])).toBe(false);
    expect(workerCanEdit(["Read,Write"])).toBe(false);
    expect(workerCanEdit(["Edit"])).toBe(false);
  });
});

describe("bashWritesRepoFile", () => {
  it.each([
    ["python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF", true],
    ["node -e \"require('fs').writeFileSync('src/a.ts','x')\"", true],
    ["sed -i 's/a/b/' src/a.ts", true],
    ["cat > src/a.ts <<'EOF'\nx\nEOF", true],
    ["echo x >> notes.md", true],
    ["echo x | tee src/a.ts", true],
    ["cp $TMPDIR/fixed.mjs scripts/prune-dist.mjs", true],
    ["mv build/x.js src/x.js", true],
    ["git apply fix.patch", true],
    ["cat > $TMPDIR/x <<'EOF'\nx\nEOF", false],
    ["cat > .pai-scratch/p.mjs <<'EOF'\nx\nEOF", false],
    ["echo x > /tmp/x", false],
    ["echo x > /var/folders/ab/T/x", false],
    ["echo x > ${TMPDIR}/x", false],
    ["python3 - <<'EOF'\nopen('/tmp/x','w').write('x')\nEOF", false],
    ["cp src/a.ts $TMPDIR/a.ts", false],
    ["git checkout -- src/a.ts", false],
    ["grep -n foo src/a.ts 2>&1 | head", false],
    ["npx vitest run src/a.test.ts 2>/dev/null", false],
    ["git log --oneline -3", false],
  ])("%s -> %s", (cmd, want) => {
    expect(bashWritesRepoFile(cmd)).toBe(want);
  });
});

describe("no-edit-stall in stepLoopGuard", () => {
  it("12 reads: note1 once, at the 12th", () => {
    const steps = run(reads(14));
    expect(stalls(steps)).toEqual([11]);
    expect(steps[11].note).toContain("12 read-only calls");
    expect(steps[11].deny).toBe(false);
  });
  it("11 reads, an edit, 11 reads: nothing", () => {
    expect(stalls(run([...reads(11), E, ...reads(11, 20)]))).toEqual([]);
  });
  it("25 reads: note2 at the 25th", () => {
    const steps = run(reads(25));
    expect(stalls(steps)).toEqual([11, 24]);
    expect(steps[24].note).toContain("still no edit");
  });
  it("40 reads: reads are denied from the 40th, an Edit stays allowed and resets", () => {
    const steps = run([...reads(40), rd(99), E, rd(100)]);
    expect(steps[38].deny).toBe(false);
    expect(steps[39].deny).toBe(true);
    expect(steps[39].stop).toBeFalsy();
    expect(steps[39].id).toBe("no-edit-stall");
    expect(steps[39].reason).toContain("40 calls");
    expect(steps[40].deny).toBe(true);
    expect(steps[41].deny).toBe(false);
    expect(steps[42].deny).toBe(false);
  });
  it("Edit, Write, a bash write and a test run stay allowed past the deny threshold", () => {
    const base = reads(41);
    expect(run([...base, ["Bash", `npx vitest run ${FILES[3]}`]])[41].deny).toBe(false);
    expect(run([...base, ["Write", { file_path: "src/n.ts" }]])[41].deny).toBe(false);
    expect(run([...base, ["Bash", "sed -i s/a/b/ src/a.ts"]])[41].deny).toBe(false);
    expect(run([...base, ["Bash", "git log -3"]])[41].deny).toBe(true);
  });
  it("time-only trigger: 5 calls over 4 min give note1", () => {
    const steps = run(reads(5), [0, MIN, 2 * MIN, 3 * MIN, 4 * MIN]);
    expect(stalls(steps)).toEqual([4]);
    expect(steps[4].note).toContain("4 min");
  });
  it("time-only deny at 12 min", () => {
    expect(run(reads(3), [0, MIN, 12 * MIN])[2].deny).toBe(true);
  });
  it("scratch-only writes do not reset", () => {
    const scratch: Call[] = [
      ["Bash", "cat > $TMPDIR/x <<'EOF'\nx\nEOF"],
      ["Bash", "cat > .pai-scratch/p.mjs <<'EOF'\nx\nEOF"],
      ["Bash", "echo x > /tmp/y"],
      ["Write", { file_path: "/var/folders/ab/T/z.txt" }],
    ];
    expect(stalls(run([...reads(4), ...scratch, ...reads(4, 10)]))).toEqual([11]);
  });
  it("a python heredoc to a repo path resets", () => {
    const h: Call = ["Bash", "python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF"];
    expect(stalls(run([...reads(11), h, ...reads(11, 20)]))).toEqual([]);
  });
  it("test runs count and do not reset", () => {
    const t = (i: number): Call => ["Bash", `npx vitest run ${FILES[i]}`];
    expect(stalls(run([...reads(6), t(1), t(2), t(3), t(4), t(5), t(6)]))).toEqual([11]);
  });
  it("env unset: inactive, state untouched", () => {
    delete process.env.PAI_WORKER_CAN_EDIT;
    const steps = run(reads(45));
    expect(stalls(steps)).toEqual([]);
    expect(steps[44].state.stall).toBeUndefined();
  });
  it("env 0: inactive", () => {
    process.env.PAI_WORKER_CAN_EDIT = "0";
    expect(stalls(run(reads(45)))).toEqual([]);
  });
});

describe("no-edit-stall.yaml tests block", () => {
  for (const seq of yamlDoc.tests.match as string[]) {
    it(`match: ${seq}`, () => expect(stallSequence(seq, params)).not.toBeNull());
  }
  for (const seq of yamlDoc.tests.no_match as string[]) {
    it(`no_match: ${seq}`, () => expect(stallSequence(seq, params)).toBeNull());
  }
});

// ---- growing-command: unedited / edited-red texts and per_model globs ----

const gcShipped = shippedAntipattern("growing-command").detector.params;
const UNEDITED_NOTE = gcShipped.note_message_unedited as string;
const PLAIN_NOTE = gcShipped.note_message as string;
const RED_NOTE = gcShipped.note_message_edited_red as string;
const GREP = "grep -rn foo src";

function gcDrive(state: LoopState, tool: string, input: string | Record<string, unknown>, out = "src/a.ts:1: foo"): { state: LoopState; step: LoopStep } {
  const step = stepLoopGuard(state, tool, input, null, 1_000_000, process.cwd());
  if (step.deny) return { state: step.state, step };
  return { state: recordLoopResult(step.state, tool, input, out), step };
}
const gcRepeat = (state: LoopState, n: number, out?: string): { state: LoopState; steps: LoopStep[] } => {
  const steps: LoopStep[] = [];
  for (let i = 0; i < n; i++) {
    const r = gcDrive(state, "Bash", GREP, out);
    state = r.state;
    steps.push(r.step);
  }
  return { state, steps };
};
const gcEdit = (state: LoopState, tool = "Edit", input: Record<string, unknown> = { file_path: "src/a.ts", old_string: "a", new_string: "b" }): LoopState => gcDrive(state, tool, input).state;

describe("growing-command per_model globs", () => {
  const pm = { "inkling-2-mini*": { params: { x: 1 } }, "Inkling-2-Mini*": { params: { x: 2 } } };
  it("matches variants, case-sensitive, not other models", () => {
    expect(perModelEntry(pm, "inkling-2-mini-mtplx")).toBe(pm["inkling-2-mini*"]);
    expect(perModelEntry(pm, "inkling-2-mini")).toBe(pm["inkling-2-mini*"]);
    expect(perModelEntry(pm, "Inkling-2-Mini-MLX-nvfp4")).toBe(pm["Inkling-2-Mini*"]);
    expect(perModelEntry(pm, "qwen3.8-flash")).toBeUndefined();
    expect(paramsForModel({ x: 0 }, { per_model: pm }, "qwen3.8-flash")).toEqual({ x: 0 });
  });
});

describe("looksRed", () => {
  it("flags failing results only", () => {
    expect(looksRed("Tests 2 failed")).toBe(true);
    expect(looksRed("Exit code 1")).toBe(true);
    expect(looksRed("not ok 3")).toBe(true);
    expect(looksRed("all 12 passed")).toBe(false);
    expect(looksRed(null)).toBe(false);
  });
});

describe("growing-command unedited / edited texts", () => {
  let savedHome: string | undefined;
  let savedModel: string | undefined;
  let savedEdit: string | undefined;
  beforeEach(() => {
    savedHome = process.env.PAI_HOME;
    savedModel = process.env.PAI_WORKER_MODEL;
    savedEdit = process.env.PAI_WORKER_CAN_EDIT;
    delete process.env.PAI_WORKER_MODEL;
    delete process.env.PAI_WORKER_CAN_EDIT;
    resetAntipatternCache();
  });
  afterEach(() => {
    for (const [k, v] of [["PAI_HOME", savedHome], ["PAI_WORKER_MODEL", savedModel], ["PAI_WORKER_CAN_EDIT", savedEdit]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAntipatternCache();
  });

  it("no edit yet: the 3rd identical grep notes with the unedited text", () => {
    expect(gcRepeat(emptyLoopState(), 3).steps[2].note).toBe(UNEDITED_NOTE);
  });

  it("after a repo edit the plain note is back", () => {
    const { steps, state } = gcRepeat(gcEdit(emptyLoopState()), 3);
    expect(state.edited).toBe(true);
    expect(steps[2].note).toBe(PLAIN_NOTE);
  });

  it("a scratch edit does not count as edited; a bash repo write does", () => {
    let s = gcEdit(emptyLoopState(), "Write", { file_path: ".pai-scratch/x.py", content: "1" });
    expect(s.edited).toBeUndefined();
    s = gcDrive(s, "Bash", "cat > src/new.ts <<'EOF'\nx\nEOF").state;
    expect(s.edited).toBe(true);
    expect(gcRepeat(s, 3).steps[2].note).toBe(PLAIN_NOTE);
  });

  it("after an edit and a red previous result: the edited_red text", () => {
    expect(gcRepeat(gcEdit(emptyLoopState()), 3, "Tests 2 failed\nExit code 1").steps[2].note).toBe(RED_NOTE);
  });

  it("the 4th repeat deny drops the report line unedited, keeps it after an edit", () => {
    const un = gcRepeat(emptyLoopState(), 5).steps[4];
    expect(un.deny).toBe(true);
    expect(un.reason).toContain("Edit a file the spec names");
    expect(un.reason).toContain("4 times");
    expect(un.reason).not.toContain("Write your R report now");
    const ed = gcRepeat(gcEdit(emptyLoopState()), 5).steps[4];
    expect(ed.deny).toBe(true);
    expect(ed.reason ?? loopDenyReason("Bash")).toContain("Write your R report now");
  });

  it.skipIf(!existsSync(".pai-scratch/growing-command.user.yaml"))("user file with model globs (temp PAI_HOME) resolves the unedited text", () => {
    const home = mkdtempSync(join(tmpdir(), "pai-home-"));
    try {
      mkdirSync(join(home, "antipatterns", "tool-loop"), { recursive: true });
      copyFileSync(".pai-scratch/growing-command.user.yaml", join(home, "antipatterns", "tool-loop", "growing-command.yaml"));
      process.env.PAI_HOME = home;
      process.env.PAI_WORKER_MODEL = "inkling-2-mini-mtplx";
      resetAntipatternCache();
      const ap = activeAntipattern("growing-command");
      expect(ap.version).toBe(3);
      expect(paramsForModel(ap.detector.params, ap, "inkling-2-mini-mtplx").note_message_unedited).toBe(UNEDITED_NOTE);
      expect(paramsForModel(ap.detector.params, ap, "Inkling-2-Mini-MLX-nvfp4").note_message_unedited).toBe(UNEDITED_NOTE);
      expect(gcRepeat(emptyLoopState(), 3).steps[2].note).toBe(UNEDITED_NOTE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
