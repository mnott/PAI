/**
 * `pai audit tokens --record <dir>` writes a dated, numbered snapshot of the
 * combined report. Two consecutive records in the same directory must land
 * on run1/run2, append two lines to runs.md, and never leak the real home
 * directory into either the markdown or the JSON.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { redactHome, recordCombinedReport, type CombinedData } from "./audit.js";
import type { Finding } from "../../audit/severity.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-audit-record-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeData(findings: Finding[]): CombinedData {
  return {
    encoding: "cl100k_base",
    findings,
    files: { encoding: "cl100k_base", readings: [{ path: join(homedir(), ".claude", "CLAUDE.md"), tokens: 12, missing: false }], total: 12 },
    hooks: { encoding: "cl100k_base", settingsFiles: [], readings: [], totalsByEvent: {}, preToolUseHooks: [], preToolUseRewritesBash: false },
    session: null,
    spawn: {
      agentSubagents: { count: 0, min: null, median: null, max: null, medianOverhead: null, models: [] },
      workersInteractive: { count: 0, min: null, median: null, max: null, medianOverhead: null, models: [] },
      workersHeadless: { count: 0, min: null, median: null, max: null, medianOverhead: null, models: [] },
      readings: [],
    },
    daemon: {
      logPath: join(homedir(), ".claude", "logs", "daemon.log"),
      windowStart: null,
      spawnsByModel: {},
      kgParseFailures: 0,
      kgExtractionLines: 0,
      kgParseFailureRate: 0,
      jobCounts: {},
    },
    env: { processes: [], mcpServerCount: 0, settingsModel: null, settingsEffortLevel: null },
    schedule: { ttlSeconds: 300, agents: [], crontabLines: [] },
    skills: {
      encoding: "cl100k_base",
      entries: [],
      total: 0,
      totalsBySource: { skills: 0, commands: 0, plugins: 0 },
      countsBySource: { skills: 0, commands: 0, plugins: 0 },
      enabledTotal: 0,
      enabledTotalsBySource: { skills: 0, commands: 0, plugins: 0 },
      duplicates: [],
    },
    subagents: { encoding: "cl100k_base", entries: [] },
    mcp: { servers: [], liveProcesses: [] },
  };
}

describe("redactHome", () => {
  it("redacts the plain and the encoded home directory", () => {
    const out = redactHome("/home/someone/x and -home-someone-projects-y", "/home/someone");
    expect(out).toBe("~/x and ~-projects-y");
    expect(out).not.toContain("someone");
  });
});

describe("recordCombinedReport", () => {
  it("numbers the next run max+1, so a directory holding only run4 gets run5", () => {
    const dir = newDir();
    writeFileSync(join(dir, "2026-01-01-run4.md"), "# earlier run\n");
    recordCombinedReport(dir, fakeData([{ finding: "x", severity: "GREEN", evidence: "1" }]));
    const mdFiles = readdirSync(dir).filter((f) => /-run\d+\.md$/.test(f));
    expect(mdFiles.some((f) => f.endsWith("-run5.md"))).toBe(true);
    expect(mdFiles.some((f) => f.endsWith("-run2.md"))).toBe(false);
  });
  it("writes run1 then run2, appends two runs.md lines, and redacts the home directory", () => {
    const dir = newDir();
    const findings: Finding[] = [
      { finding: "example red", severity: "RED", evidence: `lives under ${homedir()}` },
      { finding: "example green", severity: "GREEN", evidence: "fine" },
    ];

    recordCombinedReport(dir, fakeData(findings));
    recordCombinedReport(dir, fakeData(findings));

    const mdFiles = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "runs.md");
    const jsonFiles = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(mdFiles.some((f) => f.includes("-run1.md"))).toBe(true);
    expect(mdFiles.some((f) => f.includes("-run2.md"))).toBe(true);
    expect(jsonFiles.some((f) => f.includes("-run1.json"))).toBe(true);
    expect(jsonFiles.some((f) => f.includes("-run2.json"))).toBe(true);

    const runsMd = readFileSync(join(dir, "runs.md"), "utf8");
    const runLines = runsMd.split("\n").filter((l) => l.startsWith("- "));
    expect(runLines.length).toBe(2);
    expect(runLines[0]).toContain("run1");
    expect(runLines[1]).toContain("run2");
    expect(runLines[0]).toContain("1 RED, 0 AMBER, 1 GREEN");

    for (const f of [...mdFiles, ...jsonFiles]) {
      const content = readFileSync(join(dir, f), "utf8");
      expect(content.includes(homedir())).toBe(false);
    }
  });
});
