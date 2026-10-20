/** Every process gets its own pane in the host tab: the plan runner and each of its workers; never a window, never a tab. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVerifiedPane, type PaneOps, type PaneSeam } from "./pane.js";
import { openPlanPane, workerArgs } from "./plan-deps.js";
import { PlanTracker, followPlanLog, planRunEnded, planStatusFile } from "./plan-status.js";
import { requireVisiblePane, buildRunEnv } from "./run.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const UID = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
const TERM = `w5t0p0:${UID}`;
const env = { ITERM_SESSION_ID: TERM } as NodeJS.ProcessEnv;
const ops: PaneOps = { listIterm: async () => [], closeIterm: async () => true, listTmux: () => [], closeTmux: () => true };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-planpane-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("PAI_WORKER", "");
  vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function seam(small = false): PaneSeam & { splits: string[] } {
  const splits: string[] = [];
  return {
    splits,
    hostSelected: async () => true,
    split: async (_l, _c, wid) => {
      splits.push(wid);
      return { message: "pane opened", session: `S${splits.length}` };
    },
    verify: async () => {
      return small ? "window 7 tab 1/1, pane 26x14 SMALL (< 40x6)" : "window 7 tab 1/1, pane 80x20";
    },
  };
}

describe("panes in the host tab", () => {
  it("two plan runs with one worker each: 4 panes, all splits of the host tab", async () => {
    const s = seam();
    const open: typeof openVerifiedPane = (l, c, w, t, _e, o) => openVerifiedPane(l, c, w, t, env, o, s);
    const host = async () => ({ term: TERM });
    const a = new PlanTracker(dir, "job-a", 1, 0);
    const b = new PlanTracker(dir, "job-b", 1, 0);
    expect(await openPlanPane(dir, a, open, host)).toBe(true);
    expect(await openPlanPane(dir, b, open, host)).toBe(true);
    await openVerifiedPane(dir, config, "w-a1", TERM, env, ops, s);
    await openVerifiedPane(dir, config, "w-b1", TERM, env, ops, s);
    expect(s.splits).toEqual(["plan-job-a", "plan-job-b", "w-a1", "w-b1"]);
  });

  it("crowded tab: the worker starts in a small pane, never a tab or window", async () => {
    const s = seam(true);
    await expect(openVerifiedPane(dir, config, "w-1", TERM, env, ops, s)).resolves.toContain("SMALL");
    expect(s.splits).toHaveLength(1);
  });

  it("a plan worker that asks for no pane starts without one, not refused", async () => {
    vi.stubEnv("PAI_PLAN_PANE", "plan-job-a");
    vi.stubEnv("PAI_PLAN_PART", "p1");
    const t = new PlanTracker(dir, "job-a", 1, 0);
    t.hasPane = true;
    t.setRunning(["p1"]);
    await expect(requireVisiblePane(dir, config as never, "w-1", TERM, true, false, join(dir, "ledger"))).resolves.toBe(false);
  });

  it("the model process env carries no plan variables", () => {
    const e = buildRunEnv({ native: true, models: { default: "m" }, env: {} } as never, true);
    expect(e.PAI_PLAN_PANE).toBeUndefined();
  });

  it("workerArgs unchanged", () => {
    expect(workerArgs({ label: "l", provider: "p", tier: "opus", priority: undefined } as never, "s", "r")).toContain("--worktree");
  });
});

describe("plan follower", () => {
  it("exits once the runner is dead", async () => {
    const t = new PlanTracker(dir, "job-a", 1, 0);
    t.log("hello");
    expect(planRunEnded(dir, t.id)).toBe(false);
    const f = planStatusFile(dir, t.id);
    const st = JSON.parse((await import("node:fs")).readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...st, pid: 2 ** 22 + 12345 }));
    expect(planRunEnded(dir, t.id)).toBe(true);
    const out: string[] = [];
    await followPlanLog(dir, t.id, (x) => out.push(x), () => planRunEnded(dir, t.id), 10);
    expect(out.join("")).toContain("hello");
  });
});
