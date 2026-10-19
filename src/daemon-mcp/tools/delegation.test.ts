import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAI_INSTRUCTIONS } from "../instructions.js";
import { QueueStore, queueStatePath } from "../../workers/queue.js";
import { appendRunLog } from "../../workers/plan-runner.js";
import { planLockPath } from "../../workers/run-lock.js";
import { runLogPath } from "../../workers/plan.js";
import {
  planAmend, planRun, planSave, planStatusText, queueAccept, queueAdd, queueAgain, queueReject, queueReview, queueRun,
  type DelegationDeps, type PlanInput,
} from "./delegation.js";

let repo: string;
let deps: DelegationDeps;
const detach = vi.fn();
const accept = vi.fn();

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

const plan: PlanInput = {
  gate: "true",
  provider: "local",
  units: [
    {
      id: "u1",
      parts: [
        { id: "a", spec: "do a", files: ["a.ts"] },
        { id: "b", spec: "do b", files: ["b.ts"], depends_on: ["a"] },
      ],
    },
  ],
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "deleg-"));
  process.env.PAI_HOME = join(repo, "home");
  mkdirSync(join(repo, "home"), { recursive: true });
  detach.mockReset().mockReturnValue({ id: "run-1", pid: 1 });
  accept.mockReset();
  deps = {
    resolveProject: async () => repo,
    provider: () => ({ name: "local", cap: 2 }),
    dirtyPaths: async () => [],
    detach,
    accept,
    branchDiff: async () => "diff",
    origin: () => ({ name: "sess-1" }),
    now: () => Date.now(),
  };
});

