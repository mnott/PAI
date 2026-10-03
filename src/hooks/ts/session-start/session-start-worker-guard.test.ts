import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("load-core-context.ts injects the standing edit-gate notice for a non-worker session", () => {
    // Explicitly clear PAI_WORKER: this suite itself may run inside a worker,
    // whose ambient env would otherwise leak into the child and short-circuit it.
    const stdout = runHook("src/hooks/ts/session-start/load-core-context.ts", { PAI_WORKER: "" });
    expect(stdout).toContain("Edit/Write on code files is denied in this session by policy");
    expect(stdout).toContain("pai worker run --class implement");
    expect(stdout).not.toContain("--provider anthropic");
  });

  it("load-core-context.ts omits the edit-gate notice when PAI_WORKER=1", () => {
    const stdout = runHook("src/hooks/ts/session-start/load-core-context.ts", { PAI_WORKER: "1" });
    expect(stdout).not.toContain("Edit/Write on code files is denied");
  });
});

describe("load-core-context.ts: CORE is optional", () => {
  it("exits 0 with empty stdout/stderr when ~/.claude/skills/CORE/SKILL.md is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "pai-core-"));
    try {
      mkdirSync(join(home, ".claude", "skills"), { recursive: true });
      const r = spawnSync("bun", ["src/hooks/ts/session-start/load-core-context.ts"], {
        input: JSON.stringify({ session_id: "t", hook_event_name: "SessionStart", source: "startup" }),
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, HOME: home, ADAPTER_DIR: "", PAI_DIR: "", PAI_WORKER: "" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).not.toContain("CORE skill not found");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function runWithSkills(skills: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "pai-core-"));
    try {
      for (const [name, marker] of Object.entries(skills)) {
        mkdirSync(join(home, ".claude", "skills", name), { recursive: true });
        writeFileSync(join(home, ".claude", "skills", name, "SKILL.md"), marker);
      }
      return spawnSync("bun", ["src/hooks/ts/session-start/load-core-context.ts"], {
        input: JSON.stringify({ session_id: "t", hook_event_name: "SessionStart", source: "startup" }),
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, HOME: home, ADAPTER_DIR: "", PAI_DIR: "", PAI_WORKER: "" },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("falls back to skills/PAI/SKILL.md (the `pai setup` layout) when CORE is absent", () => {
    const r = runWithSkills({ PAI: "PAI-ONLY-MARKER" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PAI CORE CONTEXT");
    expect(r.stdout).toContain("PAI-ONLY-MARKER");
  });

  it("prefers CORE over PAI when both exist", () => {
    const r = runWithSkills({ CORE: "CORE-WINS-MARKER", PAI: "PAI-LOSES-MARKER" });
    expect(r.stdout).toContain("CORE-WINS-MARKER");
    expect(r.stdout).not.toContain("PAI-LOSES-MARKER");
  });
});
