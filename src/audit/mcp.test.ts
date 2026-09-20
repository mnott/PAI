import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditMcp, shouldScanTranscript, liveProcessLoadsServer } from "./mcp.js";

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeTmp(): { home: string; cwd: string } {
  tmp = mkdtempSync(join(tmpdir(), "pai-audit-mcp-"));
  const home = join(tmp, "home");
  const cwd = join(tmp, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

describe("auditMcp", () => {
  it("collects global and project mcpServers, tags disabled", async () => {
    const { home, cwd } = makeTmp();
    const claudeJson = {
      mcpServers: { alpha: { command: "alpha-bin" }, beta: { command: "beta-bin" } },
      projects: {
        [cwd]: {
          mcpServers: {},
          disabledMcpServers: ["beta"],
        },
      },
    };
    writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson));

    const report = await auditMcp({ cwd, homeDir: home, projectsDbPath: join(tmp, "no-registry.db") });

    const alpha = report.servers.find((s) => s.server === "alpha");
    const beta = report.servers.find((s) => s.server === "beta");
    expect(alpha?.configuredIn).toContain("global");
    expect(alpha?.disabled).toBe(false);
    expect(beta?.configuredIn).toContain("global");
    expect(beta?.disabled).toBe(true);
    expect(alpha?.pinned).toBeNull();
  });

  it("collects servers from project .mcp.json", async () => {
    const { home, cwd } = makeTmp();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { gamma: { command: "gamma-bin" } } }));

    const report = await auditMcp({ cwd, homeDir: home, projectsDbPath: join(tmp, "no-registry.db") });

    const gamma = report.servers.find((s) => s.server === "gamma");
    expect(gamma).toBeDefined();
    expect(gamma?.configuredIn).toContain("project .mcp.json");
  });

  it("toolsExposed stays UNKNOWN when connect is not passed", async () => {
    const { home, cwd } = makeTmp();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "alpha-bin" } } })
    );

    const report = await auditMcp({ cwd, homeDir: home, projectsDbPath: join(tmp, "no-registry.db") });

    expect(report.servers.length).toBeGreaterThan(0);
    for (const row of report.servers) {
      expect(row.toolsExposed).toBe("UNKNOWN");
    }
  });

  it("counts distinct tools and total calls from 30-day transcript usage", async () => {
    const { home, cwd } = makeTmp();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
    const transcriptsDir = join(tmp, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "1", name: "mcp__alpha__do_thing" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "2", name: "mcp__alpha__other_thing" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "3", name: "mcp__alpha__do_thing" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "4", name: "Bash", input: {} }] },
      }),
    ];
    writeFileSync(join(transcriptsDir, "session.jsonl"), lines.join("\n") + "\n");

    const report = await auditMcp({
      cwd,
      homeDir: home,
      projectsDbPath: join(tmp, "no-registry.db"),
      transcriptsDir,
    });

    const alpha = report.servers.find((s) => s.server === "alpha");
    expect(alpha?.toolsUsed30d).toBe(2);
    expect(alpha?.calls30d).toBe(3);
  });

  it("ignores transcript usage older than 30 days", async () => {
    const { home, cwd } = makeTmp();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
    const transcriptsDir = join(tmp, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "1", name: "mcp__stale__do_thing" }] },
    });
    const filePath = join(transcriptsDir, "old-session.jsonl");
    writeFileSync(filePath, line + "\n");

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, oldTime, oldTime);

    const report = await auditMcp({
      cwd,
      homeDir: home,
      projectsDbPath: join(tmp, "no-registry.db"),
      transcriptsDir,
    });

    const stale = report.servers.find((s) => s.server === "stale");
    expect(stale).toBeUndefined();
  });

  it("does not throw end-to-end and returns an array of servers", async () => {
    const { home, cwd } = makeTmp();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));

    const report = await auditMcp({ cwd, homeDir: home, projectsDbPath: join(tmp, "no-registry.db") });

    expect(Array.isArray(report.servers)).toBe(true);
    expect(Array.isArray(report.liveProcesses)).toBe(true);
  });
});

describe("shouldScanTranscript", () => {
  const now = Date.now();

  it("false when file is too big", () => {
    expect(shouldScanTranscript({ size: 60 * 1024 * 1024, mtimeMs: now }, now)).toBe(false);
  });

  it("false when file is too old", () => {
    expect(shouldScanTranscript({ size: 1024, mtimeMs: now - 40 * 24 * 60 * 60 * 1000 }, now)).toBe(false);
  });

  it("true when file is small and fresh", () => {
    expect(shouldScanTranscript({ size: 1024, mtimeMs: now - 1000 }, now)).toBe(true);
  });
});

describe("liveProcessLoadsServer", () => {
  const allConfigured = ["alpha", "beta", "gamma"];

  it("servers===null loads every configured name", () => {
    expect(liveProcessLoadsServer({ servers: null }, "alpha", allConfigured)).toBe(true);
    expect(liveProcessLoadsServer({ servers: null }, "beta", allConfigured)).toBe(true);
  });

  it("servers===[] loads nothing", () => {
    expect(liveProcessLoadsServer({ servers: [] }, "alpha", allConfigured)).toBe(false);
  });

  it("servers=[x] loads only x", () => {
    expect(liveProcessLoadsServer({ servers: ["alpha"] }, "alpha", allConfigured)).toBe(true);
    expect(liveProcessLoadsServer({ servers: ["alpha"] }, "beta", allConfigured)).toBe(false);
  });
});
