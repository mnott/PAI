import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * cmdMcp / cmdTools read the project registered at (or above) the current
 * directory, same lookup `pai projects here` uses — never a live
 * ~/.claude.json or workers.yaml: both dependencies are mocked so the round
 * trip is deterministic (docs/architecture-decisions.md: "Worker Specs Ban
 * Live Config Writes" applies to reads that would otherwise be
 * environment-dependent too).
 */

vi.mock("../../../workers/config.js", () => ({
  readWorkersSection: () => ({ workers: { mcpSets: {} } }),
}));
vi.mock("../../../workers/mcp.js", () => ({
  expandMcpNames: (names: string[]) => {
    const known = ["aibroker", "clickr", "coogle", "pai", "todoist", "webfetch"];
    const flat = names.flatMap((n) => n.split(",").map((s) => s.trim()).filter(Boolean));
    const unknown = flat.filter((n) => !known.includes(n));
    if (unknown.length) {
      throw new Error(`unknown MCP server(s): ${unknown.join(", ")}. Available: ${known.join(", ")}`);
    }
    return [...new Set(flat)];
  },
}));

const { cmdMcp, cmdTools } = await import("./session-config.js");

let db: Database.Database;
let tmp: string;
let projDir: string;

const configFor = (slug: string): { mcp?: string[]; tools?: string[] } => {
  const row = db
    .prepare("SELECT session_config FROM projects WHERE slug = ?")
    .get(slug) as { session_config: string | null };
  return row.session_config ? JSON.parse(row.session_config) : {};
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-mcp-tools-")));
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      encoded_dir TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'active',
      session_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE aliases (
      alias TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      date TEXT
    );
  `);
  db.prepare(
    `INSERT INTO projects (slug, display_name, root_path, encoded_dir, type, status, created_at, updated_at)
     VALUES ('proj', 'Proj', ?, 'enc-proj', 'local', 'active', 1, 1)`
  ).run(projDir);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("cmdMcp", () => {
  it("prints 'unset (all)' when no pin is set", () => {
    const log = vi.spyOn(console, "log");
    cmdMcp(db, [], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("unset (all)");
  });

  it("sets, reads back, and clears", () => {
    cmdMcp(db, ["aibroker,clickr"], { cwd: projDir });
    expect(configFor("proj").mcp).toEqual(["aibroker", "clickr"]);

    const log = vi.spyOn(console, "log");
    cmdMcp(db, [], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("aibroker,clickr");

    cmdMcp(db, [], { clear: true, cwd: projDir });
    expect(configFor("proj").mcp).toBeUndefined();
  });

  it("rejects an unknown MCP server name", () => {
    expect(() => cmdMcp(db, ["nosuch"], { cwd: projDir })).toThrow(/unknown MCP server/);
    expect(configFor("proj").mcp).toBeUndefined();
  });

  it("errors when the directory matches no registered project", () => {
    cmdMcp(db, [], { cwd: tmp }); // the temp root, not the registered "proj" subdir
    expect(process.exitCode).toBe(1);
  });
});

describe("cmdTools", () => {
  it("prints 'unset (all)' when no pin is set", () => {
    const log = vi.spyOn(console, "log");
    cmdTools(db, [], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("unset (all)");
  });

  it("sets, reads back, and clears", () => {
    cmdTools(db, ["Bash,Read,Edit"], { cwd: projDir });
    expect(configFor("proj").tools).toEqual(["Bash", "Read", "Edit"]);

    const log = vi.spyOn(console, "log");
    cmdTools(db, [], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("Bash,Read,Edit");

    cmdTools(db, [], { clear: true, cwd: projDir });
    expect(configFor("proj").tools).toBeUndefined();
  });

  it("does not disturb an existing mcp pin", () => {
    cmdMcp(db, ["pai"], { cwd: projDir });
    cmdTools(db, ["Read"], { cwd: projDir });
    expect(configFor("proj")).toEqual({ mcp: ["pai"], tools: ["Read"] });
  });
});
