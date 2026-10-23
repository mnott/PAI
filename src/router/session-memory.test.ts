import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { combinedSearch, type MemorySearchFn } from "./session-memory.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const root = mkdtempSync(join(tmpdir(), "session-memory-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "nothing" } }) + "\n";

describe("memory hit session mapping via note frontmatter", () => {
  const projects = join(root, "projects");
  const proj = join(projects, "-p");
  const notes = join(root, "proj-root", "Notes");
  const mem: MemorySearchFn = async () => [
    { path: "Notes/one.md", snippet: "quokka early work", updatedAt: 1, roots: [join(root, "proj-root")] },
    { path: "Notes/two.md", snippet: "quokka only", updatedAt: 2, roots: [join(root, "proj-root")] },
    { path: "Notes/three.md", snippet: "quokka no ids", updatedAt: 3, roots: [join(root, "proj-root")] },
  ];
  it("picks the session containing the chunk's checkpoint time, else the latest, else none", async () => {
    mkdirSync(proj, { recursive: true });
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(proj, `${A}.jsonl`), line("2026-01-01T10:00:00Z") + line("2026-01-01T11:00:00Z"));
    writeFileSync(join(proj, `${B}.jsonl`), line("2026-01-02T10:00:00Z") + line("2026-01-02T11:00:00Z"));
    writeFileSync(join(notes, "one.md"), `---\nsessions: [${A}, ${B}]\n---\n# S\n\n### Checkpoint 2026-01-01T10:30:00.000Z\n\nquokka early work\n\n### Checkpoint 2026-01-02T10:30:00.000Z\n\nlater\n`);
    writeFileSync(join(notes, "two.md"), `---\nsessions: [${B}]\n---\n# S\nquokka only\n`);
    writeFileSync(join(notes, "three.md"), "# S\nquokka no ids\n");
    const r = await combinedSearch("quokka", { projectsDir: projects, hours: 1, now: Date.parse("2030-01-01T00:00:00Z"), memorySearch: mem });
    expect(r.memory.map((m) => [m.path, m.id])).toEqual([
      ["Notes/one.md", A],
      ["Notes/two.md", B],
      ["Notes/three.md", ""],
    ]);
    expect((r.memory[0] as unknown as Record<string, unknown>).roots).toBeUndefined();
  });
});
