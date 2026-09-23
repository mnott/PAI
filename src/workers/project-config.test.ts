import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import DatabaseCtor from "better-sqlite3";
import { initializeSchema } from "../storage/sqlite/registry-schema.js";
import { SQLiteRegistryBackend } from "../storage/registry-sqlite.js";
import type { RegistryBackend } from "../storage/registry-interface.js";
import { projectLaunchConfig } from "./project-config.js";

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function seededRegistry(
  rows: Array<{ root_path: string; session_config: string | null }>
): Promise<RegistryBackend> {
  tmp = mkdtempSync(join(tmpdir(), "pai-project-config-"));
  const db = new DatabaseCtor(join(tmp, "registry.db"));
  initializeSchema(db);
  const registry = new SQLiteRegistryBackend(db);

  let i = 0;
  for (const r of rows) {
    i += 1;
    const project = await registry.createProject({
      slug: `p${i}`,
      displayName: `P${i}`,
      rootPath: r.root_path,
      encodedDir: `enc-${i}`,
      type: "local",
      createdAt: 1,
      updatedAt: 1,
    });
    if (r.session_config !== null) {
      await registry.updateProjectSessionConfig(project.id, r.session_config);
    }
  }
  return registry;
}

describe("projectLaunchConfig", () => {
  it("null when no registered project covers the path", async () => {
    const registry = await seededRegistry([{ root_path: "/nowhere/near", session_config: null }]);
    expect(await projectLaunchConfig("/some/other/dir", registry)).toBeNull();
  });

  it("null when the matching project has no pin set", async () => {
    const registry = await seededRegistry([{ root_path: "/proj", session_config: null }]);
    expect(await projectLaunchConfig("/proj/sub", registry)).toBeNull();
  });

  it("reads mcp and tools from the matching project's session_config", async () => {
    const registry = await seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ mcp: ["aibroker", "pai"], tools: ["Read", "Bash"] }) },
    ]);
    expect(await projectLaunchConfig("/proj", registry)).toEqual({ mcp: ["aibroker", "pai"], tools: ["Read", "Bash"] });
    // a cwd below the project root matches too
    expect(await projectLaunchConfig("/proj/sub/dir", registry)).toEqual({
      mcp: ["aibroker", "pai"],
      tools: ["Read", "Bash"],
    });
  });

  it("the longest (most specific) root_path wins", async () => {
    const registry = await seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ mcp: ["outer"] }) },
      { root_path: "/proj/nested", session_config: JSON.stringify({ mcp: ["inner"] }) },
    ]);
    expect(await projectLaunchConfig("/proj/nested/deep", registry)).toEqual({ mcp: ["inner"], tools: undefined });
  });

  it("tolerates a pin with only one of mcp/tools set", async () => {
    const registry = await seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ tools: ["Read"] }) },
    ]);
    expect(await projectLaunchConfig("/proj", registry)).toEqual({ mcp: undefined, tools: ["Read"] });
  });
});
