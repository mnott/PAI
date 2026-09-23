import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
const { getRegistryBackend, closeStorage, __resetStorageForTests } = await import(
  "../../../storage/factory.js"
);

let paiHome: string;
let originalPaiHome: string | undefined;
let tmp: string;
let projDir: string;

const configFor = async (slug: string): Promise<{ mcp?: string[]; tools?: string[] }> => {
  const backend = await getRegistryBackend();
  const project = await backend.getProjectBySlug(slug);
  return project?.session_config ? JSON.parse(project.session_config) : {};
};

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "pai-mcp-tools-")));
  projDir = join(tmp, "proj");
  mkdirSync(projDir);
  paiHome = mkdtempSync(join(tmpdir(), "pai-mcp-tools-home-"));
  originalPaiHome = process.env.PAI_HOME;
  process.env.PAI_HOME = paiHome;
  __resetStorageForTests();

  const backend = await getRegistryBackend();
  await backend.createProject({
    slug: "proj",
    displayName: "Proj",
    rootPath: projDir,
    encodedDir: "enc-proj",
    createdAt: 1,
    updatedAt: 1,
  });

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await closeStorage();
  if (originalPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = originalPaiHome;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(paiHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("cmdMcp", () => {
  it("prints 'unset (all)' when no pin is set", async () => {
    const log = vi.spyOn(console, "log");
    await cmdMcp([], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("unset (all)");
  });

  it("sets, reads back, and clears", async () => {
    await cmdMcp(["aibroker,clickr"], { cwd: projDir });
    expect((await configFor("proj")).mcp).toEqual(["aibroker", "clickr"]);

    const log = vi.spyOn(console, "log");
    await cmdMcp([], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("aibroker,clickr");

    await cmdMcp([], { clear: true, cwd: projDir });
    expect((await configFor("proj")).mcp).toBeUndefined();
  });

  it("rejects an unknown MCP server name", async () => {
    await expect(cmdMcp(["nosuch"], { cwd: projDir })).rejects.toThrow(/unknown MCP server/);
    expect((await configFor("proj")).mcp).toBeUndefined();
  });

  it("errors when the directory matches no registered project", async () => {
    await cmdMcp([], { cwd: tmp }); // the temp root, not the registered "proj" subdir
    expect(process.exitCode).toBe(1);
  });
});

describe("cmdTools", () => {
  it("prints 'unset (all)' when no pin is set", async () => {
    const log = vi.spyOn(console, "log");
    await cmdTools([], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("unset (all)");
  });

  it("sets, reads back, and clears", async () => {
    await cmdTools(["Bash,Read,Edit"], { cwd: projDir });
    expect((await configFor("proj")).tools).toEqual(["Bash", "Read", "Edit"]);

    const log = vi.spyOn(console, "log");
    await cmdTools([], { cwd: projDir });
    expect(log).toHaveBeenCalledWith("Bash,Read,Edit");

    await cmdTools([], { clear: true, cwd: projDir });
    expect((await configFor("proj")).tools).toBeUndefined();
  });

  it("does not disturb an existing mcp pin", async () => {
    await cmdMcp(["pai"], { cwd: projDir });
    await cmdTools(["Read"], { cwd: projDir });
    expect(await configFor("proj")).toEqual({ mcp: ["pai"], tools: ["Read"] });
  });
});
