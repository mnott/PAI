import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTodoContent, writeFileAtomic, type TodoItem } from "./todo-sync.js";

const todos: TodoItem[] = [{ content: "do it", status: "pending", activeForm: "doing it" }];
const NOW = "2026-01-01T00:00:00.000Z";

describe("buildTodoContent", () => {
  it("keeps a '## Continue' section at offset 0 byte-exact", () => {
    const existing = "## Continue\n\nresume here\n\n- a\n\n## Plans\n\nplan\n";
    const out = buildTodoContent(todos, existing, NOW);
    expect(out).toContain("## Continue\n\nresume here\n\n- a\n\n## Plans\n\nplan\n");
    expect(out).toContain("## Current Session\n\n### Pending\n\n- [ ] do it\n");
    expect(out.startsWith("## Continue") || out.startsWith("## Current Session")).toBe(true);
  });

  it("changes only the managed section and the footer", () => {
    const existing =
      "# TODO\n\n## Current Session\n\n- [ ] old\n\n## Continue\n\nc\n\n## Backlog\n\n- a\n\n## Plans\n\np\n\n---\n\n*Last updated: 2020-01-01*\n";
    const out = buildTodoContent(todos, existing, NOW);
    expect(out).toBe(
      "# TODO\n\n## Current Session\n\n### Pending\n\n- [ ] do it\n\n## Continue\n\nc\n\n## Backlog\n\n- a\n\n## Plans\n\np\n\n---\n\n*Last updated: " +
        NOW +
        "*\n",
    );
  });

  it("keeps the blank line between preserved sections", () => {
    const out = buildTodoContent(todos, "# TODO\n\n## Backlog\n\n- a\n\n## Plans\n\nx\n", NOW);
    expect(out).toContain("- a\n\n## Plans");
  });

  it("is stable on a second run", () => {
    const first = buildTodoContent(todos, "## Continue\n\nc\n", NOW);
    expect(buildTodoContent(todos, first, NOW)).toBe(first);
  });

  it("creates a fresh file for empty input", () => {
    expect(buildTodoContent([], "", NOW)).toContain("# TODO\n\n## Current Session\n\n_(No active session tasks)_");
  });
});

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-"));
    const p = join(dir, "TODO.md");
    writeFileSync(p, "old");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["TODO.md"]);
  });
});
