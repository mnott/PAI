import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { buildGateReason, loadBuildsConfig } from "./build-gate.js";
import { actionKey, bashWriteTargets, isPollCommand, emptyLoopState, loopDenyReason, loopGuardEvasion, stepLoopGuard, loopKey, toolKey, callKey, recordLoopResult, recordLoopFailure, LOOP_NUDGE, LOOP_MAX_REPEATS, worktreeFingerprint, maskSecrets, WAIT_CAP_MS, LOOP_STOP_DENIALS, IDENTICAL_WRITE_STOP_AT, REVERT_STOP_AT, type LoopState } from "./loop-guard.js";
import { classifyToolError, readToolErrors, recordToolError } from "../../../workers/tool-errors.js";
import { fakeUrl, fake, fakeAnthropic, fakeAwsKey, fakeGithub } from "../../../utils/fake-secret.js";

// Fake token-shaped fixtures assembled at runtime so no scanner flags a literal.
const AKIA_REST = "IOSFODNN7EXAMPLE";
const GH_BODY = "abcdefghijklmnopqrstuvwxyz0123456789";
const BODY = "abcdefghijklmnopqrstuvwx";

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
    const calls = Array.from({ length: 14 }, (_, i) => bash(`sed -n ${i * 40 + 1},${i * 40 + 40}p f.ts`));
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
  it("a sleep inside a longer command is not a wait (live miss: rm; door x2; sleep 5; cat)", () => {
    const c = "rm -f /tmp/cl-build/mac-1.seen; MYAPP_TREES=/tmp/t2 MYAPP_BUILD_STUB=8 sh /tmp/cl-stub3/tools/build.sh mac 2>/dev/null; echo A-rc=$?; sleep 5; echo ---A---; cat /tmp/cl-build/mac-1.log";
    const out = "A-rc=0\n---A---\nBUILD FAILED 0s (the job ended without a result; see /tmp/cl-build/mac-1.full.log)";
    const denied = feed(Array.from({ length: 12 }, () => bash(c)), () => out);
    expect(denied[0]).toBeLessThanOrEqual(4);
    expect(denied.length).toBe(12 - denied[0]);
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
  it("identical Writes share one key; different content is a different key", () => {
    const a = callKey("Write", { file_path: "/x/a.py", content: "same" });
    expect(a).toBe(callKey("Write", { file_path: "/x/a.py", content: "same" }));
    expect(a).not.toBe(callKey("Write", { file_path: "/x/a.py", content: "other" }));
    expect(a).not.toBe(callKey("Write", { file_path: "/x/b.py", content: "same" }));
  });
  const W = { file_path: "/tmp/verify_all.py", content: "print(1)\n" };
  /** Steps `calls` through the guard, recording each allowed one; returns every step. */
  function writes(calls: Array<[string, Record<string, unknown>]>) {
    let s: LoopState = emptyLoopState();
    return calls.map(([tool, input]) => {
      const r = stepLoopGuard(s, tool, input, "fp");
      s = r.state;
      if (!r.deny) s = recordLoopResult(s, tool, input, "ok");
      return r;
    });
  }
  it("identical Write x 10: all allowed, told plainly from the 2nd on", () => {
    const rs = writes(Array.from({ length: 10 }, () => ["Write", W] as [string, Record<string, unknown>]));
    expect(rs.every((r) => !r.deny)).toBe(true);
    expect(rs[0].note).toBeUndefined();
    for (const r of rs.slice(1)) {
      expect(r.note).toContain("already contains exactly this content");
      expect(r.note).toContain(W.file_path);
      expect(r.note).not.toMatch(/commit|R report/);
    }
  });
  it("identical Write x 20 with a Read of the file in between: stopped at the 20th", () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    for (let i = 0; i < 20; i++) calls.push(["Write", W], ["Read", { file_path: W.file_path }]);
    const rs = writes(calls).filter((_, i) => i % 2 === 0);
    expect(rs.findIndex((r) => r.deny)).toBe(IDENTICAL_WRITE_STOP_AT - 1);
    expect(rs[IDENTICAL_WRITE_STOP_AT - 1].stop).toBe(true);
    expect(rs.slice(0, IDENTICAL_WRITE_STOP_AT - 1).every((r) => !r.deny)).toBe(true);
  });
  it("a Write with changed content resets the identical-write count", () => {
    const other = { ...W, content: "print(2)\n" };
    const calls: Array<[string, Record<string, unknown>]> = [
      ...Array.from({ length: 15 }, () => ["Write", W] as [string, Record<string, unknown>]),
      ["Write", other],
      ...Array.from({ length: 15 }, () => ["Write", W] as [string, Record<string, unknown>]),
    ];
    const rs = writes(calls);
    expect(rs.every((r) => !r.deny)).toBe(true);
    expect(rs[16].note).toBeUndefined();
    expect(rs[17].note).toContain("already contains");
  });
  const ver = (c: string): [string, Record<string, unknown>] => ["Write", { file_path: "/tmp/out/27.py", content: c }];
  it("A,B,A,B,...: note at the 2nd revert, deny+stop at the 6th", () => {
    const rs = writes(Array.from({ length: 10 }, (_, i) => ver(i % 2 ? "B" : "A")));
    expect(rs.slice(0, 3).every((r) => !r.note)).toBe(true);
    expect(rs[3].note).toContain("switching back to a version you already wrote (this is the 2nd time)");
    expect(rs[3].note).toContain("/tmp/out/27.py");
    expect(rs.findIndex((r) => r.deny)).toBe(REVERT_STOP_AT + 1);
    expect(rs[REVERT_STOP_AT + 1].stop).toBe(true);
    expect(rs.slice(0, REVERT_STOP_AT + 1).every((r) => !r.deny)).toBe(true);
  });
  it("A,B,C,D (progress) gives no note", () => {
    const rs = writes(["A", "B", "C", "D"].map(ver));
    expect(rs.every((r) => !r.note && !r.deny)).toBe(true);
  });
  it("A,A keeps the identical-write note, not the revert note", () => {
    const rs = writes([ver("A"), ver("A")]);
    expect(rs[1].note).toContain("already contains exactly this content");
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
    spawnSync("node_modules/.bin/tsx", [hook], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: dir }),
      env: { ...process.env, PAI_CONFIG_FILE: join(dir, "no-config.json"), PAI_WORKER_LOOP_DIR: dir, PAI_WORKER_ID: "w-loop", ...env },
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
  }, 240000);
});

