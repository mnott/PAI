import { describe, it, expect, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whisperConfirmMarkerPath } from "../lib/whisper-confirm.js";

// whisper-rules.ts calls main() unconditionally at module scope (it's a hook
// entrypoint, always run as a subprocess) — including a blocking read of fd 0.
// Importing it in-process here would run that read against the test runner's
// own stdin and hang the suite, so every case below goes through a real
// subprocess with its own piped stdin, exactly like production invocation.
describe("user-prompt/whisper-rules entrypoint", () => {
  const ENTRYPOINT = "src/hooks/ts/user-prompt/whisper-rules.ts";

  // The hook reads PAI_WORKER / PAI_WORKER_PROVIDER; a local worker running
  // this suite would otherwise leak them into every subprocess.
  function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.PAI_WORKER;
    delete base.PAI_WORKER_PROVIDER;
    return { ...base, ...extra };
  }

  function runHook(stdin: string, extra: Record<string, string> = {}): string {
    return execFileSync("bun", [ENTRYPOINT], {
      input: stdin,
      encoding: "utf8",
      timeout: 15_000,
      env: cleanEnv(extra),
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

  it("gives a local worker the reduced block without the time line", () => {
    const stdout = runHook(JSON.stringify({ prompt: "please fix the login bug" }), {
      PAI_WORKER: "1",
      PAI_WORKER_PROVIDER: "some-local",
    });
    expect(stdout).not.toContain("CURRENT LOCAL TIME");
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
      return cleanEnv({ PAI_CONFIG_FILE: file });
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

  // The confirm-once rule asks for ONE confirmation per session life; before
  // the marker file it was injected per prompt and every session echoed
  // "Whispr rules read" on every response. First prompt of a session: line
  // in, marker written. Every later prompt: line dropped, other rules intact.
  describe("confirm-once rule injects once per session", () => {
    const home = mkdtempSync(join(tmpdir(), "pai-whisper-confirm-home-"));
    const usedSessions: string[] = [];

    const rules = [
      "# 1. ALWAYS",
      "After every new session or compact, confirm you read the Whispr rules.",
      "Begin EVERY response with a timestamp.",
      "# 2. WORKER",
      "# @worker",
      "Call a tool before answering.",
      "",
    ].join("\n");
    writeFileSync(join(home, "whisper-rules.md"), rules, "utf8");

    function run(sessionId: string, env: Record<string, string> = {}): string {
      usedSessions.push(sessionId);
      return execFileSync("bun", [ENTRYPOINT], {
        input: JSON.stringify({ session_id: sessionId, prompt: "do the task" }),
        encoding: "utf8",
        timeout: 15_000,
        env: cleanEnv({ PAI_HOME: home, ...env }),
      });
    }

    const newSession = () => `confirm-test-${randomUUID()}`;

    afterEach(() => {
      for (const id of new Set(usedSessions).values()) {
        rmSync(whisperConfirmMarkerPath(id), { force: true });
      }
      usedSessions.length = 0;
    });
    afterAll(() => rmSync(home, { recursive: true, force: true }));

    it("FirstPromptInjectsConfirm", () => {
      const out = run(newSession());
      expect(out).toContain("After every new session or compact, confirm");
    });

    it("SecondPromptDropsConfirm", () => {
      const id = newSession();
      const first = run(id);
      const second = run(id);
      expect(first).toContain("After every new session or compact, confirm");
      expect(second).not.toContain("After every new session or compact, confirm");
    });

    it("OtherRulesStillInjected", () => {
      const id = newSession();
      run(id);
      const second = run(id);
      expect(second).toContain("CURRENT LOCAL TIME");
      expect(second).toContain("Begin EVERY response with a timestamp.");
      expect(second).toContain("<system-reminder>");
    });

    it("WorkerPathUntouched", () => {
      // anthropic worker: same once-per-session drop, untagged + @worker
      // sections still both reach it
      const anth = newSession();
      expect(run(anth, { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "anthropic" })).toContain(
        "After every new session or compact, confirm"
      );
      const anthSecond = run(anth, { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "anthropic" });
      expect(anthSecond).not.toContain("After every new session or compact, confirm");
      expect(anthSecond).toContain("Call a tool before answering.");

      // local worker: @worker-only filtering unchanged, marker or not
      const loc = newSession();
      const locFirst = run(loc, { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "local30" });
      const locSecond = run(loc, { PAI_WORKER: "1", PAI_WORKER_PROVIDER: "local30" });
      expect(locFirst).toBe("<system-reminder>\nCall a tool before answering.\n</system-reminder>\n");
      expect(locSecond).toBe(locFirst);
    });
  });
});
