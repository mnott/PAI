import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// whisper-rules.ts calls main() unconditionally at module scope (it's a hook
// entrypoint, always run as a subprocess) — including a blocking read of fd 0.
// Importing it in-process here would run that read against the test runner's
// own stdin and hang the suite, so every case below goes through a real
// subprocess with its own piped stdin, exactly like production invocation.
describe("user-prompt/whisper-rules entrypoint", () => {
  const ENTRYPOINT = "src/hooks/ts/user-prompt/whisper-rules.ts";

  function runHook(stdin: string): string {
    return execFileSync("bun", [ENTRYPOINT], {
      input: stdin,
      encoding: "utf8",
      timeout: 15_000,
    });
  }

  it("emits nothing for a worker-completion relay prompt", () => {
    const stdout = runHook(JSON.stringify({ prompt: "[Session:x] worker y finished" }));
    expect(stdout).toBe("");
  });

  it("emits nothing for a clickr control-handover line", () => {
    const stdout = runHook(JSON.stringify({ prompt: "your controls." }));
    expect(stdout).toBe("");
  });

  it("emits nothing for a harness [SYSTEM NOTIFICATION preamble", () => {
    const stdout = runHook(
      JSON.stringify({ prompt: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nfoo" })
    );
    expect(stdout).toBe("");
  });

  it("emits nothing for a background task completion carrying <task-notification>", () => {
    const stdout = runHook(
      JSON.stringify({ prompt: "foo <task-notification>x</task-notification>" })
    );
    expect(stdout).toBe("");
  });

  it("still injects the system-reminder block for a normal prompt", () => {
    const stdout = runHook(JSON.stringify({ prompt: "please fix the login bug" }));
    expect(stdout).toContain("<system-reminder>");
    expect(stdout).toContain("CURRENT LOCAL TIME");
  });
});
