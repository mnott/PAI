/**
 * alarm.ts — the growth alarm: a suite that grows past its governed core
 * (tests/KEPT.md) by more than tests.growthAlarm tests, or a gate run that
 * reports more than 500 tests, sends one notice into the session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { execFileSync } from "node:child_process";
import { countTests, isArtefactPath } from "./audit.js";
import { readKept } from "./kept.js";

export const DEFAULT_GROWTH_ALARM = 20;
export const HARD_CEILING = 500;

/** Test count a gate run printed (vitest/jest "Tests  N passed", pytest "N passed", go "ok" lines are not counted); null when none. */
export function parseTestCount(output: string): number | null {
  const v = /Tests:?\s+(?:\d+ \w+,\s*)*?(\d+) (?:passed|total)/.exec(output);
  if (v) {
    const tot = /Tests:?\s+.*?\((\d+)\)/.exec(output) ?? /Tests:.*?(\d+) total/.exec(output);
    return Number(tot?.[1] ?? v[1]);
  }
  const py = /(\d+) passed/.exec(output);
  return py ? Number(py[1]) : null;
}

export function growthAlarmLimit(): number {
  try {
    const t = effectiveMainConfig(paiConfigFilePath()).tests as Record<string, unknown> | undefined;
    const n = t?.growthAlarm;
    return typeof n === "number" && n >= 0 ? n : DEFAULT_GROWTH_ALARM;
  } catch {
    return DEFAULT_GROWTH_ALARM;
  }
}

/** Tests in the files tests/KEPT.md lists. */
export function coreTestCount(repo: string): number {
  return readKept(repo).reduce((n, k) => {
    const p = join(repo, k.file);
    return n + (existsSync(p) ? countTests(readFileSync(p, "utf8")) : 0);
  }, 0);
}

/** The notice text, or null when the count is within bounds. */
export function growthNotice(repo: string, count: number, core = coreTestCount(repo), limit = growthAlarmLimit()): string | null {
  const over = core > 0 && count > core + limit;
  if (!over && count <= HARD_CEILING) return null;
  const why = over ? `${count - core} over its governed core of ${core}` : `over ${HARD_CEILING}`;
  return `[pai tests] ${basename(repo)} has ${count} tests (${why}). Run \`clean up tests\`.`;
}

/** Simulator/UI run outputs (.xcresult, recordings, screenshots) the repo holds; they count towards the alarm like tests. */
export function artefactCount(repo: string): number {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const keptFiles = new Set(readKept(repo).map((k) => k.file));
    return tracked.split("\0").filter((f) => f && isArtefactPath(f) && !keptFiles.has(f)).length;
  } catch {
    return 0;
  }
}

/** Check one gate run: its reported test count plus the artefacts in the tree against the core. Null = quiet. */
export function checkGrowth(repo: string, gateOutput: string): string | null {
  const n = parseTestCount(gateOutput);
  const art = artefactCount(repo);
  if (n === null && art === 0) return null;
  return growthNotice(repo, (n ?? coreTestCount(repo)) + art);
}