describe("plan_save", () => {
  it("writes plan.yaml and specs and reports the schedule", async () => {
    const r = await planSave({ project: "p", name: "job1", plan }, deps);
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("saved and valid: 1 units, 2 parts");
    expect(readFileSync(join(repo, ".pai/plans/job1/specs/a.md"), "utf8")).toBe("do a\n");
    expect(readFileSync(join(repo, ".pai/plans/job1/plan.yaml"), "utf8")).toContain("depends_on");
  });
  it("returns the problems for an invalid plan", async () => {
    const bad = { ...plan, units: [{ id: "u1", parts: [{ id: "a", spec: "x", depends_on: ["zzz"] }] }] };
    const r = await planSave({ project: "p", name: "job1", plan: bad }, deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('unknown part "zzz"');
  });
  it("validates arguments", async () => {
    expect(text(await planSave({ project: "p", name: "../x", plan }, deps))).toContain("plan name");
    expect(text(await planSave({ project: "p", name: "j", plan: { ...plan, gate: " " } }, deps))).toContain("needs a gate");
    expect(text(await planSave({ project: "p", name: "j", plan: { ...plan, units: [] } }, deps))).toContain("at least one unit");
  });
});

describe("plan_run / plan_status / plan_amend", () => {
  it("fails for an unsaved plan", async () => {
    const r = await planRun({ project: "p", name: "nope" }, deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("save it first");
  });
  it("hands the run to the detached runner with the calling session", async () => {
    await planSave({ project: "p", name: "job2", plan }, deps);
    const r = await planRun({ project: "p", name: "job2", escalate: true }, deps);
    expect(text(r)).toContain("started in the background: 2 of 2 parts");
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach.mock.calls[0][0]).toMatchObject({
      kind: "plan",
      label: "job2",
      positional: [join(repo, ".pai/plans/job2/plan.yaml")],
      opts: { parallel: 2, escalate: "sonnet" },
      origin: { name: "sess-1" },
    });
    expect(existsSync(join(repo, ".pai/plans/job2/plan.yaml.session"))).toBe(false);
  });
  it("plan_status shows a live run and plan_run refuses a second start", async () => {
    await planSave({ project: "p", name: "job5", plan }, deps);
    const path = join(repo, ".pai/plans/job5/plan.yaml");
    appendRunLog(runLogPath(path), { event: "part-start", part: "a" });
    writeFileSync(planLockPath(path), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const st = text(await planStatusText({ project: "p", name: "job5" }, deps));
    expect(st).toMatch(new RegExp(`Running since \\d\\d:\\d\\d \\(pid ${process.pid}\\)`));
    expect(st).toContain("last event: part-start a");
    const r = await planRun({ project: "p", name: "job5" }, deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("already in progress since");
    expect(detach).not.toHaveBeenCalled();
  });
  it("refuses a dirty checkout", async () => {
    await planSave({ project: "p", name: "job3", plan }, deps);
    deps.dirtyPaths = async () => ["a.ts"];
    const r = await planRun({ project: "p", name: "job3" }, deps);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("uncommitted changes");
  });
  it("status names a needs-decision part with its failure tail, amend appends to the spec", async () => {
    await planSave({ project: "p", name: "job4", plan }, deps);
    const log = runLogPath(join(repo, ".pai/plans/job4/plan.yaml"));
    appendRunLog(log, { event: "run-start" });
    appendRunLog(log, { event: "needs-decision", part: "a", note: "tsc failed\nerror TS1" });
    appendRunLog(log, { event: "run-end" });
    const st = text(await planStatusText({ project: "p", name: "job4" }, deps));
    expect(st).toContain("0 of 2 parts done");
    expect(st).toContain("Part a needs a decision");
    expect(st).toContain("error TS1");
    const am = await planAmend({ project: "p", name: "job4", part: "a", spec_append: "use the new API" }, deps);
    expect(text(am)).toContain("Clarification added to part a");
    expect(readFileSync(join(repo, ".pai/plans/job4/specs/a.md"), "utf8")).toContain("## Clarification\nuse the new API");
    expect((await planAmend({ project: "p", name: "job4", part: "zz", spec_append: "x" }, deps)).isError).toBe(true);
    expect((await planAmend({ project: "p", name: "job4", part: "a", spec_append: " " }, deps)).isError).toBe(true);
  });
});

describe("queue_*", () => {
  const store = () => new QueueStore(queueStatePath(repo));
  it("add validates and queues", async () => {
    expect((await queueAdd({ project: "p", sentence: " " }, deps)).isError).toBe(true);
    expect((await queueAdd({ project: "p", sentence: "x", image: join(repo, "no.png") }, deps)).isError).toBe(true);
    const r = await queueAdd({ project: "p", sentence: "fix the tooltip", files: ["a.ts"] }, deps);
    expect(text(r)).toContain("Queued as q1");
    expect(store().get("q1")?.files).toEqual(["a.ts"]);
  });
  it("run starts pending items in the background", async () => {
    expect(text(await queueRun({ project: "p" }, deps))).toBe("Nothing is pending.");
    await queueAdd({ project: "p", sentence: "one" }, deps);
    const r = await queueRun({ project: "p" }, deps);
    expect(text(r)).toContain("Started 1 item (q1)");
    expect(detach.mock.calls[0][0]).toMatchObject({ kind: "queue", opts: { parallel: 2 }, cwd: repo, origin: { name: "sess-1" } });
  });
  it("review lists ready items in words; reject/again/accept act on them", async () => {
    await queueAdd({ project: "p", sentence: "one" }, deps);
    await queueAdd({ project: "p", sentence: "two" }, deps);
    const s = store();
    s.update("q1", { state: "running" });
    s.update("q1", { state: "ready", worker: "w1", diff: { files: 1, lines: 3, stat: " a.ts | 3 +++" }, gate: { ok: true, output: "" }, proof: "/tmp/p.png" });
    const rv = text(await queueReview({ project: "p" }, deps));
    expect(rv).toContain("1 ready for review");
    expect(rv).toContain("1 files, 3 lines changed");
    expect(rv).toContain("gate passed; proof: /tmp/p.png");
    expect(rv).toContain("q2: pending");

    accept.mockResolvedValue([{ id: "q1", ok: true, note: "merged" }]);
    expect(text(await queueAccept({ project: "p", ids: ["q1"] }, deps))).toBe("Merged: q1.");
    accept.mockResolvedValue([{ id: "q2", ok: false, note: "q2 is pending, not ready" }]);
    const bad = await queueAccept({ project: "p", ids: ["q2"] }, deps);
    expect(bad.isError).toBe(true);
    expect((await queueAccept({ project: "p", ids: [] }, deps)).isError).toBe(true);

    expect(text(await queueReject({ project: "p", ids: ["q2"], why: "wrong" }, deps))).toBe("Rejected: q2.");
    expect(store().get("q2")?.state).toBe("rejected");
    expect((await queueReject({ project: "p", ids: ["q9"] }, deps)).isError).toBe(true);
  });
  it("again requeues with the note", async () => {
    await queueAdd({ project: "p", sentence: "one" }, deps);
    const s = store();
    s.update("q1", { state: "running" });
    s.update("q1", { state: "ready", worker: "w1" });
    expect(text(await queueAgain({ project: "p", id: "q1", note: "still clipped" }, deps))).toContain("queued again");
    expect(store().get("q1")?.notes).toEqual(["still clipped"]);
    expect((await queueAgain({ project: "p", id: "q1", note: "" }, deps)).isError).toBe(true);
    expect((await queueAgain({ project: "p", id: "q7", note: "x" }, deps)).isError).toBe(true);
  });
});

describe("instructions", () => {
  it("describe the delegation flow", () => {
    for (const t of ["queue_add", "queue_run", "queue_review", "plan_save", "plan_run", "plan_status", "plan_amend"]) {
      expect(PAI_INSTRUCTIONS).toContain(t);
    }
  });
});