describe("worker-guard hook: hard stop signals the worker", () => {
  it("at the 7th identical call the hook writes the loop-stop marker and SIGTERMs the claude pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loopguard-kill-"));
    const victim = spawn("sleep", ["600"], { stdio: "ignore" });
    try {
      const exited = new Promise<string | null>((res) => victim.on("exit", (_c, sig) => res(sig)));
      for (let i = 0; i < 7; i++)
        spawnSync("node_modules/.bin/tsx", ["src/hooks/ts/pre-tool-use/worker-guard.ts"], {
          input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "src/a.ts" }, cwd: dir }),
          env: { ...process.env, PAI_CONFIG_FILE: join(dir, "no-config.json"), PAI_WORKER_LOOP_DIR: dir, PAI_WORKER_ID: "w-kill", PAI_WORKER: "1", PAI_LOOP_STOP_PID: String(victim.pid) },
          encoding: "utf8",
        });
      expect(await exited).toBe("SIGTERM");
      expect(existsSync(join(dir, "w-kill.loop-stop"))).toBe(true);
    } finally {
      victim.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
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
  it("a touch-nudge does not change the fingerprint; a real edit does; an empty or dot-file nudge does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-nudge-"));
    try {
      const g = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
      g("init", "-q");
      writeFileSync(join(dir, "a.ts"), "one");
      g("add", "-A");
      g("commit", "-q", "-m", "x");
      const f0 = worktreeFingerprint(dir);
      expect(f0).not.toBeNull();
      // the live evasion: touch an untracked dot-file, then repeat the blocked command
      spawnSync("sh", ["-c", "touch .loop-nudge"], { cwd: dir });
      expect(worktreeFingerprint(dir)).toBe(f0);
      // an empty untracked file is no change either
      writeFileSync(join(dir, "empty.txt"), "");
      expect(worktreeFingerprint(dir)).toBe(f0);
      // mtime-only change of a tracked file is no change
      spawnSync("sh", ["-c", "touch a.ts"], { cwd: dir });
      expect(worktreeFingerprint(dir)).toBe(f0);
      // a real edit to a tracked file is a change
      writeFileSync(join(dir, "a.ts"), "two");
      const f1 = worktreeFingerprint(dir);
      expect(f1).not.toBe(f0);
      // a non-empty untracked file that is not ignored and not a dot-file is a change
      writeFileSync(join(dir, "new.ts"), "x");
      expect(worktreeFingerprint(dir)).not.toBe(f1);
      // an ignored file is no change
      writeFileSync(join(dir, ".gitignore"), "*.gen\n");
      const f2 = worktreeFingerprint(dir);
      writeFileSync(join(dir, "x.gen"), "data");
      expect(worktreeFingerprint(dir)).toBe(f2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("touch-nudge + same vitest: still blocked; a real tracked edit: allowed", () => {
    const cmd = "npx vitest run src/a.test.ts";
    const run = (prints: Array<string | null>) => {
      let s: LoopState = emptyLoopState();
      return prints.map((fp, i) => {
        const r = stepLoopGuard(s, "Bash", cmd, fp);
        s = recordLoopResult(r.state, "Bash", cmd, `result ${i}`);
        return r.deny;
      });
    };
    // the nudge produces the same fingerprint as before: the 3rd run is still denied
    expect(run(["a", "a", "a"])).toEqual([false, false, true]);
    // a real edit changes the fingerprint: allowed again
    expect(run(["a", "a", "b", "b", "b"])).toEqual([false, false, false, false, true]);
  });
  it("a touch prefix hiding a repeat is flagged as an evasion", () => {
    expect(loopGuardEvasion("touch .loop-nudge && npx vitest run src/a.test.ts", "npx vitest run src/a.test.ts")).toBe(true);
    expect(loopGuardEvasion(": > .loop-nudge && npx vitest run src/a.test.ts", "npx vitest run src/a.test.ts")).toBe(true);
    expect(loopGuardEvasion("echo > .loop-nudge && npx vitest run src/a.test.ts", "npx vitest run src/a.test.ts")).toBe(true);
    expect(loopGuardEvasion("touch .loop-nudge && npx vitest run src/b.test.ts", "npx vitest run src/a.test.ts")).toBe(false);
    expect(loopGuardEvasion("npx vitest run src/a.test.ts", "npx vitest run src/a.test.ts")).toBe(false);
    expect(loopGuardEvasion("touch .loop-nudge && git status", "npx vitest run src/a.test.ts")).toBe(false);
  });
  it("waits stay exempt", () => {
    expect(feed(Array.from({ length: 8 }, () => bash("pai worker wait-on 123 --log /tmp/x.log")))).toEqual([]);
  });
  it("polling helper returning exit 3 still running is a wait, not a repeat", () => {
    const cmd = "tools/build.sh --wait 100 -only-testing:AppTests/Foo";
    let s: LoopState = emptyLoopState();
    for (let i = 0; i < 12; i++) {
      const r = stepLoopGuard(s, "Bash", cmd, null, 1000 + i * 100_000);
      expect(r.deny).toBe(false);
      s = recordLoopResult(s, "Bash", cmd, "Exit code 3\nstill running, call again", 1000 + i * 100_000);
    }
    // finished: back to normal accounting
    s = recordLoopResult(stepLoopGuard(s, "Bash", cmd).state, "Bash", cmd, "done");
    expect(s.waits).toEqual({});
  });
  it("polling is bounded by the wait cap", () => {
    const cmd = "tools/build.sh --wait 100";
    let s: LoopState = emptyLoopState();
    s = recordLoopResult(stepLoopGuard(s, "Bash", cmd, null, 0).state, "Bash", cmd, { stdout: "still running", exitCode: 3 }, 0);
    const r = stepLoopGuard(s, "Bash", cmd, null, WAIT_CAP_MS + 1);
    expect(r.deny).toBe(true);
    expect(r.reason).toContain("45 minutes");
  });
  it("exit 1 with the same output is still a repeat", () => {
    const cmd = "tools/build.sh --wait 100";
    expect(feed(Array.from({ length: 7 }, () => bash(cmd)), () => "Exit code 1\nstill running? no: build failed")).toEqual([4, 5, 6]);
  });
});

