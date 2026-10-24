import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fakeUrl } from "../../../utils/fake-secret.js";

// Subprocess run, same reason as route-edits-to-worker.test.ts: the entry
// reads stdin and calls main() at module scope.
describe("worker-edit-repair: literal credential guard", () => {
  const ENTRYPOINT = "src/hooks/ts/pre-tool-use/worker-edit-repair.ts";
  // A literal DSN password, assembled so this file stays scanner-clean.
  const dsn = fakeUrl("postgresql", "user", "hunter2", "localhost/db");

  function runHook(content: string, env: NodeJS.ProcessEnv, file = "src/x/db.test.ts"): string {
    const { PAI_WORKER: _drop, ...baseEnv } = process.env;
    return execFileSync("bun", [ENTRYPOINT], {
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content } }),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...baseEnv, ...env },
    });
  }

  it("denies a literal DSN password in a test file with the builder hint", () => {
    const out = runHook(`const u = "${dsn}";\n`, { PAI_WORKER: "1" });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("literal credential (url-creds");
    expect(reason).toContain("src/utils/fake-secret.ts");
    expect(reason).toContain("fakeUrl");
  });

  it("allows the same content built via the builder", () => {
    const built = `import { fakeUrl } from "../utils/fake-secret.js";\nconst u = fakeUrl("postgresql", "user", "pw", "localhost/db");\n`;
    expect(runHook(built, { PAI_WORKER: "1" })).toBe("");
  });

  it("leaves non-worker sessions untouched", () => {
    expect(runHook(`const u = "${dsn}";\n`, {})).toBe("");
  });

  it("does not scan non-test files", () => {
    expect(runHook(`const u = "${dsn}";\n`, { PAI_WORKER: "1" }, "src/x/db.ts")).toBe("");
  });
});
