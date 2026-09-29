import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ADAPTER_DIR, SKILLS_DIR, AGENTS_DIR, COMMANDS_DIR } from "./pai-paths.js";

// Claude Code loads lowercase dirs; case-sensitive filesystems (Linux) tell them apart.
describe("pai-paths adapter dirs", () => {
  it("use the lowercase names Claude Code loads from", () => {
    expect(SKILLS_DIR).toBe(join(ADAPTER_DIR, "skills"));
    expect(AGENTS_DIR).toBe(join(ADAPTER_DIR, "agents"));
    expect(COMMANDS_DIR).toBe(join(ADAPTER_DIR, "commands"));
  });
});