describe("build-door polls are waits", () => {
  const repo = mkdtempSync(join(tmpdir(), "lg-door-"));
  mkdirSync(join(repo, ".pai"), { recursive: true });
  writeFileSync(join(repo, ".pai", "builds.yaml"), "doors: [tools/build.sh]\n");
  const run = (cmd: string, n: number, t0 = 0, step = 0, out = "queue position 2, building") => {
    let s: LoopState = emptyLoopState();
    const denied: number[] = [];
    for (let i = 0; i < n; i++) {
      const now = t0 + i * step;
      const r = stepLoopGuard(s, "Bash", cmd, null, now, repo);
      s = r.state;
      if (r.deny) denied.push(i);
      else s = recordLoopResult(s, "Bash", cmd, out, now);
    }
    return denied;
  };
  const shapes = [
    `cd ${repo} && sh tools/build.sh mac --wait`,
    "sh tools/build.sh test ios -only-testing:X --wait 2>&1 | grep -E 'error|warning'",
    "sh tools/build.sh mac --wait",
    "pai build lock -- true",
  ];
  for (const c of shapes) it(`never denies: ${c}`, () => expect(run(c, 9)).toEqual([]));
  it("a door that returns at once with the same failure is no wait", () =>
    expect(run("sh tools/build.sh mac --wait", 9, 0, 0, "BUILD FAILED 0s (the job ended without a result)")).toEqual([3, 4, 5, 6, 7, 8]));
  it("without --wait it is an ordinary repeat", () => expect(run("sh tools/build.sh mac", 9)).toEqual([4, 5, 6, 7, 8]));
  it("--wait on a non-door is an ordinary repeat", () => expect(run("sh tools/other.sh mac --wait", 9)).toEqual([4, 5, 6, 7, 8]));
  it("the cap still applies after 45 minutes", () => expect(run("sh tools/build.sh mac --wait", 4, 0, WAIT_CAP_MS / 2)).toEqual([2, 3]));
});

