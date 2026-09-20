import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../registry/db.js";
import { projectLaunchConfig } from "./project-config.js";

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function seededRegistry(rows: Array<{ root_path: string; session_config: string | null }>): string {
  tmp = mkdtempSync(join(tmpdir(), "pai-project-config-"));
  const dbPath = join(tmp, "registry.db");
  const db = openRegistry(dbPath);
  let i = 0;
  for (const r of rows) {
    i += 1;
    db.prepare(
      `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, session_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'local', 'active', ?, 1, 1)`
    ).run(`p${i}`, `P${i}`, r.root_path, `enc-${i}`, r.session_config);
  }
  db.close();
  return dbPath;
}

describe("projectLaunchConfig", () => {
  it("null when no registered project covers the path", () => {
    const dbPath = seededRegistry([{ root_path: "/nowhere/near", session_config: null }]);
    expect(projectLaunchConfig("/some/other/dir", dbPath)).toBeNull();
  });

  it("null when the matching project has no pin set", () => {
    const dbPath = seededRegistry([{ root_path: "/proj", session_config: null }]);
    expect(projectLaunchConfig("/proj/sub", dbPath)).toBeNull();
  });

  it("reads mcp and tools from the matching project's session_config", () => {
    const dbPath = seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ mcp: ["aibroker", "pai"], tools: ["Read", "Bash"] }) },
    ]);
    expect(projectLaunchConfig("/proj", dbPath)).toEqual({ mcp: ["aibroker", "pai"], tools: ["Read", "Bash"] });
    // a cwd below the project root matches too
    expect(projectLaunchConfig("/proj/sub/dir", dbPath)).toEqual({
      mcp: ["aibroker", "pai"],
      tools: ["Read", "Bash"],
    });
  });

  it("the longest (most specific) root_path wins", () => {
    const dbPath = seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ mcp: ["outer"] }) },
      { root_path: "/proj/nested", session_config: JSON.stringify({ mcp: ["inner"] }) },
    ]);
    expect(projectLaunchConfig("/proj/nested/deep", dbPath)).toEqual({ mcp: ["inner"], tools: undefined });
  });

  it("tolerates a pin with only one of mcp/tools set", () => {
    const dbPath = seededRegistry([
      { root_path: "/proj", session_config: JSON.stringify({ tools: ["Read"] }) },
    ]);
    expect(projectLaunchConfig("/proj", dbPath)).toEqual({ mcp: undefined, tools: ["Read"] });
  });
});
