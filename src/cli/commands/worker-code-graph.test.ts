/**
 * 2026-11-25: `PAI_BRIEF_CODE_GRAPH=1` in the env of `pai bench run` never reached its workers — they
 * start through the daemon, which has its own environment. The decision has to travel as a run option.
 * Pins that `--code-graph on|off` reaches RunOptions via buildRunPlan (and is validated), and that a
 * resume of a run carrying it keeps the decision.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// the repo root as seen from this file (vitest may run from a scratch cwd)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
import type { RunContext } from "../define.js";
import { buildRunPlan } from "./worker.js";
import { loadStatus, saveStatus, type WorkerStatus } from "../../workers/status.js";

const ctx = (opts: Record<string, string | number | boolean | undefined>): RunContext => ({
  args: {},
  opts,
  dryRun: false,
  rest: ["-p", "do the thing"],
});

describe("buildRunPlan — --code-graph on|off", () => {
  it("on and off reach the run options", () => {
    const on = buildRunPlan(ctx({ "code-graph": "on" }));
    expect(on.kind).toBe("run");
    if (on.kind === "run") expect(on.run.codeGraph).toBe("on");
    const off = buildRunPlan(ctx({ "code-graph": "off" }));
    if (off.kind === "run") expect(off.run.codeGraph).toBe("off");
  });

  it("unset stays unset (the default applies)", () => {
    const p = buildRunPlan(ctx({}));
    if (p.kind === "run") expect(p.run.codeGraph).toBeUndefined();
  });

  it("anything else is an error, not a silent default", () => {
    expect(() => buildRunPlan(ctx({ "code-graph": "maybe" }))).toThrow(/--code-graph: must be "on" or "off"/);
  });
});

describe("resume carries the code-graph decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-resume-"));

  it("a status with codeGraph reads back on load (what resumeCommand spreads)", () => {
    const base: WorkerStatus = {
      id: "w-cg-1",
      state: "done",
      provider: "gyro-m",
      model: "m",
      label: "cg test",
      startedAt: new Date().toISOString(),
      pid: 1,
    } as unknown as WorkerStatus;
    saveStatus(dir, { ...base, codeGraph: "on" });
    expect(loadStatus(dir, "w-cg-1")?.codeGraph).toBe("on");
    saveStatus(dir, base);
    expect(loadStatus(dir, "w-cg-1")?.codeGraph).toBeUndefined();
  });

  it("resumeCommand spreads old.codeGraph into the new run's options", () => {
    // read the shipped resume path: the carry-over must be there next to deliverable's
    const text = readFileSync(join(repo, "src/cli/commands/worker.ts"), "utf8");
    expect(text).toMatch(/\.\.\.\(old\.codeGraph \? \{ codeGraph: old\.codeGraph \} : \{\}\)/);
  });

  it("the run command declares --code-graph and buildRunPlan wires it", () => {
    const text = readFileSync(join(repo, "src/cli/commands/worker.ts"), "utf8");
    expect(text).toContain('name: "code-graph"');
    expect(text).toContain('codeGraphOf(o["code-graph"])');
  });

  it("the bench command declares --code-graph and passes it through", () => {
    const text = readFileSync(join(repo, "src/cli/commands/bench.ts"), "utf8");
    expect(text).toContain('name: "code-graph"');
    expect(text).toContain("codeGraph: codeGraphOf(ctx.opts[\"code-graph\"])");
  });

  it("the set scripts append the flag to every pai worker run and record it", () => {
    const benchDir = join(repo, "bench");
    for (const f of ["evalset.sh", "realset.sh"]) {
      const text = readFileSync(join(benchDir, f), "utf8");
      expect(text).toContain("BENCH_CODE_GRAPH");
      expect(text).toContain("--code-graph on");
      expect(text).toContain("--code-graph off");
      // the flag expansion sits between margs and --class on every worker start
      expect(text).toMatch(/cgargs\[@\]\+"\$\\?\{cgargs\[@\]\}.*--class implement/);
    }
  });

  rmSync(dir, { recursive: true, force: true });
});
