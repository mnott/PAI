import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolMemoryGet } from "./memory.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";

const stub = (root: string) =>
  ({
    getProjectBySlug: async (s: string) => (s === "p" ? { id: 1 } : null),
    resolveAlias: async () => null,
    getProjectById: async () => ({ id: 1, root_path: root }),
  }) as unknown as RegistryBackend;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe("memory_get path containment", () => {
  const base = mkdtempSync(join(tmpdir(), "pai-symlink-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  require("node:fs").mkdirSync(root);
  require("node:fs").mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "secret");
  writeFileSync(join(root, "a..b.md"), "ok-content");
  symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
  symlinkSync(outside, join(root, "dir"));
  const reg = stub(root);

  it("refuses a symlink pointing outside the root", async () => {
    for (const path of ["link.md", "dir/secret.md"]) {
      const r = await toolMemoryGet(reg, { project: "p", path });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Path traversal blocked");
    }
  });

  it("allows names containing .. that are not path segments", async () => {
    const r = await toolMemoryGet(reg, { project: "p", path: "a..b.md" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("ok-content");
  });
});
