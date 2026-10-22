import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInThread } from "./scan.js";
import { BUILTIN_RULES } from "../hooks/ts/lib/rules/builtin.generated.js";
import type { Rule } from "../hooks/ts/lib/rules/types.js";

function transcript(command: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "pai-scan-thread-")), "t.jsonl");
  const line = { type: "assistant", timestamp: "2026-01-01T10:00:00Z", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } };
  writeFileSync(path, JSON.stringify(line) + "\n");
  return path;
}

describe("scanInThread", () => {
  it("returns the findings of a normal scan", async () => {
    const found = await scanInThread([transcript("rm -rf /")], BUILTIN_RULES, 10000);
    expect(found).not.toBe("over");
    expect((found as { ruleId: string }[]).map((f) => f.ruleId)).toContain("rm-recursive-root");
  }, 20000);

  it("terminates a scan that runs past its budget", async () => {
    const slow: Rule = { id: "slow", severity: "block", reason: "r", match: "^(a|aa)+$", flags: "m" };
    const t0 = Date.now();
    const found = await scanInThread([transcript("a".repeat(60) + "!")], [slow], 1500);
    expect(found).toBe("over");
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20000);
});
