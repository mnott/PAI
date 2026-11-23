import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoBuildOutput, assertStaticScans, keptLossOver, scanDiffForKeptLoss } from "./worktree.js";
import { KEPT_HEADER, renderKept, type KeptEntry } from "../testgov/kept.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), "merge-kept-"));
  git(base, ["init", "-q", "-b", "main"]);
  git(base, ["config", "user.email", "t@t"]);
  git(base, ["config", "user.name", "t"]);
  mkdirSync(join(base, "tests"), { recursive: true });
  const rows: KeptEntry[] = [
    { file: "tests/a.test.ts", classes: ["a"], evidence: "guarded bug 1" },
    { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
  ];
  for (const r of rows) writeFileSync(join(base, r.file), "it('x', () => {});\n");
  writeFileSync(join(base, "tests", "KEPT.md"), renderKept(rows));
  git(base, ["add", "-A"]);
  git(base, ["commit", "-qm", "base"]);
  return base;
}

/** Commit a change on a branch and return [base, branch]. */
function branch(base: string, name: string, write: (dir: string) => void): [string, string] {
  const from = git(base, ["rev-parse", "HEAD"]);
  git(base, ["checkout", "-q", "-B", name]);
  write(base);
  git(base, ["add", "-A"]);
  git(base, ["commit", "-qm", "change"]);
  git(base, ["checkout", "-q", "main"]);
  return [from, name];
}

/** Run the merge gate's pre-merge scans (backup, stub, test-loss, KEPT-loss) for a branch. */
function gate(base: string, from: string, to: string): void {
  assertStaticScans(base, from, to);
}

