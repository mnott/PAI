/**
 * Tests for the planner: plan-file validation, the prompt rules it carries,
 * and runPlanner itself with a mocked stage runner — waves of maxChildren,
 * children parented to the planner id, failure codes, bad plan files.
 * No worker is ever spawned.
 */

import { describe, it, expect } from "vitest";
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
