import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { actionKey, emptyLoopState, loopDenyReason, stepLoopGuard, loopKey, toolKey, recordLoopResult, worktreeFingerprint, LOOP_STOP_DENIALS, type LoopState } from "./loop-guard.js";
import { classifyToolError, readToolErrors, recordToolError } from "../../../workers/tool-errors.js";

/** Feeds calls in order; returns the index of each denied call. */
function feed(calls: Array<[string, string?]>, out: (i: number) => string = () => "same output"): number[] {
  let s: LoopState = emptyLoopState();
  const denied: number[] = [];
  calls.forEach(([tool, cmd], i) => {
    const r = stepLoopGuard(s, tool, cmd);
    s = r.state;
    if (r.deny) denied.push(i);
    else s = recordLoopResult(s, tool, cmd, out(i));
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
    expect(feed([bash(t), bash("git commit -m x"), bash(t), bash(t), bash(t), bash(t)])).toEqual([3, 4, 5]);
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
    expect(feed(calls, (i) => `block ${i} text`)).toEqual([]);
  });
  it("does not collapse digits outside /tmp paths", () => {
    expect(feed(Array.from({ length: 8 }, (_, i) => bash(`echo ${i}`)), (i) => String(i))).toEqual([]);
  });
  it("an edit resets the window", () => {
    const c = bash("npm test");
    expect(feed([c, c, edit, c, c, edit, c, c])).toEqual([]);
  });
});

