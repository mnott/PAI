/**
 * pane-policy.test.ts — one case per moved pane value: a user config override
 * (temp file via PAI_CONFIG_FILE, never the live config) changes the behaviour.
 * The shipped defaults keep the old values; the user's file wins.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { panePolicy } from "./pane-policy.js";
import { verifyPane } from "./pane.js";
import { escapePaneTitle } from "./pane-title.js";

const savedConfigFile = process.env.PAI_CONFIG_FILE;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-pane-policy-"));
  process.env.PAI_CONFIG_FILE = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigFile === undefined) delete process.env.PAI_CONFIG_FILE;
  else process.env.PAI_CONFIG_FILE = savedConfigFile;
});

const userYaml = (yaml: string) => writeFileSync(join(dir, "config.yaml"), yaml);

const paneJson = (cols: number, rows: number) =>
  JSON.stringify({ window: 1, bounds: [0, 0, 1, 1], tab: 1, tty: "/dev/ttys001", selectedTab: true, onScreen: true, cols, rows });

describe("pane policy from config", () => {
  it("ships the old values", () => {
    const p = panePolicy();
    expect(p).toMatchObject({ minCols: 40, minRows: 6, verifyTries: 25, verifyPollMs: 300, titleMax: 40, lingerSecs: 5, tailLines: 40 });
    expect(p.sessionMapMaxAgeMs).toBe(7 * 86_400_000);
    expect(p.runKeepMs).toBe(86_400_000);
    expect([p.helloWaitMs, p.killGraceMs, p.connectMs]).toEqual([20_000, 3000, 10_000]);
    expect([p.startGraceMs, p.endGraceMs, p.launchGraceMs]).toEqual([30_000, 60_000, 15_000]);
    expect([p.runPollMs, p.statusTickMs]).toEqual([250, 1000]);
  });

  it("titleMax shortens the pane title", () => {
    const long = "x".repeat(100);
    const before = escapePaneTitle(long).length;
    userYaml("panes:\n  titleMax: 10\n");
    expect(before).toBe(40);
    expect(escapePaneTitle(long).length).toBe(10);
  });

  it("verifyTries and verifyPollMs bound the verify retries", async () => {
    userYaml("panes:\n  verifyTries: 3\n  verifyPollMs: 1\n");
    let calls = 0;
    const run = async () => ((calls += 1), { stdout: paneJson(80, 24), stderr: "" });
    await expect(verifyPane("h", "p", "w", run, () => false)).rejects.toThrow(/not running/);
    expect(calls).toBe(3);
  });

  it("minCols and minRows mark nothing: a pane under them verifies clean", async () => {
    const run = async () => ({ stdout: paneJson(60, 10), stderr: "" });
    expect(await verifyPane("h", "p", "w", run, () => true)).not.toMatch(/SMALL|NOT SELECTED|MINIMISED|HIDDEN|OFF SCREEN/);
    userYaml("panes:\n  minCols: 80\n  minRows: 12\n");
    expect(await verifyPane("h", "p", "w", run, () => true)).not.toMatch(/SMALL|NOT SELECTED|MINIMISED|HIDDEN|OFF SCREEN/);
  });

  it.each([
    ["sessionMapMaxAgeDays: 1", "sessionMapMaxAgeMs", 86_400_000],
    ["statusTickMs: 500", "statusTickMs", 500],
    ["helloWaitSecs: 5", "helloWaitMs", 5000],
    ["killGraceSecs: 1", "killGraceMs", 1000],
    ["connectSecs: 2", "connectMs", 2000],
    ["lingerSecs: 2", "lingerSecs", 2],
    ["runPollMs: 50", "runPollMs", 50],
    ["runKeepHours: 2", "runKeepMs", 7_200_000],
    ["tailLines: 5", "tailLines", 5],
  ] as const)("%s reaches the policy", (line, key, want) => {
    userYaml(`panes:\n  ${line}\n`);
    expect(panePolicy()[key]).toBe(want);
  });

  it("audit graces come from panes.audit", () => {
    userYaml("panes:\n  audit:\n    startGraceSecs: 1\n    endGraceSecs: 2\n    launchGraceSecs: 3\n");
    const p = panePolicy();
    expect([p.startGraceMs, p.endGraceMs, p.launchGraceMs]).toEqual([1000, 2000, 3000]);
  });
});
