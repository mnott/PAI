import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

// Every SessionStart hook entrypoint calls main() unconditionally at module
// scope and (for most of them) blocks reading fd 0 — importing them in-process
// would run that read against the test runner's own stdin and hang the suite.
// Each case below runs the entrypoint as a real subprocess with its own piped
// stdin and env, exactly like production invocation (see
// user-prompt/whisper-rules.test.ts for the same pattern).
describe("session-start hooks: worker sessions get no injected context", () => {
  const HOOKS = [
    "src/hooks/ts/session-start/initialize-session.ts",
    "src/hooks/ts/session-start/inject-observations.ts",
    "src/hooks/ts/session-start/load-core-context.ts",
    "src/hooks/ts/session-start/load-project-context.ts",
    "src/hooks/ts/session-start/mcp-deferred-reminder.ts",
    "src/hooks/ts/session-start/post-compact-inject.ts",
  ];

  function runHook(entrypoint: string, env: NodeJS.ProcessEnv): string {
    return execFileSync("bun", [entrypoint], {
      input: JSON.stringify({ session_id: "t", hook_event_name: "SessionStart", source: "startup" }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, ...env },
    });
  }

  for (const entrypoint of HOOKS) {
    it(`${entrypoint} prints nothing when PAI_WORKER=1`, () => {
      const stdout = runHook(entrypoint, { PAI_WORKER: "1" });
      expect(stdout).toBe("");
    });
  }
});