describe("build doors match by repo-relative path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lg-door-git-")));
  const repo = join(root, "repo");
  const wt = join(root, "wt", "w1");
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  mkdirSync(join(repo, "tools"), { recursive: true });
  mkdirSync(join(repo, ".pai"), { recursive: true });
  writeFileSync(join(repo, "tools", "build.sh"), "#!/bin/sh\n");
  writeFileSync(join(repo, ".pai", "builds.yaml"), "doors: [tools/build.sh]\n");
  spawnSync("git", ["init", "-q", repo]);
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  git("worktree", "add", "-q", "-b", "w1", wt);
  const forms = (base: string, other: string) => [
    "tools/build.sh mac --wait",
    "./tools/build.sh mac --wait",
    `${base}/tools/build.sh mac --wait`,
    `sh ${base}/tools/build.sh mac --wait`,
    `bash ${other}/tools/build.sh mac --wait`,
    `cd ${base} && ./tools/build.sh mac --wait`,
    `cd ${base} && tools/build.sh mac --wait 2>&1 | tail -5`,
    `FOO=1 zsh ${base}/tools/build.sh mac --wait`,
  ];
  for (const [cwd, other] of [[repo, wt], [wt, repo]] as const)
    for (const c of forms(cwd, other)) it(`poll from ${cwd === repo ? "main" : "worktree"}: ${c.replaceAll(root, "")}`, () => expect(isPollCommand(c, cwd)).toBe(true));
  it("a non-door script in the worktree is no poll", () => expect(isPollCommand(`${wt}/tools/other.sh --wait`, wt)).toBe(false));
  it("the build gate allows the door by absolute path in a worktree", () => {
    expect(buildGateReason(`${wt}/tools/build.sh mac`, repo, loadBuildsConfig(repo))).toBeNull();
    expect(buildGateReason(`cd ${wt} && sh ./tools/build.sh mac`, repo, loadBuildsConfig(repo))).toBeNull();
    expect(buildGateReason(`${wt}/tools/other.sh && swift build`, repo, loadBuildsConfig(repo))).not.toBeNull();
  });
});

