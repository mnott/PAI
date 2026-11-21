/**
 * alarm.ts — the growth alarm: a suite that grows past its governed core
 * (tests/KEPT.md) by more than tests.growthAlarm tests, or one holding more
 * than 500 tests, sends one notice into the session.
 * Both numbers are in the same unit: test call sites — it()/test() definitions,
 * what countTests counts and what the core is defined in. A runner that reports
 * expanded cases (vitest/jest) never feeds the alarm its inflated total:
 * describe.each / it.each rows are data, not tests to govern. HARD_CEILING is
 * 500 call sites for the same reason — a ceiling in expanded cases would be a
 * third unit.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { paiConfigFilePath } from "../daemon/config.js";
import { effectiveMainConfig } from "../config/shipped-defaults.js";
import { execFileSync } from "node:child_process";
import { countTests, isArtefactPath } from "./audit.js";
import { readKept } from "./kept.js";

export const DEFAULT_GROWTH_ALARM = 20;
export const HARD_CEILING = 500;

/** Expanded-case total a gate run printed (vitest/jest "Tests  N passed", pytest "N passed"); null when none. Internal only: the alarm works in call sites — see countTestSites. */
function parseExpandedCount(output: string): number | null {
  const v = /Tests:?\s+(?:\d+ \w+,\s*)*?(\d+) (?:passed|total)/.exec(output);
  if (v) {
    const tot = /Tests:?\s+.*?\((\d+)\)/.exec(output) ?? /Tests:.*?(\d+) total/.exec(output);
    return Number(tot?.[1] ?? v[1]);
  }
  const py = /(\d+) passed/.exec(output);
  return py ? Number(py[1]) : null;
}

/**
 * The alarm's unit: test call sites, the same one the governed core is defined
 * in (countTests over tests/KEPT.md). A runner reports vitest/jest by their
 * expanded cases (describe.each / it.each rows), which inflates the count vs
 * the core and made the alarm uncancellable; for those runners the tree's own
 * site count decides. Other runners (pytest, go) report call counts already.
 */
export function countTestSites(repo: string, gateOutput: string): number {
  const expanded = parseExpandedCount(gateOutput);
  if (expanded === null || /^\s*Tests:?\s/m.test(gateOutput)) return repoTestCount(repo);
  return expanded;
}

/** Call sites across every test file in the tree (the suite's true size), not just the kept core. git ls-files where there is a git tree, else a walk of the working copy. */
export function repoTestCount(repo: string): number {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0");
  } catch {
    files = walkTestFiles(repo);
  }
  let n = 0;
  for (const rel of files) {
    if (!rel || !/\.(test|spec)\.[a-z0-9]+$/.test(rel)) continue;
    try {
      n += countTests(readFileSync(join(repo, rel), "utf8"));
    } catch {
      // listed but unreadable (deleted since): not counted
    }
  }
  return n;
}

/** Test files under a directory tree, skipping vendored and scratch dirs. */
function walkTestFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git" || e.name.startsWith(".pai-scratch")) continue;
    const rel = e.name;
    if (e.isDirectory()) for (const f of walkTestFiles(join(dir, rel))) out.push(join(rel, f));
    else if (/\.(test|spec)\.[a-z0-9]+$/.test(e.name)) out.push(rel);
  }
  return out;
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

/** Test call sites in the files tests/KEPT.md lists — the unit of both the core and the alarm. */
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

/** Check one gate run: its test count in call sites plus the artefacts in the tree against the core. Null = quiet. */
export function checkGrowth(repo: string, gateOutput: string): string | null {
  const art = artefactCount(repo);
  if (parseExpandedCount(gateOutput) === null && art === 0) return null;
  return growthNotice(repo, countTestSites(repo, gateOutput) + art);
}
