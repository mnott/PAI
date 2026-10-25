import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLoopState, IDENTICAL_WRITE_STOP_AT, REVERT_STOP_AT, recordLoopResult, stepLoopGuard, type LoopState } from "./loop-guard.js";
import { loadLoopState, saveLoopState } from "./loop-guard-state.js";

describe("loop guard state disk round trip", () => {
  it("identical Writes: note from the 2nd, stop at IDENTICAL_WRITE_STOP_AT, as the two hooks run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lgs-"));
    try {
      const file = join(dir, "s.json");
      const input = { file_path: "/tmp/out/34.py", content: "print(1)\n" };
      const steps = [];
      for (let i = 0; i < IDENTICAL_WRITE_STOP_AT; i++) {
        const step = stepLoopGuard(loadLoopState(file), "Write", input);
        saveLoopState(file, step.state);
        steps.push(step);
        if (step.deny) break;
        saveLoopState(file, recordLoopResult(loadLoopState(file), "Write", input, { ok: true }));
      }
      expect(steps[0].note).toBeUndefined();
      expect(steps[1].note).toContain("already contains exactly this content");
      expect(steps.length).toBe(IDENTICAL_WRITE_STOP_AT);
      expect(steps[steps.length - 1].stop).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A,B,A,B Writes: revert note and stop survive the disk round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "lgs-"));
    try {
      const file = join(dir, "s.json");
      const steps = [];
      for (let i = 0; i < 12; i++) {
        const input = { file_path: "/tmp/out/27.py", content: i % 2 ? "B" : "A" };
        const step = stepLoopGuard(loadLoopState(file), "Write", input);
        saveLoopState(file, step.state);
        steps.push(step);
        if (step.deny) break;
        saveLoopState(file, recordLoopResult(loadLoopState(file), "Write", input, { ok: true }));
      }
      expect(steps[3].note).toContain("switching back");
      expect(steps.length).toBe(REVERT_STOP_AT + 2);
      expect(steps[steps.length - 1].stop).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("last, runLast, pollDone survive save/load", () => {
    const dir = mkdtempSync(join(tmpdir(), "lgs-"));
    try {
      const file = join(dir, "s.json");
      const s = {
        ...emptyLoopState(),
        window: ["Bash\tx"],
        outs: [null],
        last: { "Bash\tx": "sig" },
        runLast: { "Bash\ty": { sig: "a", n: 2 } },
        pollDone: { "Bash\tz": 3 },
      } as unknown as LoopState;
      saveLoopState(file, s);
      const l = loadLoopState(file);
      expect(l.last).toEqual(s.last);
      expect(l.runLast).toEqual(s.runLast);
      expect(l.pollDone).toEqual(s.pollDone);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
