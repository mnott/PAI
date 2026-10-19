import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diagnose, HANG_MARKER, isTestCommand, runProbed, timeoutSecs, userFrames, wrapTestCommand } from "./hang-probe.js";
import { emptyLoopState, recordLoopResult, stepLoopGuard } from "../hooks/ts/lib/loop-guard.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hang-probe-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway vitest project that uses the repo's vitest. */
function fixture(name: string, test: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), '{"name":"fx","type":"module"}\n');
  writeFileSync(join(dir, "case.test.ts"), test);
  return dir;
}

async function probe(dir: string, command: string, idleSecs = 4) {
  let text = "";
  const code = await runProbed({ command, cwd: dir, reportDir: join(dir, "reports"), idleSecs, out: (s) => (text += s), err: (s) => (text += s) });
  return { code, text };
}

describe("command recognition", () => {
  it("finds test runners inside timeout, cd and && chains", () => {
    for (const c of [
      "npx vitest run src/a.test.ts",
      "timeout 120 npx vitest run src/a.test.ts",
      "cd app && timeout 300 npm test",
      "FOO=1 npx jest --ci && echo ok",
      "node --test test/",
      "npm run test -- --reporter=dot",
    ])
      expect(isTestCommand(c), c).toBe(true);
    for (const c of ["ls", "npx tsc --noEmit", "git commit -m 'npm test'", "nohup npx vitest run > /tmp/x.log 2>&1 &", wrapTestCommand("npx vitest run")])
      expect(isTestCommand(c), c).toBe(false);
  });
  it("reads the timeout from the command", () => {
    expect(timeoutSecs("timeout 120 npx vitest run")).toBe(120);
    expect(timeoutSecs("timeout -k 5 2m npm test")).toBe(120);
    expect(timeoutSecs("npx vitest run")).toBeNull();
  });
  it("quotes the original command for the wrapper", () => {
    expect(wrapTestCommand("echo 'a b' && npm test")).toBe(`pai worker test-run -- bash -c 'echo '\\''a b'\\'' && npm test'`);
  });
});

describe("diagnosis", () => {
  it("maps inspector frames to worktree files and skips node internals", () => {
    const frames = userFrames(
      [
        { functionName: "tokenize", url: `file://${tmp}/src/parse.ts`, lineNumber: 86 },
        { functionName: "run", url: "node:internal/x", lineNumber: 1 },
        { functionName: "dep", url: `file://${tmp}/node_modules/v/i.js`, lineNumber: 3 },
        { functionName: "", url: `file://${tmp}/src/parse.test.ts`, lineNumber: 11 },
      ],
      tmp
    );
    expect(frames).toEqual([
      { fn: "tokenize", file: "src/parse.ts", line: 87 },
      { fn: "(anonymous)", file: "src/parse.test.ts", line: 12 },
    ]);
    const text = diagnose([[{ functionName: "tokenize", url: `file://${tmp}/src/parse.ts`, lineNumber: 86 }, { functionName: "t", url: `file://${tmp}/src/parse.test.ts`, lineNumber: 11 }]], tmp, 110);
    expect(text).toContain("stuck in src/parse.ts:87 tokenize() (called from src/parse.test.ts:12 t())");
    expect(text).toContain(HANG_MARKER);
  });
});

describe("hang probe on a real vitest run", () => {
  it("reports the file:line of a synchronous infinite loop and stops the run", async () => {
    const dir = fixture(
      "loop",
      `import { test, expect } from "vitest";
function tokenize(s: string) {
  let i = 0;
  while (i < 10) { if (s.length > 100) i++; }
  return i;
}
test("loops", () => { expect(tokenize("a")).toBe(10); });
`
    );
    const r = await probe(dir, "timeout 100 npx vitest run case.test.ts");
    expect(r.text).toContain("stuck in case.test.ts:4 tokenize()");
    expect(r.text).toContain("Rerunning unchanged will hang again".replace("Rerunning", "rerunning"));
    expect(r.code).toBe(124);
  }, 60_000);

  it("reports an async wait for a test that only sleeps", async () => {
    const dir = fixture(
      "sleep",
      `import { test } from "vitest";
test("sleeps", async () => { await new Promise((r) => setTimeout(r, 12000)); }, 30000);
`
    );
    const r = await probe(dir, "npx vitest run case.test.ts", 3);
    expect(r.text).toContain("waiting (async)");
    expect(r.text).not.toContain("stuck in");
    expect(r.code).toBe(0); // not killed: the sleeping test finishes
  }, 60_000);

  it("leaves a passing run untouched", async () => {
    const dir = fixture("pass", `import { test, expect } from "vitest";\ntest("ok", () => { expect(1).toBe(1); });\n`);
    const r = await probe(dir, "npx vitest run case.test.ts", 30);
    expect(r.code).toBe(0);
    expect(r.text).toContain("1 passed");
    expect(r.text).not.toContain(HANG_MARKER);
  }, 60_000);
});

describe("loop guard after a hang", () => {
  it("names the hang when a hung test command is repeated", () => {
    const cmd = "timeout 120 npx vitest run src/cli/parse.test.ts";
    let s = emptyLoopState();
    let denied: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = stepLoopGuard(s, "Bash", cmd, `print${i % 1}`);
      s = r.state;
      if (r.deny) {
        denied = r.reason;
        break;
      }
      s = recordLoopResult(s, "Bash", cmd, `RUN v4\n${HANG_MARKER} test run hung with no output for 110 s; stuck in src/cli/parse.ts:87 tokenize()\nexit 124`);
    }
    expect(denied).toContain("hung before");
  });
});

describe("worker-guard hook", () => {
  const call = (command: string, env: Record<string, string>) =>
    spawnSync("npx", ["tsx", "src/hooks/ts/pre-tool-use/worker-guard.ts"], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tmp }),
      env: { ...process.env, PAI_WORKER_LOOP_DIR: tmp, PAI_WORKER_ID: "w-probe", ...env },
      encoding: "utf8",
    }).stdout;
  it("routes a worker's test command through the probe; leaves other commands and interactive sessions alone", () => {
    const out = JSON.parse(call("timeout 120 npx vitest run a.test.ts", { PAI_WORKER: "1" }));
    expect(out.hookSpecificOutput.updatedInput.command).toBe(wrapTestCommand("timeout 120 npx vitest run a.test.ts"));
    expect(call("ls src", { PAI_WORKER: "1" })).toBe("");
    expect(call("npx vitest run a.test.ts", { PAI_WORKER: "" })).toBe("");
  }, 30_000);
});
