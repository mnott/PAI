import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLoopState, stepLoopGuard, type LoopState } from "./loop-guard.js";
import { classifyToolError, readToolErrors, recordToolError } from "../../../workers/tool-errors.js";

/** Feeds calls in order; returns the index of each denied call. */
function feed(calls: Array<[string, string?]>): number[] {
  let s: LoopState = emptyLoopState();
  const denied: number[] = [];
  calls.forEach(([tool, cmd], i) => {
    const r = stepLoopGuard(s, tool, cmd);
    s = r.state;
    if (r.deny) denied.push(i);
  });
  return denied;
}
const bash = (c: string): [string, string] => ["Bash", c];
const edit: [string] = ["Edit"];

describe("loop guard", () => {
  it("denies the 5th identical probe with only a numbered tmp file changing", () => {
    const calls = Array.from({ length: 8 }, (_, i) => bash(`npx tsx src/cli/index.ts more x > /tmp/m${i + 10}.out`));
    expect(feed(calls)).toEqual([4, 5, 6, 7]);
  });
  it("denies the 5th identical vitest run after a commit", () => {
    const t = "npx vitest run src/a.test.ts";
    expect(feed([bash(t), bash("git commit -m x"), bash(t), bash(t), bash(t), bash(t)])).toEqual([5]);
  });
  it("denies an alternating proof/check pattern", () => {
    const calls: Array<[string, string]> = [];
    for (let i = 0; i < 5; i++) calls.push(bash("mutate.sh"), bash("check.sh"));
    expect(feed(calls)[0]).toBe(8);
  });
  it("denies the 5th identical sed read", () => {
    const c = bash("sed -n 1,40p  src/a.ts");
    expect(feed([c, c, c, c, bash("sed -n 1,40p src/a.ts")])).toEqual([4]);
  });
  it("never denies edit-test-edit-test", () => {
    const calls: Array<[string, string?]> = [];
    for (let i = 0; i < 20; i++) calls.push(bash("npx vitest run"), edit);
    expect(feed(calls)).toEqual([]);
  });
  it("never denies different sed ranges", () => {
    const calls = Array.from({ length: 30 }, (_, i) => bash(`sed -n ${i * 40 + 1},${i * 40 + 40}p f.ts`));
    expect(feed(calls)).toEqual([]);
  });
  it("does not collapse digits outside /tmp paths", () => {
    expect(feed(Array.from({ length: 8 }, (_, i) => bash(`echo ${i}`)))).toEqual([]);
  });
  it("an edit resets the window", () => {
    const c = bash("npm test");
    expect(feed([c, c, c, c, edit, c, c, c, c])).toEqual([]);
  });
});

describe("loop event record", () => {
  it("is recorded and classified as a model error", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopguard-"));
    try {
      recordToolError(dir, { worker: "w1", provider: "p", label: "l", tool: "Bash", text: "loop guard: same command npm test", input: { command: "npm test" } });
      const recs = readToolErrors(dir);
      expect(recs).toHaveLength(1);
      expect(classifyToolError(recs[0]).cls).toBe("model");
      expect(classifyToolError(recs[0]).hint).toMatch(/loop/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
