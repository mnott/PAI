/**
 * Tests for `pai worker help`: budget, ledger, scope resolution. The
 * sub-worker spawn is a mock; no provider is ever called.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpBudget, helpArgv, readHelpLedger, renderHelpReport, requestHelp, resolveHelpScope, type HelpDeps } from "./help.js";
import { nowStamp, saveStatus, type WorkerStatus } from "./status.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pai-help-test-"));

function status(id: string, parent?: string): WorkerStatus {
  return {
    id,
    pid: 999999,
    started: nowStamp(new Date()),
    state: "done",
    ...(parent ? { parent } : {}),
  } as unknown as WorkerStatus;
}

function deps(over: Partial<HelpDeps> = {}): HelpDeps & { calls: string[][] } {
  const calls: string[][] = [];
  let t = 1000;
  let n = 0;
  return {
    calls,
    spawnWorker: async (argv) => {
      calls.push(argv);
      return { report: "R\nr=+\nz=done", tokens: 1234, ok: true };
    },
    changedFiles: () => (n++ % 2 ? ["a.ts"] : []), // before the spawn: clean; after: one new file
    now: () => (t += 500),
    ...over,
  };
}

const req = { task: "do the thing", provider: "anthropic", model: "sonnet", files: ["x.ts"], cwd: "." };

describe("resolveHelpScope", () => {
  const chain = [status("leaf", "mid"), status("mid", "top"), status("top")];
  it("walks to the top-most ancestor", () => {
    expect(resolveHelpScope(chain, { PAI_WORKER_ID: "leaf" })).toBe("top");
  });
  it("a chain id without a status is not an ancestor", () => {
    expect(resolveHelpScope([status("w", "chain-1")], { PAI_WORKER_ID: "w" })).toBe("w");
  });
  it("PAI_HELP_SCOPE wins", () => {
    expect(resolveHelpScope(chain, { PAI_WORKER_ID: "leaf", PAI_HELP_SCOPE: "unit-7" })).toBe("unit-7");
  });
  it("outside a worker is the session scope", () => {
    expect(resolveHelpScope(chain, {})).toBe("session");
  });
});

describe("helpBudget", () => {
  it("defaults to 2 and reads PAI_HELP_BUDGET", () => {
    expect(helpBudget({})).toBe(2);
    expect(helpBudget({ PAI_HELP_BUDGET: "5" })).toBe(5);
    expect(helpBudget({ PAI_HELP_BUDGET: "x" })).toBe(2);
  });
});

describe("requestHelp", () => {
  it("allows 2 calls then refuses, prints the report, records the ledger", async () => {
    const dir = tmp();
    saveStatus(dir, status("top"));
    saveStatus(dir, status("leaf", "top"));
    const env = { PAI_WORKER_ID: "leaf" };
    const d = deps();
    for (let i = 0; i < 2; i++) {
      const r = await requestHelp(dir, req, d, env);
      expect(r.refused).toBe(false);
      if (!r.refused) {
        expect(r.text).toContain("z=done");
        expect(r.text).toContain("changed files: a.ts");
      }
    }
    const third = await requestHelp(dir, req, d, env);
    expect(third).toEqual({
      refused: true,
      message: "help budget used (2/2): report the blocker in your R x= line instead",
    });
    expect(d.calls).toHaveLength(2);
    const led = readHelpLedger(dir);
    expect(led).toHaveLength(2);
    expect(led[0]).toMatchObject({ caller: "leaf", scope: "top", task: "do the thing", provider: "anthropic", tokens: 1234, outcome: "ok", durationMs: 500 });
    expect(readHelpLedger(dir, "other")).toHaveLength(0);
    expect(renderHelpReport(led)).toContain("top: 2 calls");
  });

  it("a failed spawn is recorded and still counts", async () => {
    const dir = tmp();
    const d = deps({ spawnWorker: async () => { throw new Error("boom"); } });
    const r = await requestHelp(dir, req, d, { PAI_HELP_SCOPE: "u" });
    expect(r).toMatchObject({ refused: false, ok: false });
    expect(readHelpLedger(dir, "u")[0].outcome).toBe("failed");
  });

  it("builds a bounded in-place implement run", () => {
    const a = helpArgv(req);
    expect(a).toEqual(expect.arrayContaining(["--class", "implement", "--no-worktree", "--max-minutes", "20", "--provider", "anthropic", "--model", "sonnet"]));
    expect(a[a.length - 1]).toContain("Relevant files: x.ts");
  });
});