describe("similarity of commands", () => {
  const variants = [
    "npx vitest run src/cli/defs/launch.test.ts --config vitest.config.ts 2>&1",
    'npx vitest run "src/cli/defs/launch.test.ts" 2>&1',
    "npx vitest run src/cli/defs/launch.test.ts --run 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts --fileParallelism 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts --no-isolate 2>&1",
    "npx vitest run src/cli/defs/launch.test.ts 2>&1",
    "npx vitest run --dir src/cli/defs src/cli/defs/launch.test.ts 2>&1",
  ];
  it("the vitest flag variants share one action key; the 3rd run is denied", () => {
    expect(feed(variants.map(bash))).toEqual([3, 4, 5]);
  });
  it("a different target with a different result is progress", () => {
    expect(feed(Array.from({ length: 8 }, (_, i) => bash(`npx vitest run src/f${i}.test.ts`)), (i) => `pass file ${i}`)).toEqual([]);
    expect(feed(["a", "b", "c", "d", "e", "f"].map((n) => bash(`npx vitest run src/${n}.test.ts`)))).toEqual([]);
  });
  it("two genuinely different commands are not merged", () => {
    const calls: Array<[string, string]> = [];
    for (let i = 0; i < 4; i++) calls.push(bash("git status"), bash("git log"));
    expect(feed(calls)).toEqual([]);
    expect(loopKey("git status")).not.toBe(loopKey("git log"));
    expect(feed(Array.from({ length: 6 }, () => bash("git status")).concat(Array.from({ length: 3 }, () => bash("git log"))))).toEqual([4, 5]);
  });
  it("an edit resets the count", () => {
    const v = variants.map(bash);
    expect(feed([...v.slice(0, 2), edit, ...v.slice(2, 4), edit, ...v.slice(4, 6)])).toEqual([]);
  });
  it("a real edit-test cycle stays allowed", () => {
    const calls: Array<[string, string?]> = [];
    for (let i = 0; i < 6; i++) calls.push(bash("npx vitest run src/a.test.ts"), bash("npx vitest run src/a.test.ts"), edit);
    expect(feed(calls)).toEqual([]);
  });
  it("polling with a changing result is progress", () => {
    const calls = Array.from({ length: 12 }, () => bash("tail -20 build.log"));
    expect(feed(calls, (i) => `building step ${i} of twelve`.repeat(1) + ` line${i}`)).toEqual([]);
  });
  it("a retry whose result finally changes is allowed", () => {
    const calls = Array.from({ length: 6 }, () => bash("curl -s localhost:8080/health"));
    expect(feed(calls, (i) => (i < 3 ? "connection refused" : "ok healthy"))).toEqual([]);
  });
  it("waiting verbs and bounded sleeps are exempt", () => {
    expect(feed(Array.from({ length: 10 }, () => bash("pai worker wait abc --max 100")))).toEqual([]);
    expect(feed(Array.from({ length: 10 }, () => bash("sleep 30; cat out.log")))).toEqual([]);
    expect(feed(Array.from({ length: 6 }, () => bash("sleep 300")))).toEqual([4, 5]);
  });
  it("normalises numbers, quotes and spacing", () => {
    expect(loopKey("echo   hi  ")).toBe(loopKey('echo "hi"'));
    expect(loopKey("sed -n 1,40p a.ts")).toBe(loopKey("sed -n 41,80p a.ts"));
    expect(loopKey("git commit -m x")).not.toBe(loopKey("git commit -m y"));
  });
  it("deny message", () => {
    expect(loopDenyReason()).toMatch(/same result/);
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
    const rs = run(Array.from({ length: 20 }, (_, i) => ["Read", { file_path: "src/cli/registry.ts", offset: i * 100, limit: 50 }] as [string, Record<string, unknown>]));
    expect(rs.some((r) => r.deny)).toBe(false);
  });
  it("Grep key ignores unrelated fields order; other tools use stable JSON", () => {
    expect(toolKey("Grep", { pattern: "a", path: "x" })).toBe(toolKey("Grep", { path: "x", pattern: "a" }));
    expect(toolKey("WebFetch", { url: "u", prompt: "p" })).toBe(toolKey("WebFetch", { prompt: "p", url: "u" }));
    expect(toolKey("Glob", { pattern: "*.ts" })).not.toBe(toolKey("Glob", { pattern: "*.js" }));
  });
  it("Bash via object input behaves as before and denial reason names the tool", () => {
    expect(loopDenyReason("Read", 5)).toMatch(/called Read with similar input 5 times/);
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

describe("worker-guard hook: hard stop signals the worker", () => {
  it("at the 7th identical call the hook writes the loop-stop marker and SIGTERMs the claude pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopguard-kill-"));
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const exited = new Promise<string | null>((res) => victim.on("exit", (_c, sig) => res(sig)));
      for (let i = 0; i < 7; i++)
        spawnSync("npx", ["tsx", "src/hooks/ts/pre-tool-use/worker-guard.ts"], {
          input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: dir }),
          env: { ...process.env, PAI_WORKER_LOOP_DIR: dir, PAI_WORKER_ID: "w-kill", PAI_WORKER: "1", PAI_LOOP_STOP_PID: String(victim.pid) },
          encoding: "utf8",
        });
      expect(await exited).toBe("SIGTERM");
      expect(existsSync(join(dir, "w-kill.loop-stop"))).toBe(true);
    } finally {
      victim.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
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

describe("temp-path and repeated-result evasions", () => {
  const names = ["km", "kn", "ko", "kp", "kq", "kr", "ks"];
  const probe = (n: string) =>
    `timeout 110 bun src/cli/index.ts daemon keepalive > /tmp/${n}.out 2> /tmp/${n}.err; echo "rc=$?"; cat /tmp/${n}.err`;
  it("temp file names do not change the key", () => {
    expect(loopKey(probe("km"))).toBe(loopKey(probe("kw")));
    expect(loopKey("cat $TMPDIR/a.txt")).toBe(loopKey("cat ${TMPDIR}/b/c.txt"));
    expect(loopKey("cat /private/tmp/x1")).toBe(loopKey("cat /tmp/y"));
  });
  it("km..kw: denied at the 5th, stopped at the 7th", () => {
    let s: LoopState = emptyLoopState();
    const out: Array<[boolean, boolean | undefined]> = [];
    for (const n of names) {
      const r = stepLoopGuard(s, "Bash", probe(n));
      s = r.state;
      out.push([r.deny, r.stop]);
    }
    expect(out.map((o) => o[0])).toEqual([false, false, false, false, true, true, true]);
    expect(out.map((o) => !!o[1])).toEqual([false, false, false, false, false, false, true]);
    expect(LOOP_STOP_DENIALS).toBe(3);
  });
  it("similar commands with the same result 4 times: denied, then stopped", () => {
    let s: LoopState = emptyLoopState();
    const seen: Array<[boolean, boolean | undefined]> = [];
    const base = "grep -c foo src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts src/h.ts src/i.ts";
    for (let i = 0; i < 7; i++) {
      const cmd = `${base} --x${"y".repeat(i)}`;
      const r = stepLoopGuard(s, "Bash", cmd);
      s = r.state;
      seen.push([r.deny, r.stop]);
      if (!r.deny) s = recordLoopResult(s, "Bash", cmd, { stdout: "0 matches\n", stderr: "" });
    }
    expect(seen.map((x) => x[0])).toEqual([false, false, false, false, true, true, true]);
    expect(seen[6][1]).toBe(true);
  });
  it("differing results or an edit reset the result count", () => {
    let s: LoopState = emptyLoopState();
    for (let i = 0; i < 10; i++) {
      const cmd = `grep -c foo src/a${i}.ts src/b.ts`;
      const r = stepLoopGuard(s, "Bash", cmd);
      expect(r.deny).toBe(false);
      s = recordLoopResult(r.state, "Bash", cmd, `result ${i}${"y".repeat(i)}`);
    }
    for (let i = 0; i < 4; i++) s = recordLoopResult(stepLoopGuard(s, "Bash", "ls src/a").state, "Bash", "ls src/a", "same");
    expect(stepLoopGuard(s, "Bash", "ls src/a").deny).toBe(true);
    s = stepLoopGuard(s, "Edit").state;
    expect(stepLoopGuard(s, "Bash", "ls src/a").deny).toBe(false);
  });
  it("paging with identical digits-only differences is not blocked by distinct content", () => {
    let s: LoopState = emptyLoopState();
    for (let i = 0; i < 8; i++) {
      const cmd = `sed -n ${i * 40 + 1},${i * 40 + 40}p f.ts`;
      const r = stepLoopGuard(s, "Bash", cmd);
      expect(r.deny).toBe(false);
      s = recordLoopResult(r.state, "Bash", cmd, `line block ${String.fromCharCode(97 + i)} content`);
    }
  });
});

describe("no-progress rule (action key)", () => {
  const run1 = "nohup npx vitest run src/workers/capacity.test.ts > /tmp/vt-cap.log 2>&1 & echo $! > /tmp/vt-cap.pid";
  const run2 = "nohup npx vitest run src/workers/capacity.test.ts > /tmp/vt-cap2.log 2>&1 & echo $! > /tmp/vt-cap2.pid; pai worker wait-on $(cat /tmp/vt-cap2.pid) --log /tmp/vt-cap2.log";
  const run3 = "nohup npx vitest run src/workers/capacity.test.ts --reporter=dot --testTimeout=20000 > /tmp/vt-cap3.log 2>&1 & echo $! > /tmp/vt-cap3.pid";
  const noise: Array<[string, string?]> = [bash("ps aux | grep vitest"), bash("sleep 30"), bash("pgrep -f vitest"), ["Read", undefined], bash("kill 4242"), bash("wc -l /tmp/vt-cap.log")];
  it("normalises the incident commands to one key", () => {
    expect(actionKey(run1)).toBe("vitest src/workers/capacity.test.ts");
    expect(actionKey(run2)).toBe(actionKey(run1));
    expect(actionKey(run3)).toBe(actionKey(run1));
    expect(actionKey("ps aux | grep vitest")).toBeNull();
    expect(actionKey("timeout 120 npm test")).toBe("npm test");
    expect(actionKey("CI=1 npx tsc --noEmit")).toBe("tsc");
  });
  it("denies the third run of the incident sequence", () => {
    const calls: Array<[string, string?]> = [bash(run1), noise[0], noise[1], bash(run2), noise[2], noise[4], noise[5], bash(run3)];
    expect(feed(calls, (i) => `result ${i} pid ${1000 + i}`)).toEqual([7]);
  });
  it("stops at the fifth run", () => {
    let s: LoopState = emptyLoopState();
    const stops: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = stepLoopGuard(s, "Bash", `npx vitest run src/a.test.ts > /tmp/o${i}.log`);
      s = r.state;
      stops.push(!!r.stop);
    }
    expect(stops).toEqual([false, false, false, false, true]);
  });
  it("an edit resets and different targets are different keys", () => {
    expect(feed([bash(run1), bash(run2), edit, bash(run3), bash(run1)])).toEqual([]);
    const calls = ["a", "b", "c", "a", "b", "c"].map((n) => bash(`npx vitest run src/${n}.test.ts`));
    expect(feed(calls, (i) => `r${i}`)).toEqual([]);
  });
  it("a worktree change between runs resets the count; no change still denies at 3", () => {
    const cmd = "npx tsc --noEmit";
    const run = (prints: Array<string | null>) => {
      let s: LoopState = emptyLoopState();
      return prints.map((fp, i) => {
        const r = stepLoopGuard(s, "Bash", cmd, fp);
        s = recordLoopResult(r.state, "Bash", cmd, `result ${i}`);
        return r.deny;
      });
    };
    expect(run(["a", "b", "c", "d", "e", "f"])).toEqual([false, false, false, false, false, false]);
    expect(run(["a", "a", "a", "a"])).toEqual([false, false, true, true]);
    expect(run(["a", "a", "b", "b", "b"])).toEqual([false, false, false, false, true]);
    expect(run([null, null, null])).toEqual([false, false, true]);
  });
  it("worktreeFingerprint sees Bash edits, even to an already modified file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-"));
    try {
      const g = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      g("init", "-q");
      writeFileSync(join(dir, "a.ts"), "one");
      const f0 = worktreeFingerprint(dir);
      expect(f0).toBe(worktreeFingerprint(dir));
      spawnSync("sh", ["-c", "printf two-two > a.ts"], { cwd: dir });
      const f1 = worktreeFingerprint(dir);
      expect(f1).not.toBe(f0);
      spawnSync("sh", ["-c", "printf three > a.ts"], { cwd: dir });
      expect(worktreeFingerprint(dir)).not.toBe(f1);
      expect(worktreeFingerprint(tmpdir())).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("waits stay exempt", () => {
    expect(feed(Array.from({ length: 8 }, () => bash("pai worker wait-on 123 --log /tmp/x.log")))).toEqual([]);
  });
});
