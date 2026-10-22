import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { timestampedBackupPath } from "./steps/05-pai-skill.js";

let d = "";
afterEach(() => rmSync(d, { recursive: true, force: true }));

describe("timestampedBackupPath", () => {
  it("never reuses an existing backup name", () => {
    d = mkdtempSync(join(tmpdir(), "pai-bak-"));
    const f = join(d, "SKILL.md");
    const a = timestampedBackupPath(f);
    expect(a).toMatch(/SKILL\.md\.backup-/);
    writeFileSync(a, "1");
    const b = timestampedBackupPath(f);
    expect(b).not.toBe(a);
  });
});