describe("piecewise read loop", () => {
  const run = (cmds: string[], fp: (i: number) => string = () => "fp") => {
    let s: LoopState = emptyLoopState();
    const out: Array<{ deny: boolean; stop?: boolean; reason?: string }> = [];
    cmds.forEach((c, i) => {
      const r = stepLoopGuard(s, "Bash", c, fp(i));
      s = r.state;
      out.push({ deny: r.deny, stop: r.stop, reason: r.reason });
      if (!r.deny) s = recordLoopResult(s, "Bash", c, `line ${i} text ${i * 7}`);
    });
    return out;
  };
  const piece = (i: number, f = "Notes/a.md") => `head -40 ${f} | sed -n '${i},${i}p'; echo ===; sed -n '${i - 1},${i - 1}p' ${f}`;
  it("denies the 16th line-by-line read, then stops after 2 more denials", () => {
    const r = run(Array.from({ length: 19 }, (_, i) => piece(i + 2)));
    expect(r.slice(0, 15).some((x) => x.deny)).toBe(false);
    expect(r[15].deny).toBe(true);
    expect(r[15].reason).toContain("Notes/a.md piece by piece (15 calls, no edits)");
    expect(r[15].stop).toBe(false);
    expect(r[16].stop).toBe(false);
    expect(r[17].stop).toBe(true);
  });
  it("does not trigger when the worktree changes in between", () => {
    const r = run(Array.from({ length: 40 }, (_, i) => piece(i + 2)), (i) => `fp${Math.floor(i / 10)}`);
    expect(r.some((x) => x.deny)).toBe(false);
  });
  it("does not trigger when edits alternate", () => {
    let s: LoopState = emptyLoopState();
    for (let i = 0; i < 40; i++) {
      const r = stepLoopGuard(s, "Bash", piece(i + 2), "fp");
      expect(r.deny).toBe(false);
      s = stepLoopGuard(r.state, "Edit").state;
    }
  });
  it("does not trigger for different files", () => {
    const r = run(Array.from({ length: 40 }, (_, i) => piece(i + 2, `Notes/f${i}.md`)));
    expect(r.some((x) => x.deny)).toBe(false);
  });
  it("does not trigger for non-read commands", () => {
    const r = run(Array.from({ length: 30 }, (_, i) => `sed -i '${i}d' Notes/a.md`));
    expect(r.some((x) => x.deny)).toBe(false);
  });
});

