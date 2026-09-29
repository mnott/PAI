/**
 * Tests for the planner: plan-file validation, the prompt rules it carries,
 * and runPlanner itself with a mocked stage runner — waves of maxChildren,
 * children parented to the planner id, failure codes, bad plan files.
 * No worker is ever spawned.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TASKS,
  MIN_TASKS,
  planPathFor,
  plannerPrompt,
  runPlanner,
  taskPrompt,
  validatePlan,
  type PlannerTask,
} from "./planner.js";
import { parseRunnerArgs } from "./args.js";
import type { RunOptions } from "./run.js";
import { addWorktree, git, recordWorktree } from "./worktree.js";
import { loadStatus, newWorkerId, saveStatus, type WorkerStatus } from "./status.js";

const dir = mkdtempSync(join(tmpdir(), "pai-planner-test-"));

function task(n: number, over: Partial<PlannerTask> = {}): PlannerTask {
  return { title: `task ${n}`, brief: `do thing ${n}`, ...over };
}

describe("validatePlan", () => {
  it("accepts a full plan and trims it to the known fields", () => {
    const tasks = validatePlan({
      tasks: [
        {
          title: " one ",
          brief: " brief ",
          class: "research",
          files: ["a.ts"],
          acceptance: ["a.ts exists"],
          junk: "dropped",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        title: "one",
        brief: "brief",
        class: "research",
        files: ["a.ts"],
        acceptance: ["a.ts exists"],
      },
    ]);
  });
  it("accepts a single task (an explicit smaller goal count wins)", () => {
    expect(validatePlan({ tasks: [task(1)] })).toHaveLength(1);
  });
  it("drops non-string files/acceptance instead of failing", () => {
    const tasks = validatePlan({ tasks: [{ ...task(1), files: [7], acceptance: "nope" as unknown as string[] }] });
    expect(tasks[0].files).toBeUndefined();
    expect(tasks[0].acceptance).toBeUndefined();
  });
  it("refuses more than MAX_TASKS tasks", () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => task(i + 1));
    expect(() => validatePlan({ tasks: many })).toThrow(new RegExp(`maximum is ${MAX_TASKS}`));
  });
  it("refuses non-objects, missing arrays, empty arrays, taskless tasks", () => {
    expect(() => validatePlan("nope")).toThrow(/JSON object/);
    expect(() => validatePlan({})).toThrow(/"tasks" array/);
    expect(() => validatePlan({ tasks: [] })).toThrow(/no tasks/);
    expect(() => validatePlan({ tasks: [{ brief: "b" }] })).toThrow(/needs a non-empty "title"/);
    expect(() => validatePlan({ tasks: [{ title: "t" }] })).toThrow(/needs a non-empty "brief"/);
    expect(() => validatePlan({ tasks: ["x"] })).toThrow(/task 1 must be an object/);
  });
});

describe("plannerPrompt / taskPrompt", () => {
  it("carries the prompt rules, the quantity range, the plan path and the cap", () => {
    const p = plannerPrompt("ship it", "/tmp/plans/p1.json", 3);
    expect(p).toMatch(/Write the plan with the Write tool to \/tmp\/plans\/p1\.json/);
    expect(p).toMatch(new RegExp(`between ${MIN_TASKS} and ${MAX_TASKS} sub-tasks`));
    expect(p).toMatch(/At most 3 of them run at a time/);
    expect(p).toMatch(/Domain-specific instructions only/);
    expect(p).toMatch(/Constraints over step lists/);
    expect(p).toMatch(/Explicit quantity ranges/);
    expect(p).toMatch(/No checkbox style/);
    expect(p).toMatch(/its own worktree of the same repository/);
    expect(p).toMatch(/never an absolute path or a worktree/);
    expect(p).toMatch(/## Goal/);
    expect(p).toMatch(/ship it/);
  });
  it("gives each sub-task its slice: title, brief, files, acceptance, goal as context", () => {
    const p = taskPrompt(
      "the goal",
      { ...task(2), files: ["f.ts"], acceptance: ["f.ts compiles"] },
      1,
      3
    );
    expect(p).toMatch(/sub-task 2 of 3/);
    expect(p).toMatch(/# task 2/);
    expect(p).toMatch(/do thing 2/);
    expect(p).toMatch(/Files likely touched: f\.ts/);
    expect(p).toMatch(/- f\.ts compiles/);
    expect(p).toMatch(/context only/);
  });
});

/** A stage-runner mock: phase 1 writes the plan file the prompt names, phases
 *  2+ record parent/class/concurrency. Failures and plan contents injectable. */
