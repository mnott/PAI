import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A worker on a non-anthropic provider (a local model) must not receive the
// operator's rules: it echoes them instead of working. Only "# @worker"
// sections reach it; no time cue, no advisor guidance.
describe("whisper-rules for local-provider workers", () => {
  const ENTRYPOINT = "src/hooks/ts/user-prompt/whisper-rules.ts";
  const home = mkdtempSync(join(tmpdir(), "pai-whisper-worker-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const rules = [
    "# 1. OPERATOR",
    "Begin EVERY response with a timestamp.",
    "# 2. WORKER",
    "# @worker",
    "Call a tool before answering.",
    "",
  ].join("\n");
  writeFileSync(join(home, "whisper-rules.md"), rules, "utf8");
  writeFileSync(
    join(home, "advisor-mode.json"),
    JSON.stringify({ mode: "conservative", forceModel: "sonnet" }),
    "utf8"
  );

  function run(env: Record<string, string>): string {
    const base: NodeJS.ProcessEnv = { ...process.env, PAI_HOME: home };
    delete base.PAI_WORKER;
    delete base.PAI_WORKER_PROVIDER;
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({ prompt: "do the task" }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...base, ...env },
    });
  }

  const strip = (s: string) => s.replace(/CURRENT LOCAL TIME: [\d-]+ [\d:]+/, "CURRENT LOCAL TIME: T");

  it("local worker: only the @worker section, no time cue, no advisor", () => {
    const out = run({ PAI_WORKER: "1", PAI_WORKER_PROVIDER: "local30" });
    expect(out).toBe("<system-reminder>\nCall a tool before answering.\n</system-reminder>\n");
  });

  it("local worker with no @worker section prints nothing", () => {
    writeFileSync(join(home, "whisper-rules.md"), "# 1. OPERATOR\nBegin EVERY response.\n", "utf8");
    try {
      expect(run({ PAI_WORKER: "1", PAI_WORKER_PROVIDER: "local30" })).toBe("");
    } finally {
      writeFileSync(join(home, "whisper-rules.md"), rules, "utf8");
    }
  });

  it("anthropic worker output is byte-identical to a worker without a provider", () => {
    const anth = strip(run({ PAI_WORKER: "1", PAI_WORKER_PROVIDER: "anthropic" }));
    const none = strip(run({ PAI_WORKER: "1" }));
    expect(anth).toBe(none);
    expect(anth).toContain("CURRENT LOCAL TIME");
    expect(anth).toContain("Begin EVERY response");
    expect(anth).toContain("Call a tool before answering.");
    expect(anth).toContain("sonnet");
  });

  it("orchestrator output is unchanged even if a provider var leaks in", () => {
    const orch = strip(run({}));
    expect(strip(run({ PAI_WORKER_PROVIDER: "local30" }))).toBe(orch);
    expect(orch).toContain("Begin EVERY response");
    expect(orch).not.toContain("Call a tool before answering.");
  });
});
