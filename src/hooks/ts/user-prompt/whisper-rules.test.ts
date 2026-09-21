import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  describe("cache-keepalive beat prompt", () => {
    const dirs: string[] = [];

    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function configuredEnv(config: Record<string, unknown>): NodeJS.ProcessEnv {
      const dir = mkdtempSync(join(tmpdir(), "pai-whisper-keepalive-"));
      dirs.push(dir);
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify(config), "utf8");
      return { ...process.env, PAI_CONFIG_FILE: file };
    }

    it("replies with only the minimal tool-free instruction, bypassing rules/advisor", () => {
      const env = configuredEnv({ sessions: { cacheKeepalive: { enabled: true, prompt: "keepalive" } } });
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ prompt: "keepalive" }),
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
      expect(stdout).toBe(
        "<system-reminder>\nCache keepalive beat, a no-op. Reply with a single period and nothing else. Do not call tools. Do not reply to the sender.\n</system-reminder>\n"
      );
      expect(stdout).not.toContain("CURRENT LOCAL TIME");
    });

    it("treats a beat wrapped as [Session:<sender>] keepalive as the same no-op", () => {
      const env = configuredEnv({ sessions: { cacheKeepalive: { enabled: true, prompt: "keepalive" } } });
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ prompt: "[Session:pai-cli] keepalive" }),
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
      expect(stdout).toBe(
        "<system-reminder>\nCache keepalive beat, a no-op. Reply with a single period and nothing else. Do not call tools. Do not reply to the sender.\n</system-reminder>\n"
      );
      expect(stdout).not.toContain("CURRENT LOCAL TIME");
    });

    it("still emits nothing for a [Session:] relay that is not the beat", () => {
      const env = configuredEnv({ sessions: { cacheKeepalive: { enabled: true, prompt: "keepalive" } } });
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ prompt: "[Session:peer] R z=alive r=idle" }),
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
      expect(stdout).toBe("");
    });

    it("falls through to the normal rule block when the feature is disabled", () => {
      const env = configuredEnv({ sessions: { cacheKeepalive: { enabled: false, prompt: "keepalive" } } });
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ prompt: "keepalive" }),
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
      expect(stdout).toContain("CURRENT LOCAL TIME");
    });

    it("falls through to the normal rule block for a prompt that doesn't match the configured word", () => {
      const env = configuredEnv({ sessions: { cacheKeepalive: { enabled: true, prompt: "keepalive" } } });
      const stdout = execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ prompt: "please fix the login bug" }),
        encoding: "utf8",
        timeout: 15_000,
        env,
      });
      expect(stdout).toContain("CURRENT LOCAL TIME");
    });
  });
});
