import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// The entry does its own stdin read and calls main() unconditionally at
// module scope, and it must exercise the real exit-code/stderr contract —
// run it as a real subprocess, exactly like route-edits-to-worker.test.ts.
describe("security-validator", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/security-validator.ts";

  function runHook(
    command: string,
    env: NodeJS.ProcessEnv = {}
  ): { status: number | null; stdout: string; stderr: string } {
    const { PAI_WORKER: _drop, ...baseEnv } = process.env;
    try {
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({
          session_id: "test",
          tool_name: "Bash",
          tool_input: { command },
          cwd: process.cwd(),
        }),
        encoding: "utf8",
        timeout: 15_000,
        env: { ...baseEnv, ...env },
      });
      return { status: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number | null; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("writes the deny reason to stderr with exit code 2", () => {
    const { status, stderr } = runHook("git stash", { PAI_WORKER: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("Blocked by PAI security validator:");
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("allows git stash list for an in-place worker", () => {
    const { status, stderr } = runHook("git stash list", { PAI_WORKER: "1" });
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("allows git stash show for an in-place worker", () => {
    const { status } = runHook("git stash show", { PAI_WORKER: "1" });
    expect(status).toBe(0);
  });

  it("denies git stash push for an in-place worker", () => {
    const { status, stderr } = runHook("git stash push -m wip", { PAI_WORKER: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("Blocked by PAI security validator:");
  });

  it("denies git stash pop for an in-place worker", () => {
    const { status } = runHook("git stash pop", { PAI_WORKER: "1" });
    expect(status).toBe(2);
  });

  it.each([
    "git push --force-with-lease origin main",
    "git push --force-with-lease=main:abc123 origin main",
    "git -C repo.git push --force-with-lease URL main refs/tags/v1",
    "git push --force-with-lease --force-if-includes origin main",
    "git push --follow-tags origin main",
  ])("allows %s", (command) => {
    const { status, stderr } = runHook(command);
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it.each([
    "git push --force origin main",
    "git push -f origin main",
    "git push --force --force-with-lease origin main",
    "git push --force-with-lease origin main --force",
    "git push origin main -f",
  ])("asks on %s", (command) => {
    const { status, stdout } = runHook(command);
    expect(status).toBe(0);
    expect(stdout).toContain('"permissionDecision":"ask"');
  });

  it.each([
    "git push --force origin main",
    "git push -f origin main",
    "git push --force --force-with-lease origin main",
    "git push --force-with-lease origin main --force",
    "git push origin main -f",
  ])("denies %s for an in-place worker", (command) => {
    const { status, stderr } = runHook(command, { PAI_WORKER: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("dangerous operation");
  });

  it.each([
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "sudo rm -rf /usr",
    "find / -delete",
    "cd /tmp && rm -rf ~/",
    "rm -rf ./",
  ])("denies catastrophic deletion %s", (command) => {
    const { status, stderr } = runHook(command);
    expect(status).toBe(2);
    expect(stderr).toContain("catastrophic_deletion");
  });

  it.each([
    "awk -F'\\t' '$2 ~ /-anthropic-precise-00/ {print $1,$3,$8,$9}' file",
    "awk -F'\\t' 'NR>1{print $1,$2,$3,$8,$9}' file",
    "awk -F'\\t' '$2 ~ /local30-(spec|precise)-(2[0-3]|0)/ {print $1}' rows.tsv",
    'python3 -c " import math\ndef distance(p, a, b): return abs((b[0]-a[0])*(a[1]-p[1]) - (a[0]-p[0])*(b[1]-a[1])) / max(math.hypot(a[0]-b[0], a[1]-b[1]), 1e-9) ~ 1 "',
    "rm -rf /tmp/build",
    "rm -rf ~/tmp/build",
  ])("allows harmless command %s", (command) => {
    const { status } = runHook(command);
    expect(status).toBe(0);
  });

  it("allows an ordinary command", () => {
    const { status, stderr } = runHook("ls -la");
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it.each([
    'rm -rf "/"',
    'rm -rf "$HOME"',
    "rm -rf '/'",
  ])("denies catastrophic deletion with a quoted target %s", (command) => {
    const { status, stderr } = runHook(command);
    expect(status).toBe(2);
    expect(stderr).toContain("catastrophic_deletion");
  });

  it.each([
    'git commit -m "docs: explain git push -f policy"',
    "echo 'git push --force is blocked' && git status",
    'git commit -m "git reset --hard notes"',
  ])("allows quoted git text in %s", (command) => {
    const { status } = runHook(command);
    expect(status).toBe(0);
  });

  it.each([
    "git push -f origin main",
    "git push origin +main",
    "git push origin '+main'",
    'git commit -m "x" && git push --force',
    "git reset --hard HEAD~1",
  ])("asks on a forced push or hard reset %s", (command) => {
    const { status, stdout } = runHook(command);
    expect(status).toBe(0);
    expect(stdout).toContain('"permissionDecision":"ask"');
  });

  it.each([
    "git push -f origin main",
    "git push origin +main",
    "git push origin '+main'",
    'git commit -m "x" && git push --force',
    "git reset --hard HEAD~1",
  ])("denies a forced push or hard reset %s for an in-place worker", (command) => {
    const { status, stderr } = runHook(command, { PAI_WORKER: "1" });
    expect(status).toBe(2);
    // git reset --hard is caught by the worker-guard rule before the confirm
    // rule, so the reason differs there; both are denies.
    expect(stderr).toMatch(/dangerous operation|in-place worker/);
  });

  it("allows git push --force-with-lease and a plain push", () => {
    expect(runHook("git push --force-with-lease origin main").status).toBe(0);
    expect(runHook("git push origin main").status).toBe(0);
  });

  it("fails closed when the payload cannot be parsed", () => {
    try {
      execFileSync("bun", [ENTRYPOINT], { input: "{not json", encoding: "utf8", timeout: 15_000 });
      throw new Error("expected exit 2");
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      expect(e.status).toBe(2);
      expect(e.stderr).toContain("could not be parsed");
    }
  });
});
