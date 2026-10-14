import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContractAddendum } from "./contract-addendum.js";
import { workerContractPrompt } from "./report.js";

describe("provider contract addendum", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-contract-"));
  it("loads an override file with a stable sha", () => {
    const f = join(dir, "x.md");
    writeFileSync(f, "Rule one.\n");
    const a = loadContractAddendum("x", f)!;
    expect(a.text).toBe("Rule one.");
    expect(a.sha).toMatch(/^[0-9a-f]{8}$/);
    expect(loadContractAddendum("x", f)!.sha).toBe(a.sha);
  });
  it("missing or empty file means no addendum", () => {
    const f = join(dir, "empty.md");
    writeFileSync(f, "  \n");
    expect(loadContractAddendum("x", f)).toBeNull();
    expect(loadContractAddendum("x", join(dir, "none.md"))).toBeNull();
  });
  it("generic contract prefers the project's blocking command over wait-on", () => {
    expect(workerContractPrompt(undefined, "ag2")).toContain("Prefer the project's own blocking command");
  });
});