function mockStage(plan: unknown[], over: { failTask?: number; phase1Rc?: number; noPlan?: boolean; badPlan?: boolean } = {}) {
  const seen: { parent?: string; className?: string; prompt: string; id?: string }[] = [];
  let live = 0;
  let peak = 0;
  const runStage = async (opts: RunOptions): Promise<number> => {
    const prompt = parseRunnerArgs(opts.claudeArgs).prompt ?? "";
    if (opts._planner) {
      const m = prompt.match(/Write the plan with the Write tool to (\S+) /);
      if (m && !over.noPlan) {
        const raw = over.badPlan ? "{damaged" : JSON.stringify({ tasks: plan });
        writeFileSync(m[1], raw, "utf8");
      }
      return over.phase1Rc ?? 0;
    }
    seen.push({ parent: opts.parent, className: opts.className, prompt, id: opts.id });
    const nth = seen.length; // captured before the await: concurrent calls all push first
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return nth === over.failTask ? 1 : 0;
  };
  return { runStage, seen, peak: () => peak };
}

function opts(): RunOptions {
  return { claudeArgs: ["-p", "the goal"], quiet: true };
}

describe("runPlanner", () => {
  it("runs the sub-tasks as children of the planner in waves of maxChildren", async () => {
    const plan = [
      task(1),
      { ...task(2), class: "research" },
      task(3),
      task(4),
      task(5),
    ];
    const mock = mockStage(plan);
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 2 });
    expect(rc).toBe(0);
    expect(mock.seen).toHaveLength(5);
    // every child's parent is the planner id the plan file is named after
    const parents = [...new Set(mock.seen.map((s) => s.parent))];
    expect(parents).toHaveLength(1);
    const plannerId = parents[0]!;
    expect(planPathFor(dir, plannerId)).toBe(join(dir, "plans", `${plannerId}.json`));
    expect(existsSync(planPathFor(dir, plannerId))).toBe(true);
    // class from the task, default implement
    expect(mock.seen.map((s) => s.className)).toEqual(["implement", "research", "implement", "implement", "implement"]);
    // never more than maxChildren concurrently
    expect(mock.peak()).toBeLessThanOrEqual(2);
    // the plan file still holds the validated tasks
    const saved = JSON.parse(readFileSync(planPathFor(dir, plannerId), "utf8"));
    expect(saved.tasks).toHaveLength(5);
  });

  it("returns 1 when a sub-task fails", async () => {
    const mock = mockStage([task(1), task(2), task(3)], { failTask: 2 });
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 4 });
    expect(rc).toBe(1);
  });

  it("returns the phase-1 code unchanged when the planner worker fails", async () => {
    const mock = mockStage([], { phase1Rc: 42 });
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 2 });
    expect(rc).toBe(42);
    expect(mock.seen).toHaveLength(0);
  });

  it("fails with 1 when no plan file was written", async () => {
    const mock = mockStage([], { noPlan: true });
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 2 });
    expect(rc).toBe(1);
    expect(mock.seen).toHaveLength(0);
  });

  it("fails with 1 on a damaged plan file", async () => {
    const mock = mockStage([], { badPlan: true });
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 2 });
    expect(rc).toBe(1);
    expect(mock.seen).toHaveLength(0);
  });
});

/**
 * The merge phase against a real throwaway git repo: the planner worker gets
 * its own worktree (built with the real worktree.ts helpers, exactly like
 * run.ts would), each child gets one off the planner's worktree instead of
 * the operator's cwd, and `runPlanner` merges finished children into the
 * planner's branch via the same `mergeWorker` `pai worker merge` uses.
 */
function baseStatus(id: string, cwd: string): WorkerStatus {
  return {
    id,
    pid: process.pid,
    label: `label ${id}`,
    cwd,
    term: "",
    provider: "testprov",
    model: "test-1",
    state: "done",
    started: "2026-09-29 10:00:00",
    updated: "2026-09-29 10:00:00",
    turns: 0,
    tools: 0,
    last: "",
    rc: 0,
    secs: 1,
  };
}

