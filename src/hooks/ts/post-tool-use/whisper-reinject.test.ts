import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// whisper-reinject.ts calls main() unconditionally at module scope, including
// a read of fd 0 — same reason as session-start-worker-guard.test.ts and
// user-prompt/whisper-rules.test.ts, run it as a real subprocess with its own
// piped stdin and an isolated TMPDIR so its counter file never collides with
// a real session's.
describe("post-tool-use/whisper-reinject entrypoint", () => {
  const ENTRYPOINT = "src/hooks/ts/post-tool-use/whisper-reinject.ts";
  let isolatedTmp: string;

  beforeEach(() => {
    isolatedTmp = mkdtempSync(join(tmpdir(), "whisper-reinject-test-"));
  });

  afterEach(() => {
    rmSync(isolatedTmp, { recursive: true, force: true });
  });

  function runHook(sessionId: string, env: NodeJS.ProcessEnv = {}): string {
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "PostToolUse" }),
      encoding: "utf8",
      timeout: 15_000,
      // This test suite itself may run inside a worker (PAI_WORKER=1 in
      // process.env) — explicitly clear it so "without the guard" cases are
      // not silently exercising the guarded path instead.
      env: { ...process.env, PAI_WORKER: "", TMPDIR: isolatedTmp, ...env },
    });
  }

  it("prints nothing and does not touch the counter file when PAI_WORKER=1", () => {
    const stdout = runHook("t", { PAI_WORKER: "1" });
    expect(stdout).toBe("");

    const counterDir = join(isolatedTmp, "pai-whisper-reinject");
    expect(existsSync(counterDir)).toBe(false);
  });

  it("stays quiet below the threshold and emits the reminder once enough calls have passed", () => {
    let stdout = "";
    for (let i = 0; i < 8; i++) {
      stdout = runHook("t");
    }
    expect(stdout).toContain("<system-reminder>");
    expect(stdout).toContain("tool calls into this turn");

    const counterDir = join(isolatedTmp, "pai-whisper-reinject");
    expect(readdirSync(counterDir).length).toBe(1);
  });
});
