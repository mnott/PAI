import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLoopState, loopDenyReason, stepLoopGuard, loopKey, type LoopState } from "./loop-guard.js";
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

describe("test-run keying", () => {
  const variants = [
    "npx vitest run src/cli/defs/launch.test.ts --config vitest.config.ts 2>&1",
    'npx vitest run "src/cli/defs/launch.test.ts" 2>&1',
    "npx vitest run src/cli/defs/launch.test.ts --run 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts --fileParallelism 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts --no-isolate 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts 2>&1",
    "npx vitest run --dir src/cli/defs src/cli/defs/launch.test.ts 2>&1",
  ];
  it("the seven flag variants share one key; the 5th is denied", () => {
    expect(loopKey(variants[0])).toBe(loopKey(variants[6]));
    expect(new Set(variants.map(loopKey)).size).toBe(1);
    expect(feed(variants.map(bash))).toEqual([4, 5, 6]);
  });
  it("a different target is a different key", () => {
    expect(loopKey("npx vitest run src/a.test.ts")).not.toBe(loopKey("npx vitest run src/b.test.ts"));
    expect(feed(Array.from({ length: 8 }, (_, i) => bash(`npx vitest run src/f${i}.test.ts`)))).toEqual([]);
  });
  it("no target keys as all; pipes and cd prefix ignored", () => {
    expect(loopKey("npm test | tail -20")).toBe(loopKey("cd x && npm run test -- --watch=false 2>&1"));
    expect(loopKey("pytest -x tests/a.py")).toBe(loopKey("python -m pytest tests/a.py -v | head"));
    expect(loopKey("go test ./...")).not.toBe(loopKey("go test ./pkg"));
  });
  it("an edit resets the count", () => {
    const v = variants.map(bash);
    expect(feed([...v.slice(0, 4), edit, ...v.slice(4)])).toEqual([]);
  });
  it("non-test commands keep plain normalisation", () => {
    expect(loopKey("echo   hi  ")).toBe("echo hi");
    expect(loopKey("git commit -m x")).not.toBe(loopKey("git commit -m y"));
  });
  it("deny message names the tests", () => {
    expect(loopDenyReason(true)).toMatch(/re-running the same tests on an unchanged tree \(4 times, flags varied\)/);
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
