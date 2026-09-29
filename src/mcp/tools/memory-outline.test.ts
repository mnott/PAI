import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolMemoryOutline, toolMemoryGet } from "./memory.js";
import type { RegistryBackend } from "../../storage/registry-interface.js";

const stub = (root: string) =>
  ({
    getProjectBySlug: async (s: string) => (s === "p" ? { id: 1 } : null),
    resolveAlias: async () => null,
    getProjectById: async () => ({ id: 1, root_path: root }),
  }) as unknown as RegistryBackend;

const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

describe("toolMemoryOutline", () => {
  const root = mkdtempSync(join(tmpdir(), "pai-outline-"));
  writeFileSync(join(root, "a.md"), "# A\nx\n## B\ny\n### C\nz\n```\n# no\n```\n## D\nw\n");
  const reg = stub(root);

  it("renders an indented outline with line ranges and honours max_depth", async () => {
    const full = text(await toolMemoryOutline(reg, { project: "p", path: "a.md" }));
    expect(full).toMatch(/^p\/a\.md outline:\n\n# A {2}L1-11 ~\d+t\n {2}## B {2}L3-9 ~\d+t\n {4}### C {2}L5-9 ~\d+t\n {2}## D {2}L10-11 ~\d+t$/);
    const shallow = text(await toolMemoryOutline(reg, { project: "p", path: "a.md", max_depth: 2 }));
    expect(shallow).not.toContain("### C");
    expect(shallow).toContain("## D");
  });

  it("applies the same access checks as memory_get", async () => {
    for (const path of ["../x.md", "/etc/passwd", "missing.md"]) {
      const a = await toolMemoryOutline(reg, { project: "p", path });
      const g = await toolMemoryGet(reg, { project: "p", path });
      expect(a.isError).toBe(true);
      expect(text(a)).toBe(text(g));
    }
    expect(text(await toolMemoryOutline(reg, { project: "nope", path: "a.md" }))).toBe("Project not found: nope");
  });

  it("prints a real repo outline (read-only)", async () => {
    const repo = process.cwd();
    if (!existsSync(join(repo, "Notes/TODO.md"))) return;
    const out = text(await toolMemoryOutline(stub(repo), { project: "p", path: "Notes/TODO.md", max_depth: 2 }));
    console.log(out.split("\n").slice(0, 15).join("\n"));
    expect(out).toContain("outline:");
    rmSync(root, { recursive: true, force: true });
  });
});
