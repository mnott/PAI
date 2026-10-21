import { describe, it, expect } from "vitest";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { applyScratchEnv, removeScratch, scratchDir, scratchPromptLine } from "./scratch.js";
import { tmpScratchReason } from "../hooks/ts/lib/worker-bash-rules.js";
import { decideWorkerGuard } from "../hooks/ts/lib/worker-guard.js";

describe("worker scratch dir", () => {
  it("gives each worker its own TMPDIR outside any git repo and removes it", () => {
    const a: Record<string, string | undefined> = {};
    const b: Record<string, string | undefined> = {};
    applyScratchEnv(a, "w1-test");
    applyScratchEnv(b, "w2-test");
    try {
      expect(a.TMPDIR).not.toBe(b.TMPDIR);
      expect(a.TMPDIR).toBe(scratchDir("w1-test"));
      expect(statSync(a.TMPDIR!).mode & 0o777).toBe(0o700);
      const inRepo = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: a.TMPDIR });
      expect(inRepo.status).not.toBe(0);
      writeFileSync(join(a.TMPDIR!, "edit.py"), "x");
      removeScratch("w1-test");
      expect(existsSync(a.TMPDIR!)).toBe(false);
      expect(existsSync(b.TMPDIR!)).toBe(true);
    } finally {
      removeScratch("w1-test");
      removeScratch("w2-test");
    }
  });
});

describe("tmpScratchReason", () => {
  it.each([
    "cat > /tmp/edit.py <<'EOF'\nprint(1)\nEOF",
    "python3 /tmp/edit.py",
    "echo hi >> /private/tmp/x.log",
    "cat a | tee /tmp/out.txt",
    "cp a.txt /tmp/a.txt",
    "bash -c 'node /tmp/run.js'",
  ])("denies %s", (c) => expect(tmpScratchReason(c)).toContain("$TMPDIR"));

  it.each([
    'cat > "$TMPDIR/edit.py" <<\'EOF\'\nx\nEOF',
    'python3 "$TMPDIR/edit.py"',
    "cat /tmp/pai-daemon.log",
    "tail -n 5 /tmp/pai-daemon.log",
    "cp /tmp/a.txt ./a.txt",
    "python3 /tmp/claude-501/x.py",
    'd=$(mktemp -d); cat > "$d/x.py"',
  ])("allows %s", (c) => expect(tmpScratchReason(c)).toBeNull());

  it("guard denies for workers only", () => {
    const ctx = () => ({ cwd: "/x", home: "/h", worktreeRoot: null, inWorktree: false, mainCheckout: null, testScript: () => null });
    const input = { tool_name: "Bash", tool_input: { command: "python3 /tmp/edit.py" } };
    expect(decideWorkerGuard(input, { PAI_WORKER: "1" }, ctx).decision).toBe("deny");
    expect(decideWorkerGuard(input, {}, ctx).decision).toBe("allow");
  });
});

describe("scratch path in prompt and guard text", () => {
  it("preamble line carries the absolute scratch dir", () => {
    const env: Record<string, string | undefined> = {};
    const dir = applyScratchEnv(env, "w3-test");
    try {
      const line = scratchPromptLine(dir);
      expect(dir.startsWith("/")).toBe(true);
      expect(line).toContain(`Scratch dir: ${dir}`);
      expect(line).toContain("does not expand $TMPDIR");
    } finally {
      removeScratch("w3-test");
    }
  });
  it("guard refusal for literal /tmp quotes the absolute TMPDIR", () => {
    const old = process.env.TMPDIR;
    process.env.TMPDIR = "/var/x/pai-scratch/w4";
    try {
      expect(tmpScratchReason("echo hi > /tmp/probe.js")).toContain("/var/x/pai-scratch/w4");
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  });
});
