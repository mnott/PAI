import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyScratchEnv, removeScratch, scratchDir } from "./scratch.js";
import { tmpScratchReason } from "../hooks/ts/lib/worker-bash-rules.js";
import { decideWorkerGuard } from "../hooks/ts/lib/worker-guard.js";

describe("worker scratch dir", () => {
  it("gives each worker its own TMPDIR and removes it", () => {
    const logDir = mkdtempSync(join(tmpdir(), "pai-scratch-"));
    const a: Record<string, string | undefined> = {};
    const b: Record<string, string | undefined> = {};
    applyScratchEnv(a, logDir, "w1");
    applyScratchEnv(b, logDir, "w2");
    expect(a.TMPDIR).not.toBe(b.TMPDIR);
    expect(a.TMPDIR).toBe(scratchDir(logDir, "w1"));
    writeFileSync(join(a.TMPDIR!, "edit.py"), "x");
    removeScratch(logDir, "w1");
    expect(existsSync(a.TMPDIR!)).toBe(false);
    expect(existsSync(b.TMPDIR!)).toBe(true);
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
