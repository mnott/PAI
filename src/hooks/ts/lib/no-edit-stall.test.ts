import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { workerCanEdit } from "../../../workers/run/argv.js";
import { effectiveDeliverable, isCodeChangingClass } from "./stall-class.js";
import { bashWritesRepoFile, emptyLoopState, loopDenyReason, looksRed, recordLoopResult, stallSequence, stallStep, stepLoopGuard, type LoopState, type LoopStep } from "./loop-guard.js";
import { activeAntipattern, resetAntipatternCache, shippedAntipattern } from "./antipatterns.js";
import { loadLoopState, logHookError, loopStateFile, saveLoopState } from "./loop-guard-state.js";
import { announcesAction, announcedActionDecision } from "../../../workers/run/announced-action.js";
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

describe("class gate (PAI_WORKER_CAN_EDIT from the class, not the tools)", () => {
  it("isCodeChangingClass: code classes yes, read-only/analysis classes and unknown names no", () => {
    for (const c of ["implement", "complex", "simple", "draft"]) expect(isCodeChangingClass(c)).toBe(true);
    for (const c of ["research", "plan", "review", "spotcheck", "orchestrate", "image", "custom-tier-class", "", undefined]) expect(isCodeChangingClass(c)).toBe(false);
  });
  it("effectiveDeliverable: a declared value wins, else the class gate", () => {
    expect(effectiveDeliverable("findings", "implement")).toBe("findings");
    expect(effectiveDeliverable("change", "research")).toBe("change");
    expect(effectiveDeliverable(undefined, "implement")).toBe("change");
    expect(effectiveDeliverable(undefined, "research")).toBe("findings");
    expect(effectiveDeliverable("bogus", "draft")).toBe("change");
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
    ["mkdir -p .pai-scratch && cat > .pai-scratch/repro.mjs <<'EOF'\nimport {writeFileSync} from 'fs'; writeFileSync('src/a.ts','x')\nEOF", false],
    ["python3 - <<'EOF'\nopen('/tmp/x','w').write('x')\nopen('src/a.ts','w').write('y')\nEOF", true],
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
  it("minutes never trigger: 6 calls over 5 min and a 12-min gap give nothing (slow machine, same work)", () => {
    expect(stalls(run(reads(6), [0, MIN, 2 * MIN, 3 * MIN, 4 * MIN, 5 * MIN]))).toEqual([]);
    expect(run(reads(6), [0, MIN, 2 * MIN, 3 * MIN, 4 * MIN, 12 * MIN])[5].deny).toBe(false);
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

  // ---- the guard follows the deliverable (PAI_WORKER_CAN_EDIT is set only for "change") ----
  it("findings job (PAI_WORKER_CAN_EDIT unset): 50 reads and scratch writes give no note and no deny", () => {
    delete process.env.PAI_WORKER_CAN_EDIT; // what execute-prepare sets for a findings job
    const steps = run([...reads(25), ...reads(25)]);
    expect(stalls(steps)).toEqual([]);
    expect(steps[49].deny).toBe(false);
  });

  it("change job unchanged: notes and deny still fire", () => {
    const steps = run(reads(40));
    expect(stalls(steps)).toEqual([11, 24, 39]);
    expect(steps[39].deny).toBe(true);
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

describe("no-edit-stall: scratch work after the first repo edit", () => {
  const scratch: [string, Record<string, unknown>] = ["Write", { file_path: ".pai-scratch/t.test.ts" }];
  const runs = (n: number, from = 0): [string, string][] => Array.from({ length: n }, (_, i) => ["Bash", `npx vitest run ${from + i}`]);
  const fire = (calls: [string, Record<string, unknown> | string][], stepMs: number): (string | undefined)[] => {
    let st: LoopState["stall"];
    return calls.map(([t, i], k) => {
      const r = stallStep(st, t, i, k * stepMs, params);
      st = r.stall;
      return r.kind;
    });
  };
  const edit: [string, Record<string, unknown>] = ["Edit", { file_path: "src/a.ts" }];
  it("a scratch write after a repo edit resets the stall counter", () => {
    const calls = [edit, ...Array.from({ length: 11 }, (): [string, Record<string, unknown>] => ["Read", { file_path: "src/a.ts" }]), scratch, ["Read", { file_path: "src/a.ts" }]] as [string, Record<string, unknown>][];
    expect(fire(calls, 1000).includes("note1")).toBe(false);
  });
  it("a scratch write before any repo edit does not reset", () => {
    const calls = Array.from({ length: 12 }, (_, i): [string, Record<string, unknown>] => (i === 5 ? scratch : ["Read", { file_path: "src/a.ts" }]));
    expect(fire(calls, 1000)[11]).toBe("note1");
  });
  it("the same call counts note at any speed (counts only)", () => {
    const twelve = Array.from({ length: 12 }, (): [string, Record<string, unknown>] => ["Read", { file_path: "a" }]);
    expect(fire(twelve, 1 * MIN)[11]).toBe("note1");
    expect(fire(twelve, 30 * MIN)[11]).toBe("note1");
    expect(fire(twelve.slice(0, 6), 30 * MIN).every((k) => k === undefined)).toBe(true);
  });
  it("test runs plus scratch edits after a repo edit never note", () => {
    const calls: [string, Record<string, unknown> | string][] = [edit];
    for (let i = 0; i < 10; i++) calls.push(["Bash", "npx vitest run x"], ["Edit", { file_path: ".pai-scratch/w.test.ts" }]);
    expect(fire(calls, 30_000).every((k) => k === undefined)).toBe(true);
  });
  void runs;
});

// ---- repeated-failure: content states, write+runner, baseline-red text ----

const rfShipped = shippedAntipattern("repeated-failure").detector.params;
const RF_BASE = rfShipped.message_baseline_red as string;
const RF_WRITE = rfShipped.message_with_write as string;
const RUN = "npx vitest run x.test.ts";
const RED = "Exit code 1\nFAIL x.test.ts\nAssertionError";
const OK = "Exit code 0\nok";

function rf(state: LoopState, cmd: string, fp: string, out = OK): { state: LoopState; step: LoopStep } {
  const step = stepLoopGuard(state, "Bash", cmd, fp, 1_000_000, process.cwd());
  if (step.deny) return { state: step.state, step };
  return { state: recordLoopResult(step.state, "Bash", cmd, out), step };
}

describe("repeated-failure content states (taxonomy 1.1 low r1 prune)", () => {
  it("a cp toggle back to an earlier state keeps counting; the first-time state resets; 3rd run in state A is denied", () => {
    let s = emptyLoopState();
    let r = rf(s, RUN, "A"); s = r.state; // run 1 in A
    s = { ...s, edited: true };
    r = rf(s, RUN, "B"); s = r.state; // new state: resets to 1
    expect(s.runs?.[RUN.replace("npx ", "").replace(" run", "").replace("vitest ", "vitest ")] ?? Object.values(s.runs ?? {})[0]).toBe(1);
    r = rf(s, RUN, "A"); s = r.state; // toggle back: counts on, not denied yet
    expect(r.step.deny).toBe(false);
    expect(Object.values(s.runs ?? {})[0]).toBe(2);
    r = rf(s, RUN, "A");
    expect(r.step.deny).toBe(true);
    expect(r.step.id).toBe("repeated-failure");
  });

  it("toggling A/B/A/B cannot reset forever", () => {
    let s = emptyLoopState();
    let denied = false;
    for (const fp of ["A", "B", "A", "B", "A", "B"]) {
      const r = rf(s, RUN, fp);
      s = r.state;
      if (r.step.deny) denied = true;
    }
    expect(denied).toBe(true);
  });

  it("a compound write + runner is allowed and counts as a fresh run; a plain re-run is denied", () => {
    const heredoc = "python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF\nnpx vitest run x.test.ts";
    for (const cmd of [heredoc, "sed -i '' -e 's/a/b/' src/a.ts && npx vitest run x.test.ts", "git apply p.diff && npx vitest run x.test.ts"]) {
      let s = emptyLoopState();
      for (let i = 0; i < 4; i++) {
        const r = rf(s, cmd, "A");
        s = r.state;
        expect(r.step.deny).toBe(false);
      }
      expect(Object.values(s.runs ?? {})[0]).toBe(1);
    }
    let s = emptyLoopState();
    const denies = [1, 2, 3].map(() => { const r = rf(s, RUN, "A"); s = r.state; return r.step.deny; });
    expect(denies).toEqual([false, false, true]);
  });

  it("an output redirect of the runner is no write; a scratch-only write uses the no-clause text", () => {
    let s = emptyLoopState();
    let last: LoopStep | undefined;
    for (let i = 0; i < 3; i++) { const r = rf(s, `${RUN} > out.log 2>&1`, "A"); s = r.state; last = r.step; }
    expect(last?.deny).toBe(true);
    s = emptyLoopState();
    const cmd = `echo hi > .pai-scratch/n.txt && ${RUN}`;
    for (let i = 0; i < 3; i++) { const r = rf(s, cmd, "A", "Exit code 0\nok"); s = r.state; last = r.step; }
    expect(last?.deny).toBe(true);
    expect(last?.reason).not.toContain("without changing anything");
    expect(last?.reason).toContain("did not change");
    expect(RF_WRITE).not.toContain("without changing");
  });

  it("baseline red with an unchanged result uses the baseline text; a green baseline the plain text", () => {
    let s = emptyLoopState();
    let last: LoopStep | undefined;
    for (let i = 0; i < 3; i++) { const r = rf(s, RUN, "A", RED); s = r.state; last = r.step; }
    expect(last?.reason).toBe(RF_BASE);
    s = emptyLoopState();
    for (let i = 0; i < 3; i++) { const r = rf(s, RUN, "A", "Exit code 0\nall passed"); s = r.state; last = r.step; }
    expect(last?.reason).toContain("without changing anything");
    s = emptyLoopState();
    for (let i = 0; i < 3; i++) { const r = rf(s, RUN, "A", i === 1 ? "Exit code 1\nFAIL other thing entirely" : RED); s = r.state; last = r.step; }
    expect(last?.reason).toContain("without changing anything");
  });
});

describe("growing-command: repeats need similar results", () => {
  const G = "src/cli/commands/worker-config.ts";
  const play = (cmds: string[], out: (i: number) => string) => {
    let s = emptyLoopState();
    return cmds.map((c, i) => {
      const r = stepLoopGuard(s, "Bash", c, null, 1_000_000 + i * 5000, process.cwd());
      s = r.state;
      if (!r.deny) s = recordLoopResult(s, "Bash", c, { stdout: out(i), stderr: "" }, 1_000_001 + i * 5000);
      return r;
    });
  };
  it("nine different sed/grep windows with different output: no deny, no stop", () => {
    const cmds = [`ls && sed -n 1,80p ${G}`, `sed -n 80,200p ${G}`, `grep -n policy ${G} | head`, `sed -n 1255,1310p ${G} && grep -n x ${G}`, `sed -n 560,640p ${G} && grep -n y ${G}`, `grep -n priority ${G} src/workers/workers-config.ts | head`, `sed -n 245,400p ${G}`, `sed -n 109,130p ${G} && sed -n 500,570p ${G}`, `sed -n 500,560p ${G}`];
    const steps = play(cmds, (i) => Array.from({ length: 60 }, (_, j) => `line${i}_${j} word${i * 7 + j} foo`).join("\n"));
    expect(steps.some((r) => r.deny || r.stop)).toBe(false);
  });
  it("the same windows with unrecorded results are no repeats either", () => {
    let s = emptyLoopState();
    for (let i = 0; i < 9; i++) {
      const r = stepLoopGuard(s, "Bash", `sed -n ${i * 50},${i * 50 + 40}p ${G}`, null, 1_000_000 + i * 5000, process.cwd());
      s = r.state;
      expect(r.deny).toBe(false);
    }
  });
  it("git log x7 with the same result: note, deny after 4 runs, stop on the 3rd denial", () => {
    const steps = play(Array(7).fill("git log --oneline -3"), () => "abc123 first\ndef456 second");
    expect(steps.map((r) => r.deny)).toEqual([false, false, false, false, true, true, true]);
    expect(steps[2].note).toBeTruthy();
    expect(steps.map((r) => !!r.stop)).toEqual([false, false, false, false, false, false, true]);
  });
});


describe("result recording when hooks rewrote the input after Pre (loop guard recorded no results)", () => {
  const post = (state: LoopState, tool: string, pre: string | Record<string, unknown>, seen: string | Record<string, unknown>, out: string, i: number): LoopState => {
    const step = stepLoopGuard(state, tool, pre, null, 1_000_000 + i, process.cwd());
    return recordLoopResult(step.state, tool, seen, out, 1_000_000 + i);
  };
  it("a ztk-rewritten Bash command and a path-repaired Read still get their result in outs", () => {
    let s = emptyLoopState();
    s = post(s, "Bash", "ls && sed -n 1,80p src/a.ts", "ztk run ls && sed -n 1,80p src/a.ts", "out one", 0);
    s = post(s, "Bash", "grep -n x src/a.ts | head -5", "ztk run grep -n x src/a.ts | head -5", "out two", 1);
    s = post(s, "Read", { file_path: "/repo/src/b.ts" }, { file_path: "/tree/src/b.ts" }, "out three", 2);
    s = post(s, "Bash", "sed -n 1,9p src/c.ts", "sed -n 1,9p src/c.ts", "out four", 3);
    expect(s.window).toHaveLength(4);
    expect((s.outs ?? []).map((o) => o !== null && o !== undefined)).toEqual([true, true, true, true]);
  });
  it("the Post hook failure is written to the worker's hook error log", () => {
    const dir = mkdtempSync(join(tmpdir(), "hookerr-"));
    try {
      logHookError(dir, "w1", "worker-note", new Error("boom"));
      expect(readFileSync(join(dir, "hook-errors", "w1.log"), "utf8")).toMatch(/worker-note: Error: boom/);
      saveLoopState(loopStateFile(dir, "w1"), emptyLoopState());
      expect(loadLoopState(loopStateFile(dir, "w1")).window).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- announced-no-action.yaml tests block ----
describe("announced-no-action.yaml tests block", () => {
  const doc = parse(readFileSync("antipatterns/final-text/announced-no-action.yaml", "utf8"));
  for (const t of doc.tests.match as string[]) it(`match: ${t}`, () => expect(announcesAction(t)).toBe(true));
  for (const t of doc.tests.no_match as string[]) it(`no_match: ${t.slice(0, 30)}`, () => expect(announcesAction(t)).toBe(false));
  it("caps at max_per_run and needs tools", () => {
    expect(announcedActionDecision("I'll read the file.", 0, true)?.mode).toBe("enforce");
    expect(announcedActionDecision("I'll read the file.", 2, true)).toBeNull();
    expect(announcedActionDecision("I'll read the file.", 0, false)).toBeNull();
  });
});

// ---- result-fingerprint: counts, keys, regex captures, the three monitor-mode loop patterns ----

describe("result-fingerprint", () => {
  const SAMPLE: Record<string, [string, (n: number) => string]> = {
    "disabled-tool-retry": ["Bash", () => "No such tool available: Bash. Bash is disabled for this session"],
    "hook-block-streak": ["Bash", (n) => `PreToolUse:Bash hook error: [guard]: Blocked by PAI security validator: rule number ${n}.`],
    "edit-noop-repeat": ["Edit", () => "No changes to make: old_string and new_string are exactly the same"],
  };
  // a fixture token: Fn = one matching result with fingerprint n; anything else = an unrelated result
  const replay = (id: string, seq: string): LoopStep => {
    const [tool, text] = SAMPLE[id];
    let state = emptyLoopState();
    for (const t of seq.split(/\s+/)) {
      const f = /^F(\d+)$/.exec(t);
      state = recordLoopResult(state, tool, tool === "Bash" ? `ls ${t}` : { file_path: "src/a.ts", old_string: "x", new_string: "x" }, f ? text(Number(f[1])) : "ok", 1_000_000);
    }
    return stepLoopGuard(state, tool, tool === "Bash" ? "ls last" : { file_path: "src/a.ts", old_string: "y", new_string: "y" }, null, 1_000_001, process.cwd());
  };
  for (const id of Object.keys(SAMPLE)) {
    const doc = parse(readFileSync(`antipatterns/tool-loop/${id}.yaml`, "utf8"));
    it(`${id}: monitor mode, experimental`, () => {
      expect(doc.mode).toBe("monitor");
      expect(doc.status).toBe("experimental");
    });
    for (const seq of doc.tests.match as string[]) it(`${id} match: ${seq}`, () => {
      const r = replay(id, seq);
      expect(r.deny).toBe(false); // monitor: no action
      expect(r.monitored?.action).toBe("deny");
      expect(r.id).toBe(id);
    });
    for (const seq of doc.tests.no_match as string[]) it(`${id} no_match: ${seq}`, () => expect(replay(id, seq).monitored).toBeUndefined());
  }
  it("key captures: the same capture counts together, another does not", () => {
    expect(replay("hook-block-streak", "F1 F1 F1").monitored).toBeDefined();
    expect(replay("hook-block-streak", "F1 F2 F1").monitored).toBeUndefined();
  });
  it("counts survive and are keyed per tool", () => {
    const s = recordLoopResult(recordLoopResult(emptyLoopState(), "Edit", { file_path: "a" }, "No changes to make: old_string and new_string are exactly the same"), "Edit", { file_path: "a" }, "No changes to make: old_string and new_string are exactly the same");
    expect(Object.values(s.results ?? {})).toEqual([{ tool: "Edit", n: 2, d: 0 }]);
    expect(stepLoopGuard(s, "Read", { file_path: FILES[0] }, null, 1_000_000, process.cwd()).monitored).toBeUndefined();
  });
});

// ---- rewrite-unchanged-after-same-error ----
// Worker 20261123-135804-43914 (Paperfull) rewrote a scratch proof driver byte-for-byte after
// the same failing proof ("folder 2 not found in [data-testid=staging-list]"); identical-write
// only counts consecutive writes of one file, so interleaving two scratch files never hit its
// stop_at. An unchanged rewrite right after the same red result is now stopped at the 2nd such rewrite.

const RW_DRIVER = ".pai-scratch/jsdom-driver.js";
const RW_DEBUG = ".pai-scratch/debug-boot.js";
const RW_RUN = "node .pai-scratch/jsdom-driver.js";
const RW_FAIL = 'DRIVER FAIL: Error: folder 2 not found in [data-testid="staging-list"]     at clickFolder (/repo/.pai-scratch/jsdom-driver.js:41:11)';
const RW_FAIL2 = "DRIVER FAIL: SyntaxError: Unexpected token } in JSON at position 42     at parse (/repo/.pai-scratch/jsdom-driver.js:12:5)";
const RW_OK = "DRIVER OK: 12 passed";

type RwCall = [string, Record<string, unknown> | string, string?];
const rwW = (file: string, content: string): RwCall => ["Write", { file_path: file, content }];
const rwE = (file: string, old: string, neu: string): RwCall => ["Edit", { file_path: file, old_string: old, new_string: neu }];
const rwRun = (out: string): RwCall => ["Bash", RW_RUN, out];

/** Replays a transcript (Pre then Post per call); returns the step of the last call. */
function rwReplay(calls: RwCall[]): LoopStep {
  let state: LoopState = emptyLoopState();
  let last: LoopStep | undefined;
  calls.forEach(([tool, input, out], i) => {
    const now = 1_000_000 + i * 1000;
    const step = stepLoopGuard(state, tool, input, null, now, process.cwd());
    state = step.state;
    last = step;
    if (!step.deny) state = recordLoopResult(state, tool, input, out ?? "ok", now);
  });
  return last!;
}

describe("rewrite-unchanged-after-same-error", () => {
  it("stops at the 2nd unchanged rewrite after the same failing result", () => {
    const steps = [
      rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL)]), // first write: allowed
      rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1")]), // 1st unchanged rewrite after the same failure: allowed
      rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1")]), // 2nd: stopped
    ];
    expect(steps[0].deny).toBe(false);
    expect(steps[1].deny).toBe(false);
    expect(steps[2].deny).toBe(true);
    expect(steps[2].stop).toBe(true);
    expect(steps[2].id).toBe("rewrite-unchanged-after-same-error");
    expect(steps[2].reason).toContain(RW_DRIVER);
    expect(steps[2].reason).toContain("unchanged after the same failure");
    expect(steps[2].reason).toContain("Read the code the proof drives and change that, not the driver.");
  });

  it("a rewrite after a different failure is not counted by this rule (identical-write still notes it)", () => {
    const s = rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL2), rwW(RW_DRIVER, "v1")]);
    expect(s.id).not.toBe("rewrite-unchanged-after-same-error");
    expect(s.stop).toBeFalsy();
  });

  it("a rewrite after a green result is not counted", () => {
    const s = rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1"), rwRun(RW_OK), rwW(RW_DRIVER, "v1")]);
    expect(s.deny).toBe(false);
    expect(s.stop).toBeFalsy();
  });

  it("a rewrite with different content is not counted", () => {
    const s = rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v2"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v2")]);
    expect(s.deny).toBe(false);
    expect(s.stop).toBeFalsy();
  });

  it("two identical writes with no run between them are not counted", () => {
    const s = rwReplay([rwW(RW_DRIVER, "v1"), rwW(RW_DRIVER, "v1"), rwW(RW_DRIVER, "v1")]);
    expect(s.deny).toBe(false);
    expect(s.stop).toBeFalsy();
  });

  it("interleaving a second scratch file does not dodge the guard (the transcript case)", () => {
    const s = rwReplay([
      rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL),
      rwW(RW_DEBUG, "d1"), rwRun(RW_FAIL),
      rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL),
      rwW(RW_DEBUG, "d1"), rwRun(RW_FAIL),
      rwW(RW_DRIVER, "v1"),
    ]);
    expect(s.deny).toBe(true);
    expect(s.stop).toBe(true);
    expect(s.id).toBe("rewrite-unchanged-after-same-error");
  });

  it("an edit to the driver between the runs breaks the chain", () => {
    const s = rwReplay([rwW(RW_DRIVER, "v1"), rwRun(RW_FAIL), rwE(RW_DRIVER, "v1", "v2"), rwRun(RW_FAIL), rwW(RW_DRIVER, "v1")]);
    expect(s.deny).toBe(false);
    expect(s.stop).toBeFalsy();
  });
});

describe("rewrite-unchanged-after-same-error.yaml", () => {
  const doc = parse(readFileSync("antipatterns/tool-loop/rewrite-unchanged-after-same-error.yaml", "utf8"));
  it("is shipped with the required note", () => {
    expect(doc.detector.kind).toBe("identical-write");
    expect(doc.detector.params.stop_at).toBe(2);
    expect(doc.message).toContain("Read the code the proof drives and change that, not the driver.");
  });
});

describe("pai worker wait repeats (loop guard)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wait-loop-"));
    const st = (id: string, state: string) => writeFileSync(join(dir, `${id}.status`), JSON.stringify({ id, state, pid: process.pid }));
    st("w-live", "running");
    st("w-done", "done");
    st("w-done2", "done");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Repeats `cmd` 8 times (Pre then Post, result `out`); the index of the first denied call, or -1. */
  function firstDeny(cmd: string, out: string): number {
    let state: LoopState = emptyLoopState();
    for (let i = 0; i < 8; i++) {
      const now = 1_000_000 + i * 1000;
      const r = stepLoopGuard(state, "Bash", cmd, null, now, process.cwd(), undefined, false, "hook", dir);
      if (r.deny) return i;
      state = recordLoopResult(r.state, "Bash", cmd, `Exit code 3\n${out}`, now, false, dir);
    }
    return -1;
  }

  it("a repeated wait on live ids is not blocked, even when any one of several ids is live", () => {
    expect(firstDeny("pai worker wait w-live --max 100; echo rc=$?", "w-live running")).toBe(-1);
    expect(firstDeny("pai worker wait w-done w-live --max 100; echo rc=$?", "w-live running")).toBe(-1);
  });

  it("a repeated wait after all ids finished is blocked", () => {
    expect(firstDeny("pai worker wait w-done w-done2 --max 100; echo rc=$?", "w-done done")).toBeGreaterThanOrEqual(0);
  });

  it("wait-on a live pid is not blocked, a dead pid is", () => {
    expect(firstDeny(`pai worker wait-on ${process.pid} --max 100`, "still running")).toBe(-1);
    expect(firstDeny("pai worker wait-on 2147483000 --max 100", "ended")).toBeGreaterThanOrEqual(0);
  });

  it("other repeated commands stay blocked", () => {
    expect(firstDeny("ls /nonexistent-dir-x", "ls: no such file")).toBeGreaterThanOrEqual(0);
  });
});