describe("loop guard: a denied repeat gets its last output back", () => {
  const run = (cmd: string, out: string, tool = "Bash", cfg?: { echoLines: number; echoChars: number }, n = 4) => {
    let s = emptyLoopState();
    const input = tool === "Bash" ? cmd : { pattern: cmd };
    for (let i = 0; i < n; i++) s = recordLoopResult(stepLoopGuard(s, tool, input).state, tool, input, out);
    return stepLoopGuard(s, tool, input, null, Date.now(), undefined, cfg);
  };
  it("a repeated grep is denied with its previous output", () => {
    const r = run("grep -n foo src/a.ts", "12:foo one\n40:foo two");
    expect(r.deny).toBe(true);
    expect(r.reason).toContain("you ran this command 4 times");
    expect(r.reason).toContain("Its last output was:\n12:foo one\n40:foo two\nUse this output; do not run it again.");
  });
  it("Grep and Glob tool repeats echo too", () => {
    expect(run("foo", "a.ts:1:foo", "Grep").reason).toContain("Its last output was:\na.ts:1:foo");
    expect(run("**/*.ts", "a.ts\nb.ts", "Glob").reason).toContain("Its last output was:\na.ts\nb.ts");
  });
  it("the echo is trimmed to the configured lines and chars", () => {
    const out = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const dflt = run("grep -n x src/a.ts", out).reason as string;
    expect(dflt).toContain("line39");
    expect(dflt).not.toContain("line40");
    const small = run("grep -n x src/a.ts", out, "Bash", { echoLines: 2, echoChars: 3000 }).reason as string;
    expect(small).toContain("line1\n[...trimmed]");
    expect(small).not.toContain("line2");
    const chars = run("grep -n x src/a.ts", out, "Bash", { echoLines: 40, echoChars: 12 }).reason as string;
    expect(chars).toContain("line0\nline1\n\n[...trimmed]");
    expect(chars).not.toContain("line2");
  });
  it("a non-read command's denial has no echo", () => {
    const r = run("ls > /tmp/x.txt && echo built", "built");
    expect(r.deny).toBe(true);
    expect(r.reason).toBeUndefined();
  });
  it("secret-looking lines are masked", () => {
    const r = run("cat src/.env.ts", "PORT=1\nAPI_KEY=abc123\npassword: hunter2\nok");
    expect(r.reason).toContain("PORT=1");
    expect(r.reason).toContain("ok");
    expect(r.reason).not.toContain("abc123");
    expect(r.reason).not.toContain("hunter2");
    expect(r.reason).toContain("API_KEY=[REDACTED]");
    expect(r.reason).toContain("password: [REDACTED]");
  });
  it("stores nothing for a non-read call and bounds the kept results", () => {
    let s = emptyLoopState();
    s = recordLoopResult(stepLoopGuard(s, "Bash", "npm run lint").state, "Bash", "npm run lint", "x");
    expect(s.last).toBeUndefined();
    for (let i = 0; i < 20; i++) s = recordLoopResult(stepLoopGuard(s, "Read", { file_path: `f${i}.ts` }).state, "Read", { file_path: `f${i}.ts` }, "y".repeat(20000));
    expect(Object.keys(s.last ?? {}).length).toBeLessThanOrEqual(8);
    expect(Object.values(s.last ?? {}).every((v) => v.length <= 8000)).toBe(true);
  });
});

describe("loop guard: a denied runner re-run gets the end of its last output", () => {
  const cmd = "npx vitest run src/router/sessions.test.ts";
  const out = [...Array.from({ length: 100 }, (_, i) => `line${i}`), "FAIL sessions", "API_KEY=abc123", "Tests 1 failed"].join("\n");
  const run = (cfg?: { echoLines: number; echoChars: number; echoRunnerLines?: number }) => {
    let s = emptyLoopState();
    for (let i = 0; i < 2; i++) s = recordLoopResult(stepLoopGuard(s, "Bash", cmd, "fp").state, "Bash", cmd, out);
    return stepLoopGuard(s, "Bash", cmd, "fp", Date.now(), undefined, cfg);
  };
  it("the third identical run is denied with the tail, not the head", () => {
    const r = run();
    expect(r.deny).toBe(true);
    expect(r.reason).toContain("Its last output ended with:");
    expect(r.reason).toContain("Tests 1 failed");
    expect(r.reason).toContain("FAIL sessions");
    expect(r.reason).not.toContain("line0\n");
    expect(r.reason).toContain("Read the failure above and change code or the test before running it again.");
  });
  it("trims to echoRunnerLines and echoChars", () => {
    const two = run({ echoLines: 40, echoChars: 3000, echoRunnerLines: 2 }).reason as string;
    expect(two).toContain("Tests 1 failed");
    expect(two).not.toContain("FAIL sessions");
    const chars = run({ echoLines: 40, echoChars: 10, echoRunnerLines: 40 }).reason as string;
    expect(chars).toContain("s 1 failed");
    expect(chars).not.toContain("line99");
  });
  it("masks secret-looking lines", () => {
    const r = run().reason as string;
    expect(r).not.toContain("abc123");
    expect(r).toContain("API_KEY=[REDACTED]");
  });
});

