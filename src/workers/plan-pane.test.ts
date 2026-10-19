/** One pane per plan run, never a window; plan workers open none; the plan pane follows their transcripts. */
import { mkdirSync, mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openVerifiedPane, type PaneOps, type PaneSeam } from "./pane.js";
import { openPlanPane, workerArgs } from "./plan-deps.js";
import { PlanTracker, planStatusFile } from "./plan-status.js";
import { PlanFollower } from "./plan-follow.js";
import { requireVisiblePane, buildRunEnv } from "./run.js";
import { eventsPath } from "./paths.js";
import type { WorkersConfig } from "./config.js";

const config = { pane: { fontSize: 13, autoExitSecs: 10 } } as unknown as WorkersConfig;
const UID = "D38D3E5D-19E8-4FE5-A78A-26E8E571FE27";
const TERM = `w5t0p0:${UID}`;
const env = { ITERM_SESSION_ID: TERM } as NodeJS.ProcessEnv;
const TOO_SMALL = "pane verification failed: pane too small, 26x14 < 40x8 (window 5322)";
const ops: PaneOps = { listIterm: async () => [], closeIterm: async () => true, listTmux: () => [], closeTmux: () => true };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pai-planpane-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function seam(o: { small?: boolean; hostSelected?: boolean; tab?: boolean }): PaneSeam & { placed: string[] } {
  const placed: string[] = [];
  return {
    placed,
    hostSelected: async () => o.hostSelected !== false,
    split: async () => ({ message: "pane opened", session: "S1" }),
    verify: async () => {
      if (o.small) throw new Error(TOO_SMALL);
      return "window 7 tab 1/1, pane 80x20";
    },
    place: async (_l, _c, _w, _t, _h, kind) => {
      placed.push(kind);
      if (kind === "tab" && o.tab === false) throw new Error("pane verification failed: nope");
      return `window 7 new ${kind}`;
    },
  };
}

describe("no window for a plan pane", () => {
  it("no room: tab, never window", async () => {
    const s = seam({ small: true });
    await openVerifiedPane(dir, config, "plan-a", TERM, env, ops, { ...s, noWindow: true });
    expect(s.placed).toEqual(["tab"]);
  });
  it("no room and the tab fails: error, window never tried", async () => {
    const s = seam({ small: true, tab: false });
    await expect(openVerifiedPane(dir, config, "plan-a", TERM, env, ops, { ...s, noWindow: true })).rejects.toThrow(/too small/);
    expect(s.placed).toEqual(["tab"]);
  });
  it("host tab not selected: tab, not window", async () => {
    const s = seam({ hostSelected: false });
    await openVerifiedPane(dir, config, "plan-a", TERM, env, ops, { ...s, noWindow: true });
    expect(s.placed).toEqual(["tab"]);
  });
  it("plain worker keeps the window fallback", async () => {
    const s = seam({ small: true, tab: false });
    await openVerifiedPane(dir, config, "w-1", TERM, env, ops, s);
    expect(s.placed).toEqual(["tab", "window"]);
  });
});

describe("one pane per plan run", () => {
  it("two plans open exactly two panes, each with noWindow", async () => {
    vi.stubEnv("PAI_WORKER", "");
    vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
    const host = async () => ({ term: TERM });
    const open = vi.fn(async () => "pane");
    const a = new PlanTracker(dir, "job-a", 2, 0);
    const b = new PlanTracker(dir, "job-b", 2, 0);
    const spy = vi.fn(open);
    const ok = [await openPlanPane(dir, a, spy as never, host), await openPlanPane(dir, b, spy as never, host)];
    expect(ok).toEqual([true, true]);
    {
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["plan-job-a", "plan-job-b"]);
      for (const c of spy.mock.calls) expect((c as unknown[])[6]).toEqual({ noWindow: true });
      expect(a.hasPane && b.hasPane).toBe(true);
    }
  });

  describe("PAI_PLAN_PANE is accepted only when real", () => {
    const call = () => requireVisiblePane(dir, config as never, "w-1", TERM, true, false, join(dir, "ledger"));
    beforeEach(() => {
      vi.stubEnv("PAI_WORKER", "");
      vi.stubEnv("PAI_WORKER_ALLOW_HIDDEN", "");
      vi.stubEnv("PAI_PLAN_PANE", "plan-job-a");
      vi.stubEnv("PAI_PLAN_PART", "p1");
    });
    const live = () => {
      const t = new PlanTracker(dir, "job-a", 2, 0);
      t.hasPane = true;
      t.setRunning(["p1"]);
      return t;
    };

    it("real plan worker: accepted", async () => {
      live();
      await expect(call()).resolves.toBe(true);
    });
    it("worker already listed by id: accepted", async () => {
      const t = live();
      t.setRunning([]);
      t.setWorker("p1", "w-1");
      vi.stubEnv("PAI_PLAN_PART", "");
      await expect(call()).resolves.toBe(true);
    });
    it("no such plan: refused", async () => {
      await expect(call()).rejects.toThrow(/no visible pane/);
    });
    it("dead runner: refused", async () => {
      live();
      const f = planStatusFile(dir, "plan-job-a");
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), pid: 2 ** 22 + 12345 }));
      await expect(call()).rejects.toThrow(/no visible pane/);
    });
    it("plan without a pane: refused", async () => {
      new PlanTracker(dir, "job-a", 2, 0).setRunning(["p1"]);
      await expect(call()).rejects.toThrow(/no visible pane/);
    });
    it("worker not listed (other part): refused", async () => {
      live();
      vi.stubEnv("PAI_PLAN_PART", "p2");
      await expect(call()).rejects.toThrow(/no visible pane/);
    });
    it("the model process env carries no PAI_PLAN_PANE", () => {
      const provider = { native: true, models: { default: "m" }, env: {} } as never;
      const e = buildRunEnv(provider, true);
      expect(e.PAI_PLAN_PANE).toBeUndefined();
      expect(e.PAI_PLAN_PART).toBeUndefined();
    });
  });
  it("workerArgs unchanged", () => {
    expect(workerArgs({ label: "l", provider: "p", tier: "opus", priority: undefined } as never, "s", "r")).toContain("--worktree");
  });
});

describe("plan pane follows the workers", () => {
  const ev = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
  const put = (wid: string, text: string) => {
    const p = eventsPath(dir, wid);
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, ev(text));
  };

  it("worker 1, then worker 2 (one at a time: plain lines)", () => {
    const t = new PlanTracker(dir, "job-a", 2, 0);
    const f = new PlanFollower(dir, t.id, false);
    put("w-1", "alpha");
    t.setWorker("p1", "w-1");
    const first = f.poll();
    expect(first).toContain("following p1 (w-1)");
    expect(first).toContain("alpha");
    put("w-2", "beta");
    t.setWorker("p2", "w-2");
    const second = f.poll();
    expect(second).toContain("following p2 (w-2)");
    expect(second).toContain("beta");
    expect(second).not.toContain("alpha");
  });

  it("parallel parts: interleaved with the part id", () => {
    const t = new PlanTracker(dir, "job-p", 2, 0);
    const f = new PlanFollower(dir, t.id, false);
    put("w-1", "alpha");
    put("w-2", "beta");
    t.setWorker("p1", "w-1");
    t.setWorker("p2", "w-2");
    const out = f.poll();
    expect(out).toMatch(/\[p1\] .*alpha/);
    expect(out).toMatch(/\[p2\] .*beta/);
  });
});
