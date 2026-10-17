import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWorkerGuard, type WorkerGuardContext } from "./worker-guard.js";

let root: string;
const ctx = (): WorkerGuardContext => ({ cwd: root, home: "/home/u", worktreeRoot: root, inWorktree: false, mainCheckout: null, testScript: () => null });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

const LOCAL = { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "ollama" };
const ANTHROPIC = { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "anthropic" };
const write = (env: Record<string, string>, file: string, content: string) =>
  decideWorkerGuard({ tool_name: "Write", tool_input: { file_path: join(root, file), content } }, env, ctx);
const bash = (env: Record<string, string>, command: string) => decideWorkerGuard({ tool_name: "Bash", tool_input: { command } }, env, ctx);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wg-local-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), lines(100));
  writeFileSync(join(root, "src", "big.swift"), lines(100));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

describe("local-provider worker guard", () => {
  it("denies a new file in the repo root", () => {
    const d = write(LOCAL, "scratch.swift", "x");
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain("$TMPDIR");
  });
  it("allows a new file in a subdirectory", () => {
    expect(write(LOCAL, "src/new.swift", "x").decision).toBe("allow");
  });
  it("allows editing an existing root file", () => {
    expect(decideWorkerGuard({ tool_name: "Edit", tool_input: { file_path: join(root, "README.md") } }, LOCAL, ctx).decision).toBe("allow");
  });
  it("denies a Write that drops >40 lines and more than half", () => {
    const d = write(LOCAL, "src/big.swift", lines(12));
    expect(d.decision).toBe("deny");
    expect((d as { reason: string }).reason).toContain("rewrite would delete 88 of 100 lines; use Edit for the change");
  });
  it("allows a small rewrite (2-line fix, or shorter by under half)", () => {
    expect(write(LOCAL, "src/big.swift", lines(98)).decision).toBe("allow");
    expect(write(LOCAL, "src/big.swift", lines(60)).decision).toBe("allow");
  });
  it("denies rm and git rm of a tracked file, allows untracked", () => {
    expect(bash(LOCAL, "rm README.md").decision).toBe("deny");
    expect(bash(LOCAL, "git rm -f src/big.swift").decision).toBe("deny");
    expect(bash(LOCAL, "rm -f nothing-here.tmp").decision).toBe("allow");
  });
  it("allows rm and git rm of a tracked file the branch added itself, still denies files from the base", () => {
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
    writeFileSync(join(root, "src", "mine.ts"), "x\n");
    writeFileSync(join(root, "src", "mine2.ts"), "x\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "mistake");
    expect(bash(LOCAL, "git rm --cached src/mine.ts").decision).toBe("allow");
    expect(bash(LOCAL, "rm src/mine2.ts").decision).toBe("allow");
    expect(bash(LOCAL, "git rm -f src/mine.ts").decision).toBe("allow");
    expect(bash(LOCAL, "rm README.md").decision).toBe("deny");
    expect(bash(LOCAL, "git rm src/big.swift").decision).toBe("deny");
  });
  it("leaves anthropic workers and the interactive session alone", () => {
    for (const env of [ANTHROPIC, { PAI_WORKER: "1" }, {}] as Record<string, string>[]) {
      expect(write(env, "scratch.swift", "x").decision).toBe("allow");
      expect(write(env, "src/big.swift", lines(12)).decision).toBe("allow");
      expect(bash(env, "rm README.md").decision).toBe("allow");
    }
  });
});
