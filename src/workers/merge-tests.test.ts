import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FLAKY_KEEP, listFlaky, saveFlakyLog } from "./flaky-log.js";
import {
  buildRelatedCommand,
  changedSourceFiles,
  failingFiles,
  filterSourceFiles,
  hasVitest,
  passSummary,
  resolveAlwaysTests,
  runRelatedTests,
  type RelatedSettings,
} from "./merge-tests.js";

const dirs: string[] = [];
const tmp = (pkg?: object): string => {
  const d = mkdtempSync(join(tmpdir(), "mt-"));
  dirs.push(d);
  if (pkg) writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (files: string[]) => () => files.join("\0");
const cfg = (verify: string, verifyTimeoutSec = 30): RelatedSettings => ({ verify, verifyTimeoutSec });

/** A git repo with committed test files, so always-test globs resolve. */
const repo = (tests: string[]): string => {
  const d = mkdtempSync(join(tmpdir(), "mt-repo-"));
  dirs.push(d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ devDependencies: { vitest: "^1" } }));
  for (const t of tests) {
    mkdirSync(join(d, t, ".."), { recursive: true });
    writeFileSync(join(d, t), "it('x', () => {});\n");
  }
  spawnSync("git", ["init", "-q"], { cwd: d });
  spawnSync("git", ["add", "-A"], { cwd: d });
  spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: d });
  return d;
};

