import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRelatedCommand,
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

const git = (files: string[]) => () => files.join("\n");
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

  it("skips when verify is empty", () => {
    const r = runRelatedTests(tmp(), "x", cfg(""), git(["a.ts"]));
    expect(r.status).toBe("skipped");
  });

  it("skips the default command without vitest, and when no source changed", () => {
    expect(runRelatedTests(tmp({}), "x", cfg("npx vitest related --run {files}"), git(["a.ts"])).line).toContain("no vitest");
    expect(runRelatedTests(tmp(), "x", cfg("true"), git(["a.md"])).line).toContain("no source files");
  });

  it("passes on exit 0", () => {
    const r = runRelatedTests(tmp(), "x", cfg("true {files}"), git(["a.ts"]));
    expect(r.status).toBe("passed");
  });

  it("fails on a failing command", () => {
    const r = runRelatedTests(tmp(), "x", cfg(`node -e "process.exit(1)"`), git(["a.ts"]));
    expect(r.status).toBe("failed");
    expect(r.line).toBe("related tests: failed (exit 1)");
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
    expect(r.line).toContain("1 source files + 2 always-tests, passed");
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
    expect(r.line).toContain("1 source files + 1 always-tests, passed");
  });

  it("resolveAlwaysTests: literal paths, globs, missing entries", () => {
    const d = repo(["src/cli/docs-sync.test.ts", "src/cli/docs-keys.test.ts", "src/utils/guard.test.ts"]);
    expect(resolveAlwaysTests(d, ["src/cli/docs-*.test.ts", "src/utils/guard.test.ts", "src/gone.test.ts"])).toEqual({
      files: ["src/cli/docs-keys.test.ts", "src/cli/docs-sync.test.ts", "src/utils/guard.test.ts"],
      missing: ["src/gone.test.ts"],
    });
  });
});