describe("KEPT-loss scan (pure)", () => {
  const before = renderKept([
    { file: "tests/a.test.ts", classes: ["a"], evidence: "guarded bug 1" },
    { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
  ]);
  const exists = () => true;

  it("a removed row of an existing test is reported by name", () => {
    const after = renderKept([{ file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" }]);
    expect(scanDiffForKeptLoss("", before, after, exists)).toContain("tests/a.test.ts");
  });

  it("a removed row whose test file is gone passes", () => {
    const after = renderKept([{ file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" }]);
    expect(scanDiffForKeptLoss("", before, after, () => false)).toBeNull();
  });

  it("an added row passes", () => {
    const after = renderKept([
      { file: "tests/a.test.ts", classes: ["a"], evidence: "guarded bug 1" },
      { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
      { file: "tests/c.test.ts", classes: ["c"], evidence: "external contract" },
    ]);
    expect(scanDiffForKeptLoss("", before, after, exists)).toBeNull();
  });

  it("an edited row's text passes", () => {
    const after = renderKept([
      { file: "tests/a.test.ts", classes: ["a"], evidence: "reworded evidence" },
      { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
    ]);
    expect(scanDiffForKeptLoss("", before, after, exists)).toBeNull();
  });

  it("a header-only file parses to no rows", () => {
    expect(scanDiffForKeptLoss("", KEPT_HEADER, KEPT_HEADER, () => true)).toBeNull();
  });
});

describe("KEPT-loss scan over a real branch", () => {
  it("removing a KEPT row of a test that still exists fails the merge and names it", () => {
    const base = repo();
    const [from, to] = branch(base, "drop-row", (d) => {
      writeFileSync(join(d, "tests", "KEPT.md"), renderKept([{ file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" }]));
    });
    expect(keptLossOver(base, from, to)).toContain("tests/a.test.ts");
    // the gate itself: the merge is refused before anything is applied
    expect(() => gate(base, from, to)).toThrow(/KEPT scan failed/);
    expect(() => gate(base, from, to)).toThrow(/tests\/a\.test\.ts/);
    rmSync(base, { recursive: true, force: true });
  });

  it("removing a KEPT row together with the test file passes", () => {
    const base = repo();
    const [from, to] = branch(base, "drop-with-file", (d) => {
      rmSync(join(d, "tests", "a.test.ts"));
      writeFileSync(join(d, "tests", "KEPT.md"), renderKept([{ file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" }]));
    });
    expect(keptLossOver(base, from, to)).toBeNull();
    expect(() => gate(base, from, to)).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });

  it("adding a KEPT row passes", () => {
    const base = repo();
    const [from, to] = branch(base, "add-row", (d) => {
      writeFileSync(join(d, "tests", "c.test.ts"), "it('c', () => {});\n");
      writeFileSync(
        join(d, "tests", "KEPT.md"),
        renderKept([
          { file: "tests/a.test.ts", classes: ["a"], evidence: "guarded bug 1" },
          { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
          { file: "tests/c.test.ts", classes: ["c"], evidence: "external contract" },
        ])
      );
    });
    expect(keptLossOver(base, from, to)).toBeNull();
    expect(() => gate(base, from, to)).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });

  it("editing a row's text passes", () => {
    const base = repo();
    const [from, to] = branch(base, "edit-row", (d) => {
      writeFileSync(
        join(d, "tests", "KEPT.md"),
        renderKept([
          { file: "tests/a.test.ts", classes: ["a"], evidence: "reworded evidence" },
          { file: "tests/b.test.ts", classes: ["b"], evidence: "pins a guard" },
        ])
      );
    });
    expect(keptLossOver(base, from, to)).toBeNull();
    expect(() => gate(base, from, to)).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });
});

describe("build-output scan over a real branch", () => {
  it("adding .build/x fails the merge and names the path and the fix", () => {
    const base = repo();
    const [from, to] = branch(base, "add-build", (d) => {
      mkdirSync(join(d, ".build"), { recursive: true });
      writeFileSync(join(d, ".build", "x.o"), "binary");
    });
    expect(assertNoBuildOutput(base, from, to)).toContain(".build/x.o");
    expect(() => gate(base, from, to)).toThrow(/branch commits build output/);
    expect(() => gate(base, from, to)).toThrow(/git rm -r --cached/);
    rmSync(base, { recursive: true, force: true });
  });

  it("adding src/a.ts passes", () => {
    const base = repo();
    const [from, to] = branch(base, "add-src", (d) => {
      mkdirSync(join(d, "src"), { recursive: true });
      writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
    });
    expect(assertNoBuildOutput(base, from, to)).toBeNull();
    expect(() => gate(base, from, to)).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });

  it("dist tracked on main + a branch change to dist passes", () => {
    const base = repo();
    mkdirSync(join(base, "dist"), { recursive: true });
    writeFileSync(join(base, "dist", "index.js"), "export {};\n");
    git(base, ["add", "-A"]);
    git(base, ["commit", "-qm", "track dist"]);
    const [from, to] = branch(base, "change-dist", (d) => {
      writeFileSync(join(d, "dist", "index.js"), "export const changed = 1;\n");
    });
    expect(assertNoBuildOutput(base, from, to)).toBeNull();
    expect(() => gate(base, from, to)).not.toThrow();
    rmSync(base, { recursive: true, force: true });
  });

  it("adding a .app bundle and a .dSYM fails", () => {
    const base = repo();
    const [from, to] = branch(base, "add-app", (d) => {
      mkdirSync(join(d, "build", "PAI.app"), { recursive: true });
      writeFileSync(join(d, "build", "PAI.app", "Info.plist"), "<plist/>");
      mkdirSync(join(d, "build", "PAI.dSYM", "Contents"), { recursive: true });
      writeFileSync(join(d, "build", "PAI.dSYM", "Contents", "Mach-O"), "x");
    });
    expect(assertNoBuildOutput(base, from, to)).toContain("build/PAI.app/Info.plist");
    expect(() => gate(base, from, to)).toThrow(/build\/PAI\.app/);
    rmSync(base, { recursive: true, force: true });
  });

  it("adding dist when dist is gitignored fails", () => {
    const base = repo();
    writeFileSync(join(base, ".gitignore"), "dist/\n");
    git(base, ["add", "-A"]);
    git(base, ["commit", "-qm", "ignore dist"]);
    const [from, to] = branch(base, "add-dist", (d) => {
      mkdirSync(join(d, "dist"), { recursive: true });
      writeFileSync(join(d, "dist", "index.js"), "export {};\n");
      git(d, ["add", "-f", "dist"]);
    });
    expect(assertNoBuildOutput(base, from, to)).toContain("dist/index.js");
    expect(() => gate(base, from, to)).toThrow(/branch commits build output/);
    rmSync(base, { recursive: true, force: true });
  });
});