describe("maskSecrets", () => {
  const cases: Array<[string, string]> = [
    ["DATABASE_URL=" + fakeUrl("postgres", "u", "hunter2", "db/x"), "DATABASE_URL=postgres://u:[REDACTED]@db/x"],
    ["see " + fakeUrl("https", "user", "hunter2", "example.com/repo.git"), "see https://user:[REDACTED]@example.com/repo.git"],
    [`AWS_ACCESS_KEY_ID=${fakeAwsKey("AKIA", AKIA_REST)}`, "AWS_ACCESS_KEY_ID=[REDACTED]"],
    [`found ${fakeAwsKey("AKIA", AKIA_REST)} in env`, "found [REDACTED] in env"],
    [`aws_secret_access_key = ${fake("wJalrXUtnFEMI", "/K7MDENG", "/bPxRfiCYEXAMPLEKEY")}`, "aws_secret_access_key = [REDACTED]"],
    [`origin ${fakeGithub("p", GH_BODY)}`, "origin [REDACTED]"],
    [`key ${fakeAnthropic(BODY, "-api03")}`, "key [REDACTED]"],
    [`key ${fake("sk", "-", BODY)}`, "key [REDACTED]"],
    ["GITHUB_TOKEN=abc123", "GITHUB_TOKEN=[REDACTED]"],
    ["APP_SECRET=abc123", "APP_SECRET=[REDACTED]"],
    ["DB_PASSWORD=abc123", "DB_PASSWORD=[REDACTED]"],
  ];
  for (const [line, expected] of cases) {
    it(`masks: ${line.slice(0, 30)}`, () => {
      const out = maskSecrets(`before\n${line}\nafter`);
      expect(out).toBe(`before\n${expected}\nafter`);
    });
  }
  it("keeps ordinary lines, including urls without credentials", () => {
    const t = "see https://example.com/a:b@c\nssh://git@host/repo.git\nplain text";
    expect(maskSecrets(t)).toBe(t);
  });
});