/** A throwaway git repo the planner's own worktree branches from. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "pai-planner-merge-repo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "worker test"]);
  writeFileSync(join(repo, "shared.txt"), "original\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

/**
 * Stage-runner mock that does real git work: phase 1 gives the planner its
 * own worktree off `repo` (mirroring run.ts's worktreeWanted path for class
 * "plan"); each child gets a worktree off whatever cwd it was handed (the
 * planner's worktree, once `runPlanner` redirects it there) and commits the
 * edit `edit(wtDir, taskIndex)` makes, in task order — `maxChildren: 1` in
 * the tests below keeps that order free of wave concurrency.
 */
function mockGitStage(repo: string, plan: unknown[], edit: (wtDir: string, taskIndex: number) => void) {
  const childIds: string[] = [];
  let plannerId = "";
  let taskIndex = 0;
  const runStage = async (opts: RunOptions): Promise<number> => {
    const prompt = parseRunnerArgs(opts.claudeArgs).prompt ?? "";
    if (opts._planner) {
      plannerId = opts.id!;
      const m = prompt.match(/Write the plan with the Write tool to (\S+) /);
      if (m) writeFileSync(m[1], JSON.stringify({ tasks: plan }), "utf8");
      const info = addWorktree(dir, plannerId, repo);
      recordWorktree(dir, baseStatus(plannerId, repo), info, true);
      return 0;
    }
    const id = newWorkerId();
    opts.onWorkerStart?.(id);
    const cwd = opts.cwd!;
    const info = addWorktree(dir, id, cwd);
    const idx = taskIndex++;
    edit(info.dir, idx);
    git(info.dir, ["add", "-A"]);
    git(info.dir, ["commit", "-q", "-m", `child ${idx}`]);
    recordWorktree(dir, baseStatus(id, cwd), info, true);
    childIds.push(id);
    return 0;
  };
  return { runStage, childIds, getPlannerId: () => plannerId };
}

describe("runPlanner: merging children into the planner's own worktree", () => {
  it("merges two children that touch different files, both", async () => {
    const repo = initRepo();
    const mock = mockGitStage(repo, [task(1), task(2)], (wtDir, idx) => {
      writeFileSync(join(wtDir, `file${idx}.txt`), `child ${idx} content\n`, "utf8");
    });
    const rc = await runPlanner(opts(), { runStage: mock.runStage, logDir: dir, maxChildren: 1 });
    expect(rc).toBe(0);
    expect(mock.childIds).toHaveLength(2);

    const plannerSt = loadStatus(dir, mock.getPlannerId());
    const wtDir = plannerSt!.worktreeDir!;
    expect(readFileSync(join(wtDir, "file0.txt"), "utf8")).toBe("child 0 content\n");
    expect(readFileSync(join(wtDir, "file1.txt"), "utf8")).toBe("child 1 content\n");

    for (const id of mock.childIds) {
      expect(loadStatus(dir, id)?.merged).toBe(true);
    }
    // no merge left in progress on the planner's branch
    expect(() => git(wtDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toThrow();
  });

  it("merges the first of two children editing the same line, reports the second as conflicted with the path, keeps the planner branch clean", async () => {
    const repo = initRepo();
    const mock = mockGitStage(repo, [task(1), task(2)], (wtDir, idx) => {
      writeFileSync(join(wtDir, "shared.txt"), `child ${idx} edit\n`, "utf8");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const rc = await runPlanner(
      { claudeArgs: ["-p", "the goal", "--output-format", "json"] },
      { runStage: mock.runStage, logDir: dir, maxChildren: 1 }
    );
    expect(rc).toBe(1);
    expect(mock.childIds).toHaveLength(2);
    const [firstId, secondId] = mock.childIds;

    const plannerSt = loadStatus(dir, mock.getPlannerId());
    const wtDir = plannerSt!.worktreeDir!;
    // first child merged: its content landed on the planner branch
    expect(loadStatus(dir, firstId)?.merged).toBe(true);
    expect(readFileSync(join(wtDir, "shared.txt"), "utf8")).toBe("child 0 edit\n");

    // second child conflicted: not merged, branch left intact
    const secondSt = loadStatus(dir, secondId);
    expect(secondSt?.merged).toBeFalsy();
    expect(secondSt?.branch).toBeTruthy();
    expect(git(wtDir, ["branch", "--list", secondSt!.branch!])).not.toBe("");

    // the planner's own branch is clean: no merge in progress
    expect(() => git(wtDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).toThrow();

    // the report names the conflict and its path
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();
    const openLines: string[] = payload.report.open;
    expect(openLines.some((l) => l.includes(secondId) && l.includes("shared.txt"))).toBe(true);
  });
});
