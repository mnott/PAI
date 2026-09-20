/**
 * Tests for whisper-rules.md / advisor-mode.json path resolution and
 * migration — the two PAI_HOME files without a dedicated module of their own.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  whisperRulesPath,
  advisorModePath,
  migrateWhisperRules,
  migrateAdvisorMode,
} from "./pai-files.js";

const dirs: string[] = [];
function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "pai-files-"));
  dirs.push(d);
  return d;
}

const savedHome = process.env.HOME;
const savedPaiHome = process.env.PAI_HOME;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPaiHome === undefined) delete process.env.PAI_HOME;
  else process.env.PAI_HOME = savedPaiHome;
});

describe("whisperRulesPath / advisorModePath", () => {
  it("resolve under PAI_HOME when set, ignoring HOME entirely", () => {
    const dir = newDir();
    process.env.PAI_HOME = dir;
    expect(whisperRulesPath()).toBe(join(dir, "whisper-rules.md"));
    expect(advisorModePath()).toBe(join(dir, "advisor-mode.json"));
  });

  it("fall back to ~/.claude/<file> when PAI_HOME's copy doesn't exist yet", () => {
    const dir = newDir();
    delete process.env.PAI_HOME;
    process.env.HOME = dir;
    const oldWhisper = join(dir, ".claude", "whisper-rules.md");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(oldWhisper, "# 1. TEST\nrule one\n", "utf8");
    expect(whisperRulesPath()).toBe(oldWhisper);
  });
});

describe("migrateWhisperRules / migrateAdvisorMode", () => {
  it("move the old file into PAI_HOME, renaming the old one aside", () => {
    const dir = newDir();
    delete process.env.PAI_HOME;
    process.env.HOME = dir;
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const oldWhisper = join(dir, ".claude", "whisper-rules.md");
    const oldAdvisor = join(dir, ".claude", "advisor-mode.json");
    writeFileSync(oldWhisper, "# 1. TEST\nrule one\n", "utf8");
    writeFileSync(oldAdvisor, '{"weeklyBudgetPercent":10}', "utf8");

    const rw = migrateWhisperRules();
    const ra = migrateAdvisorMode();

    const newWhisper = join(dir, ".claude", "pai", "whisper-rules.md");
    const newAdvisor = join(dir, ".claude", "pai", "advisor-mode.json");
    expect(rw.toPath).toBe(newWhisper);
    expect(ra.toPath).toBe(newAdvisor);
    expect(readFileSync(newWhisper, "utf8")).toContain("rule one");
    expect(readFileSync(newAdvisor, "utf8")).toContain("weeklyBudgetPercent");
    expect(existsSync(oldWhisper)).toBe(false);
    expect(existsSync(oldAdvisor)).toBe(false);
    expect(whisperRulesPath()).toBe(newWhisper);
    expect(advisorModePath()).toBe(newAdvisor);
  });
});