describe("worktreeFingerprint on large untracked files", () => {
  it("completes quickly and still changes when a large file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-big-"));
    try {
      spawnSync("git", ["-C", dir, "init", "-q"]);
      const big = join(dir, "big.bin");
      writeFileSync(big, Buffer.alloc(30 * 1024 * 1024, 1));
      const t0 = Date.now();
      const f0 = worktreeFingerprint(dir);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(f0).not.toBeNull();
      expect(worktreeFingerprint(dir)).toBe(f0);
      appendFileSync(big, "x");
      expect(worktreeFingerprint(dir)).not.toBe(f0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loop guard: every tool, errors, and the report nudge", () => {
  const ERR = "InputValidationError: Grep failed: `-n` type is expected as `boolean` but provided as `string`";
  const bad = (pattern = "x") => ({ pattern, "-n": "true" });
  it("Grep failures that never reach PreToolUse are counted and denied at the 4th repeat", () => {
    let s: LoopState = emptyLoopState();
    const steps = [];
    for (let i = 0; i < 5; i++) {
      const r = recordLoopFailure(s, "Grep", bad(), ERR);
      s = r.state;
      steps.push(r);
    }
    expect(steps.map((r) => r.deny)).toEqual([false, false, false, false, true]);
    expect(steps[4].reason).toMatch(/^Stop\. Write your R report now/);
  });
  it("a different input resets the count", () => {
    let s: LoopState = emptyLoopState();
    for (let i = 0; i < 3; i++) s = recordLoopFailure(s, "Grep", bad("a"), ERR).state;
    for (let i = 0; i < 3; i++) s = recordLoopFailure(s, "Grep", bad("zzzz other"), ERR).state;
    expect(recordLoopFailure(s, "Grep", bad("a"), ERR).deny).toBe(false);
  });
  it("a failure Pre already saw is not counted twice", () => {
    let s: LoopState = emptyLoopState();
    s = stepLoopGuard(s, "Grep", bad()).state;
    s = recordLoopFailure(s, "Grep", bad(), ERR).state;
    expect(s.window.length).toBe(1);
    expect(s.outs?.[0]).toContain("InputValidationError");
  });
  it("the 2nd repeat is an advisory note, the 5th call a block led by the report order", () => {
    let s: LoopState = emptyLoopState();
    const rs = [];
    for (let i = 0; i < 5; i++) {
      const r = stepLoopGuard(s, "Bash", { command: "git status --short" }.command);
      s = recordLoopResult(r.state, "Bash", "git status --short", "same");
      rs.push(r);
    }
    expect(rs.map((r) => r.note)).toEqual([undefined, undefined, LOOP_NUDGE, LOOP_NUDGE, undefined]);
    expect(rs[2].deny).toBe(false);
    expect(rs[4].deny).toBe(true);
    expect(loopDenyReason()).toMatch(/^Stop\. Write your R report now \(r=~ if something is unverified, list it in x=\)\./);
  });
});

describe("bashWriteTargets", () => {
  it("returns the files of a Bash call that only writes", () => {
    expect(bashWriteTargets("cat > a.mjs <<'EOF'\nconsole.log(1)\nEOF")).toEqual(["a.mjs"]);
    expect(bashWriteTargets("mkdir -p out && cat >> out/b.txt <<EOF\nx\nEOF")).toEqual(["out/b.txt"]);
    expect(bashWriteTargets("echo hi | tee c.txt")).toEqual(["c.txt"]);
    expect(bashWriteTargets("printf x > d.txt")).toEqual(["d.txt"]);
  });
  it("is null when the call also runs something or writes nothing", () => {
    expect(bashWriteTargets("cat > a.mjs <<'EOF'\nx\nEOF\nnode a.mjs")).toBeNull();
    expect(bashWriteTargets("node a.mjs > out.txt")).toBeNull();
    expect(bashWriteTargets("ls -la")).toBeNull();
    expect(bashWriteTargets("cat a.txt 2>&1 >/dev/null")).toBeNull();
  });
});

describe("worker-guard hook: stop wording of the pattern", () => {
  it("missing-path-streak stop shows the pattern's own message, not the generic repeat text", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopguard-missing-"));
    try {
      const outs = Array.from({ length: 12 }, (_, i) =>
        spawnSync("node_modules/.bin/tsx", ["src/hooks/ts/pre-tool-use/worker-guard.ts"], {
          input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(dir, `no/such/${i}.py`) }, cwd: dir }),
          env: { ...process.env, PAI_CONFIG_FILE: join(dir, "no-config.json"), PAI_WORKER_LOOP_DIR: dir, PAI_WORKER_ID: "w-miss", PAI_WORKER: "1" },
          encoding: "utf8",
        }).stdout,
      );
      const stopped = outs.map((o) => (o.trim() ? JSON.parse(o) : {})).find((j) => j.continue === false);
      expect(stopped).toBeDefined();
      expect(stopped.stopReason).toContain("Reads in a row hit paths that do not exist; stop guessing paths");
      expect(stopped.stopReason).not.toContain("repeated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
});