describe("merge related tests", () => {
  it("filters to source files, no tests", () => {
    expect(filterSourceFiles(["a.ts", "b.test.ts", "c.tsx", "d.mjs", "e.md", "f.test.mjs", "g.json"])).toEqual(["a.ts", "c.tsx", "d.mjs"]);
  });

  it("substitutes {files} with quoting", () => {
    expect(buildRelatedCommand("vitest related --run {files}", ["a b.ts", "it's.ts"])).toBe(`vitest related --run 'a b.ts' 'it'\\''s.ts'`);
  });

  it("detects vitest in devDependencies", () => {
    expect(hasVitest(tmp({ devDependencies: { vitest: "^1" } }))).toBe(true);
    expect(hasVitest(tmp({ dependencies: { vitest: "^1" } }))).toBe(false);
    expect(hasVitest(tmp())).toBe(false);
  });

  it("parses vitest output", () => {
    const out = " FAIL  src/x.test.ts > rule\n FAIL  src/x.test.ts > other\n FAIL  src/y.test.ts > z\n";
    expect(failingFiles(out)).toEqual(["src/x.test.ts", "src/y.test.ts"]);
    expect(passSummary(" Test Files  14 passed (14)\n      Tests  212 passed (212)\n")).toBe("14 files, 212 passed");
  });

  it("sums summaries across chunked runs", () => {
    const out =
      " Test Files  100 passed (100)\n      Tests  500 passed (500)\n" +
      " Test Files  100 passed (100)\n      Tests  500 passed (500)\n" +
      " Test Files  50 passed (50)\n      Tests  250 passed (250)\n";
    expect(passSummary(out)).toBe("250 files, 1250 passed");
  });

  it("a background process holding stdout does not delay a passing run", () => {
    const t0 = Date.now();
    const r = runRelatedTests(tmp(), "x", cfg('sh -c "sleep 30 >/dev/null 2>&1 & echo ok" {files}'), git(["a.ts"]), 50);
    expect(r.status).toBe("passed");
    expect(r.line).not.toContain("timed out");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("skips when verify is empty", () => {
    const r = runRelatedTests(tmp(), "x", cfg(""), git(["a.ts"]));
    expect(r.status).toBe("skipped");
  });

  it("skips the default command without vitest, and when nothing changed", () => {
    expect(runRelatedTests(tmp({}), "x", cfg("npx vitest related --run {files}"), git(["a.ts"])).line).toContain("no vitest");
    expect(runRelatedTests(tmp(), "x", cfg("true"), git([])).line).toContain("nothing changed");
  });

  it("passes on exit 0", () => {
    const r = runRelatedTests(tmp(), "x", cfg("true {files}"), git(["a.ts"]));
    expect(r.status).toBe("passed");
  });

  it("fails on a failing command", () => {
    const r = runRelatedTests(tmp(), "x", cfg(`node -e "process.exit(1)"`), git(["a.ts"]));
    expect(r.status).toBe("failed");
    expect(r.line).toBe("failed (exit 1)");
  });

  it("names failing files from the output", () => {
    const r = runRelatedTests(tmp(), "x", cfg(`node -e "console.log(' FAIL  src/q.test.ts > a'); process.exit(1)"`), git(["a.ts"]));
    expect(r.failing).toEqual(["src/q.test.ts"]);
  });

  it("times out", () => {
    const r = runRelatedTests(tmp(), "x", cfg(`node -e "setTimeout(()=>{},10000)"`, 1), git(["a.ts"]));
    expect(r.status).toBe("failed");
    expect(r.line).toContain("timed out after 1s");
  });

  it("appends always-tests to the command for a changed file", () => {
    const d = repo(["src/utils/guard.test.ts", "src/cli/docs.test.ts"]);
    let cmd = "";
    const r = runRelatedTests(d, "x", { verify: `sh -c 'printf "%s\\n" "$*" > captured.txt' x {files}`, verifyTimeoutSec: 30, alwaysTests: ["src/utils/guard.test.ts", "src/cli/*.test.ts"] }, git(["src/work/a.ts"]));
    cmd = readFileSync(join(d, "captured.txt"), "utf8").trim();
    expect(r.status).toBe("passed");
    expect(cmd.split(" ")).toEqual(["src/work/a.ts", "src/cli/docs.test.ts", "src/utils/guard.test.ts"]);
    expect(r.line).toContain("3 files, passed");
  });

  it("an empty alwaysTests list changes nothing", () => {
    const d = repo(["src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", cfg(`sh -c 'printf "%s\\n" "$*" > captured.txt' x {files}`), git(["src/work/a.ts"]));
    expect(readFileSync(join(d, "captured.txt"), "utf8").trim()).toBe("src/work/a.ts");
    expect(r.line).not.toContain("always-tests");
  });

  it("skips missing always-tests with a note, dedupes against changed files", () => {
    const d = repo(["src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", { verify: "true {files}", verifyTimeoutSec: 30, alwaysTests: ["src/nope.test.ts", "src/utils/guard.test.ts", "src/utils/guard.test.ts"] }, git(["src/work/a.ts"]));
    expect(r.line).toContain("always-tests skipped: src/nope.test.ts");
    expect(r.line).toContain("2 files, passed");
  });

  it("a test-only diff runs exactly that test file", () => {
    const d = repo(["src/work/kill-tree.test.ts", "src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", cfg(`sh -c 'printf "%s\\n" "$*" > captured.txt' x {files}`), git(["src/work/kill-tree.test.ts"]));
    expect(r.status).toBe("passed");
    expect(readFileSync(join(d, "captured.txt"), "utf8").trim()).toBe("src/work/kill-tree.test.ts");
    expect(r.line).toBe("related tests: skipped (no source change); always-tests: 1 files, passed");
  });

  it("a docs-only diff with no always-tests stays skipped", () => {
    const d = repo(["src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", cfg("true {files}"), git(["docs/concepts/workers.md"]));
    expect(r.status).toBe("skipped");
    expect(r.line).toContain("no source files changed");
    expect(existsSync(join(d, "captured.txt"))).toBe(false);
  });

  it("a source + test diff runs the union once, no duplicates", () => {
    const d = repo(["src/work/kill-tree.test.ts", "src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", { verify: `sh -c 'printf "%s\\n" "$*" > captured.txt' x {files}`, verifyTimeoutSec: 30, alwaysTests: ["src/work/kill-tree.test.ts", "src/utils/guard.test.ts"] }, git(["src/work/a.ts", "src/work/kill-tree.test.ts"]));
    expect(r.status).toBe("passed");
    expect(readFileSync(join(d, "captured.txt"), "utf8").trim().split(" ")).toEqual(["src/work/a.ts", "src/work/kill-tree.test.ts", "src/utils/guard.test.ts"]);
    expect(r.line).not.toContain("skipped");
  });

  it("a docs-only change runs the always-tests and skips related", () => {
    const d = repo(["src/cli/docs-sync.test.ts", "src/cli/docs-keys.test.ts", "src/utils/no-token-literals.test.ts"]);
    let cmd = "";
    const r = runRelatedTests(d, "x", { verify: `sh -c 'printf "%s\\n" "$*" > captured.txt; echo " Test Files  3 passed (3)"; echo "      Tests  12 passed (12)"' x {files}`, verifyTimeoutSec: 30, alwaysTests: ["src/cli/docs-*.test.ts", "src/utils/no-token-literals.test.ts"] }, git(["docs/concepts/workers.md"]));
    cmd = readFileSync(join(d, "captured.txt"), "utf8").trim();
    expect(r.status).toBe("passed");
    expect(cmd.split(" ")).toEqual(["src/cli/docs-keys.test.ts", "src/cli/docs-sync.test.ts", "src/utils/no-token-literals.test.ts"]);
    expect(r.line).toBe("related tests: skipped (no source change); always-tests: 3 files, 12 passed");
  });

  it("an empty merge runs nothing", () => {
    const d = repo(["src/utils/guard.test.ts"]);
    const r = runRelatedTests(d, "x", { verify: "true {files}", verifyTimeoutSec: 30, alwaysTests: ["src/utils/guard.test.ts"] }, git([]));
    expect(r.status).toBe("skipped");
    expect(r.line).toContain("nothing changed");
    expect(existsSync(join(d, "captured.txt"))).toBe(false);
  });

  it("resolveAlwaysTests: literal paths, globs, missing entries", () => {
    const d = repo(["src/cli/docs-sync.test.ts", "src/cli/docs-keys.test.ts", "src/utils/guard.test.ts"]);
    expect(resolveAlwaysTests(d, ["src/cli/docs-*.test.ts", "src/utils/guard.test.ts", "src/gone.test.ts"])).toEqual({
      files: ["src/cli/docs-keys.test.ts", "src/cli/docs-sync.test.ts", "src/utils/guard.test.ts"],
      missing: ["src/gone.test.ts"],
    });
  });

  it("keeps $& and $' in names literal and guards names starting with -", () => {
    expect(buildRelatedCommand("t {files}", ["x$&y.ts", "it$'s.ts", "a$$b.ts"])).toBe(`t 'x$&y.ts' 'it$'\\''s.ts' 'a$$b.ts'`);
    expect(buildRelatedCommand("t {files}", ["-x.ts"])).toBe("t './-x.ts'");
  });

  it("lists changed files with -z so odd names are not quoted", () => {
    const d = repo([]);
    const r = spawnSync("git", ["init"], { cwd: d });
    writeFileSync(join(d, "é ü.ts"), "x");
    spawnSync("git", ["add", "-A"], { cwd: d });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "n"], { cwd: d });
    const real = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;
    expect(r.status).toBe(0);
    expect(changedSourceFiles(d, "HEAD~1", real)).toEqual(["é ü.ts"]);
  });

  it("kills the whole process tree on timeout", () => {
    const d = tmp();
    const t0 = Date.now();
    const r = runRelatedTests(d, "x", cfg(`sh -c 'sleep 31 & echo $! > pid.txt; sleep 31' x {files}`, 1), git(["a.ts"]));
    expect(r.line).toContain("timed out after 1s");
    expect(Date.now() - t0).toBeLessThan(15_000);
    const pid = Number(readFileSync(join(d, "pid.txt"), "utf8").trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it("reports a signal exit as such", () => {
    const r = runRelatedTests(tmp(), "x", cfg("kill -9 $$"), git(["a.ts"]));
    expect(r.status).toBe("failed");
    expect(r.line).toContain("killed by SIGKILL");
  });

  it("chunks long file lists so argv stays small", () => {
    const d = tmp();
    const names = Array.from({ length: 450 }, (_, i) => `src/${"d".repeat(100)}/f${i}.ts`);
    const r = runRelatedTests(d, "x", cfg(`sh -c 'echo "$#" >> counts.txt' x {files}`), git(names));
    expect(r.status).toBe("passed");
    expect(readFileSync(join(d, "counts.txt"), "utf8").trim().split("\n").map(Number)).toEqual([100, 100, 100, 100, 50]);
  });
});

describe("serial re-run of failing files", () => {
  const out = (code: number, output: string) => ({ code, signal: null, timedOut: false, error: null, output });
  const FAIL = " FAIL  src/a.test.ts > t\n";
  const PASS = " Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
  const run = (runner: (...a: any[]) => ReturnType<typeof out>) =>
    runRelatedTests(tmp({ devDependencies: { vitest: "1" } }), "x", cfg("npx vitest related --run {files}"), git(["a.ts"]), undefined, runner as never);

  it("parallel fails A, serial passes -> flaky, no revert hint", () => {
    const cmds: string[] = [];
    const r = run((_c, _e, c: string[]) => { cmds.push(...c); return cmds.length === 1 ? out(1, FAIL) : out(0, PASS); });
    expect(r.status).toBe("flaky");
    expect(r.line).toBe("1 files, 3 passed; flaky under load (passed alone): src/a.test.ts");
    expect(cmds[1]).toContain("--no-file-parallelism");
    expect(cmds[1]).toContain("'src/a.test.ts'");
    expect(r.failing).toEqual([]);
  });

  it("serial re-run fails -> failed, naming only A", () => {
    let n = 0;
    const r = run(() => (++n === 1 ? out(1, FAIL + " FAIL  src/b.test.ts > t\n") : out(1, FAIL)));
    expect(r.status).toBe("failed");
    expect(r.failing).toEqual(["src/a.test.ts"]);
    expect(r.line).toContain("failed: src/a.test.ts");
    expect(r.line).not.toContain("b.test.ts");
  });

  const BATCH =
    " FAIL  src/a.test.ts > limits > rejects\nAssertionError: expected 5 to be 4\n  at src/a.test.ts:12\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed (9)\n";
  const flakyRun = (dir: string, runner: (...a: any[]) => ReturnType<typeof out>, files = ["a.ts"]) =>
    runRelatedTests(
      tmp({ devDependencies: { vitest: "1" } }),
      "x",
      { ...cfg("npx vitest related --run {files}"), flakyDir: dir },
      git(files),
      undefined,
      runner as never
    );

  it("batch fails, alone passes -> one log with the assertion, path returned", () => {
    const dir = join(tmp(), "flaky");
    let n = 0;
    const r = flakyRun(dir, () => (++n === 1 ? out(1, BATCH) : out(0, PASS)));
    expect(r.status).toBe("flaky");
    expect(r.flakyLogs).toHaveLength(1);
    expect(r.flakyLogs![0].startsWith(dir)).toBe(true);
    const text = readFileSync(r.flakyLogs![0], "utf8");
    expect(text).toContain("FAIL  src/a.test.ts > limits > rejects");
    expect(text).toContain("AssertionError: expected 5 to be 4");
    expect(text).toContain("Test Files  1 failed | 2 passed (3)");
    expect(text).toContain("batch load: 1 files");
    expect(readdirSync(dir)).toHaveLength(1);
    expect(listFlaky(dir)).toEqual([{ slug: "src-a.test.ts", file: "src/a.test.ts", count: 1, latest: r.flakyLogs![0] }]);
  });

  it("a real failure writes no log", () => {
    const dir = join(tmp(), "flaky");
    const r = flakyRun(dir, () => out(1, BATCH));
    expect(r.status).toBe("failed");
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps the newest 20 logs per file", () => {
    const dir = join(tmp(), "flaky");
    for (let i = 0; i < 25; i++) saveFlakyLog(dir, "src/a.test.ts", BATCH, { files: 3, at: new Date(Date.UTC(2026, 9, 24, 10, i)) });
    saveFlakyLog(dir, "src/a.test.ts.x", BATCH, { files: 3, at: new Date(Date.UTC(2026, 9, 24, 9)) });
    const names = readdirSync(dir).filter((f) => f.startsWith("src-a.test.ts-2026")).sort();
    expect(names).toHaveLength(FLAKY_KEEP);
    expect(names[0]).toContain("T10-05-");
    expect(readdirSync(dir)).toHaveLength(FLAKY_KEEP + 1);
  });

  it("parallel passes -> re-run not called", () => {
    let n = 0;
    const r = run(() => { n++; return out(0, PASS); });
    expect(r.status).toBe("passed");
    expect(n).toBe(1);
  });
});
