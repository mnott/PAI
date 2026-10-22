import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLesson, setState } from "../../memory/lessons.js";
import { toolMemoryLessons } from "./lessons.js";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pai-mcp-lessons-"));
  prev = process.env.PAI_HOME;
  process.env.PAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("memory_lessons get", () => {
  it("returns only approved lessons unless a state is passed", async () => {
    const l = addLesson({ title: "Cand", kind: "gotcha", applies_when: "", body: "b" });
    const hidden = await toolMemoryLessons({ action: "get", id: l.id });
    expect(hidden.isError).toBe(true);
    const shown = await toolMemoryLessons({ action: "get", id: l.id, state: "candidate" });
    expect(shown.isError).toBeUndefined();
    setState(l.id, "approved");
    expect((await toolMemoryLessons({ action: "get", id: l.id })).isError).toBeUndefined();
  });
});
