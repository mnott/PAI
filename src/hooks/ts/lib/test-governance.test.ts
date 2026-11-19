import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A worker's $TMPDIR is under …/pai-scratch/<id>/, which the guard exempts by
// design — fixtures must sit outside it to exercise the governed paths.
const FIXTURES = mkdtempSync("/tmp/tg-fixtures-");
beforeAll(() => () => rmSync(FIXTURES, { recursive: true, force: true }));
import { KEPT_LEDGER, bashCreatesNewTest, decideTestGovernance, ensureScratchIgnored } from "./test-governance.js";

/**
 * Scope regression (worker 20261119-061858-44984, 2026-11-19 06:33): a worker
 * in a third-party engine repo — no tests/KEPT.md, ungoverned — was denied
 * "No new test files" for `cp $TMPDIR/ts_orig.py terminal/serve/test_server.py`,
 * which only restored an EXISTING tracked test file from a copy. The rule runs
 * only in repos carrying the governance marker; a write to an existing path is
 * never a new test file; .pai-scratch/ and the worker's private $TMPDIR are
 * exempt everywhere.
 */

const git = (dir: string, ...args: string[]): unknown => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

/** A fresh git repo in a temp dir; `governed` creates the marker tests/KEPT.md. */
function makeRepo(governed: boolean): string {
  const dir = mkdtempSync(join(FIXTURES, "repo-"));
  // -c identity flags: a global user.name/email must not leak in (an invalid one
  // breaks `git commit`), and none may be missing (no identity -> commit fails).
  const gitId = (...args: string[]): unknown => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
  git(dir, "init", "-q", "-b", "main");
  // a base file: an ungoverned repo would otherwise have nothing to add and the
  // init commit fails ("nothing to commit")
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  if (governed) {
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, KEPT_LEDGER), "# Kept tests\n\n| File | Class | Evidence |\n| --- | --- | --- |\n");
  }
  gitId("add", "-A");
  gitId("commit", "-qm", "init");
  return dir;
}

/** An existing tracked test file (the incident's terminal/serve/test_server.py). */
function trackedTest(dir: string, rel: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "print('v1')\n");
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", rel], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", `track ${rel}`], { cwd: dir, stdio: "ignore" });
  return p;
}

describe("test governance applies only to governed repos (tests/KEPT.md marker)", () => {
  const scratch = mkdtempSync(join(FIXTURES, "scratch-"));
  const copies: [string, (dir: string) => string][] = [
    // the exact incident form: $TMPDIR resolved by simpleAssignments, unresolvable target in an ungoverned repo
    ["$TMPDIR-resolved", () => `T=${scratch}; cp $T/ts_orig.py terminal/serve/test_server.py`],
    // same restore with a literal private-scratch path
    ["literal scratch path", (dir) => `cp ${scratch}/ts_orig.py terminal/serve/test_server.py`],
  ];
  for (const [name, cmd] of copies) {
    it(`allows the incident cp in an ungoverned repo (${name})`, () => {
      const dir = makeRepo(false);
      trackedTest(dir, "terminal/serve/test_server.py");
      expect(bashCreatesNewTest(cmd(dir), dir)).toBeNull();
      expect(decideTestGovernance({ tool: "Bash", command: cmd(dir), cwd: dir }).decision).toBe("allow");
    });
  }

  it("allows every write in an ungoverned repo: a genuinely new test file passes too", () => {
    const dir = makeRepo(false);
    expect(bashCreatesNewTest("touch terminal/serve/test_brand_new.py", dir)).toBeNull();
    expect(decideTestGovernance({ tool: "Write", filePath: join(dir, "terminal/serve/test_brand_new.py"), cwd: dir }).decision).toBe("allow");
  });

  it("still denies a genuinely new test file in a governed repo (Bash and Write)", () => {
    const dir = makeRepo(true);
    expect(bashCreatesNewTest("touch tests/new_guard.test.ts", dir)).toContain("No new test files");
    expect(decideTestGovernance({ tool: "Write", filePath: join(dir, "tests/new_guard.test.ts"), cwd: dir }).decision).toBe("deny");
  });

  it("allows overwriting an existing tracked test file via cp in a governed repo", () => {
    const dir = makeRepo(true);
    const target = trackedTest(dir, "terminal/serve/test_server.py");
    expect(bashCreatesNewTest(`cp ${scratch}/ts_orig.py terminal/serve/test_server.py`, dir)).toBeNull();
    expect(decideTestGovernance({ tool: "Bash", command: `cp ${scratch}/ts_orig.py terminal/serve/test_server.py`, cwd: dir }).decision).toBe("allow");
    // and the Write-tool form of the same in-place restore
    expect(decideTestGovernance({ tool: "Write", filePath: target, cwd: dir }).decision).toBe("allow");
  });

  it("a KEPT.md-promoted path is allowed as new in a governed repo", () => {
    const dir = makeRepo(true);
    writeFileSync(join(dir, KEPT_LEDGER), "# Kept tests\n\n| File | Class | Evidence |\n| --- | --- | --- |\n| tests/pinned.test.ts | b | pins the destructive-op guard |\n");
    expect(bashCreatesNewTest("touch tests/pinned.test.ts", dir)).toBeNull();
  });

  it("unresolvable targets still fail closed in a governed repo", () => {
    const dir = makeRepo(true);
    // an unassigned $D leaves the target unresolvable: the literal test shape
    // inside this governed repo denies (fail closed).
    expect(bashCreatesNewTest("cp src.py $D/tests/generated_test.py", dir)).toContain("No new test files");
  });

  it("anything under .pai-scratch/ is exempt everywhere", () => {
    const dir = makeRepo(true);
    for (const cmd of ["touch .pai-scratch/tmp_check.test.ts", `echo x > ${scratch}/.pai-scratch/one_off_test.py`]) {
      expect(bashCreatesNewTest(cmd, dir)).toBeNull();
      expect(decideTestGovernance({ tool: "Bash", command: cmd, cwd: dir }).decision).toBe("allow");
    }
    expect(decideTestGovernance({ tool: "Write", filePath: join(dir, ".pai-scratch/one_off.test.ts"), cwd: dir }).decision).toBe("allow");
  });

  it("the worker's private $TMPDIR scratch stays exempt in a governed repo", () => {
    const dir = makeRepo(true);
    trackedTest(dir, "terminal/serve/test_server.py"); // the restore target exists: an in-place write, allowed
    expect(bashCreatesNewTest("cp $TMPDIR/ts_orig.py terminal/serve/test_server.py", dir)).toBeNull();
  });

  it("ensureScratchIgnored still housekeeps ungoverned repos", () => {
    const dir = makeRepo(false);
    ensureScratchIgnored(dir);
    expect(existsSync(join(dir, ".git", "info", "exclude"))).toBe(true);
  });

  it("denies a new test file via redirect and tee in a governed repo", () => {
    const dir = makeRepo(true);
    expect(bashCreatesNewTest("echo x > tests/redirect_test.py", dir)).toContain("No new test files");
    expect(bashCreatesNewTest("echo x | tee tests/tee_test.py", dir)).toContain("No new test files");
  });

  it("cleanup of a scratch checkout is never blocked", () => {
    const dir = makeRepo(true);
    expect(bashCreatesNewTest(`rm -rf ${scratch}/.pai-scratch/tree`, dir)).toBeNull();
  });
});
