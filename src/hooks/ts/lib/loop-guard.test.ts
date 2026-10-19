import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { emptyLoopState, loopDenyReason, stepLoopGuard, loopKey, toolKey, type LoopState } from "./loop-guard.js";
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

describe("loop guard, all tools", () => {
  const run = (calls: Array<[string, Record<string, unknown>]>) => {
    let s: LoopState = emptyLoopState();
    return calls.map(([tool, input]) => {
      const r = stepLoopGuard(s, tool, input);
      s = r.state;
      return r;
    });
  };
  const read = (offset?: number): [string, Record<string, unknown>] => ["Read", { file_path: "src/cli/registry.ts", offset }];
  it("484 identical Reads: deny from the 5th, stop at the 7th", () => {
    const rs = run(Array.from({ length: 484 }, () => read()));
    expect(rs.findIndex((r) => r.deny)).toBe(4);
    expect(rs.findIndex((r) => r.stop)).toBe(6);
    expect(rs[6].count).toBe(7);
    expect(rs.slice(0, 4).some((r) => r.deny)).toBe(false);
  });
  it("an Edit between resets counts and denials", () => {
    const rs = run([...Array.from({ length: 6 }, () => read()), ["Edit", {}], ...Array.from({ length: 4 }, () => read())]);
    expect(rs.map((r) => r.deny)).toEqual([false, false, false, false, true, true, false, false, false, false, false]);
    expect(rs.some((r) => r.stop)).toBe(false);
  });
  it("different offsets are different keys", () => {
    const rs = run(Array.from({ length: 20 }, (_, i) => read(i * 100)));
    expect(rs.some((r) => r.deny)).toBe(false);
  });
  it("Grep key ignores unrelated fields order; other tools use stable JSON", () => {
    expect(toolKey("Grep", { pattern: "a", path: "x" })).toBe(toolKey("Grep", { path: "x", pattern: "a" }));
    expect(toolKey("WebFetch", { url: "u", prompt: "p" })).toBe(toolKey("WebFetch", { prompt: "p", url: "u" }));
    expect(toolKey("Glob", { pattern: "*.ts" })).not.toBe(toolKey("Glob", { pattern: "*.js" }));
  });
  it("Bash via object input behaves as before and denial reason names the tool", () => {
    expect(loopDenyReason(false, "Read", 5)).toMatch(/called Read with the same input 5 times/);
    const rs = run(Array.from({ length: 7 }, () => ["Bash", { command: "ls" }] as [string, Record<string, unknown>]));
    expect(rs.map((r) => r.deny)).toEqual([false, false, false, false, true, true, true]);
    expect(rs[6].stop).toBe(true);
  });
});

describe("worker-guard hook", () => {
  const hook = "src/hooks/ts/pre-tool-use/worker-guard.ts";
  const call = (dir: string, env: Record<string, string>) =>
    spawnSync("npx", ["tsx", hook], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: dir }),
      env: { ...process.env, PAI_WORKER_LOOP_DIR: dir, PAI_WORKER_ID: "w-loop", ...env },
      encoding: "utf8",
    }).stdout;
  it("worker: stops the session at the 7th Read and records the event; interactive is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopguard-hook-"));
    try {
      const outs = Array.from({ length: 7 }, () => call(dir, { PAI_WORKER: "1" }));
      expect(outs[3]).not.toContain("deny");
      expect(outs[4]).toContain("deny");
      expect(outs[4]).not.toContain('"continue"');
      const stop = JSON.parse(outs[6]);
      expect(stop.continue).toBe(false);
      expect(stop.stopReason).toMatch(/loop guard: Read .* repeated 7 times without a change; stopping so the orchestrator can decide/);
      expect(readToolErrors(dir).some((r) => /loop guard: Read/.test(r.raw ?? ""))).toBe(true);
      const dir2 = mkdtempSync(join(tmpdir(), "loopguard-hook-"));
      const inter = Array.from({ length: 8 }, () => call(dir2, { PAI_WORKER: "" }));
      expect(inter.every((o) => !o.includes("deny"))).toBe(true);
      rmSync(dir2, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("loop guard: overlapping Read ranges", () => {
  const rd = (offset: number, limit: number, file = "src/cli/commands/audit.ts") => ["Read", { file_path: file, offset, limit }] as const;
  const run = (calls: ReadonlyArray<readonly [string, Record<string, unknown>]>) => {
    let s: LoopState = emptyLoopState();
    return calls.map(([t, i]) => {
      const r = stepLoopGuard(s, t, i);
      s = r.state;
      return r;
    });
  };
  it("creeping offset 448..471 limit 115: denied at the 5th, stopped at the 7th", () => {
    const res = run(Array.from({ length: 10 }, (_, i) => rd(448 + i, 115)));
    expect(res.map((r) => r.deny)).toEqual([false, false, false, false, true, true, true, true, true, true]);
    expect(res.findIndex((r) => r.stop)).toBe(6);
  });
  it("paging 1-200, 201-400, 401-600 is allowed", () => {
    expect(run([rd(1, 200), rd(201, 200), rd(401, 200)]).some((r) => r.deny)).toBe(false);
  });
  it("a full-file read covers narrower ranges", () => {
    const res = run([["Read", { file_path: "a.ts" }], rd(10, 50, "a.ts"), rd(20, 50, "a.ts"), rd(30, 50, "a.ts"), rd(40, 50, "a.ts")]);
    expect(res[4].deny).toBe(true);
  });
  it("an Edit resets", () => {
    const calls = [...Array.from({ length: 4 }, (_, i) => rd(448 + i, 115)), ["Edit", {}] as const, rd(452, 115)];
    expect(run(calls).some((r) => r.deny)).toBe(false);
  });
});
