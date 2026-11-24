/**
 * Tests for the worker contract prompt — which class gets which opening block.
 * Guards the 2026-11-16 harness bug: an L1 started with `pai worker run --class orchestrate`
 * (no --orchestrate flag) got the implementation-worker opening and implemented everything
 * itself on its cloud model instead of cutting packages for local L2 implementers.
 */

import { describe, it, expect } from "vitest";
import { applyClaimCheck, claimIdentifiers, workerContractPrompt, ORCHESTRATOR_START_BLOCK, WORKER_CONTRACT_PROMPT, REPEAT_STOP_LINE, CODE_EXPLORE_LINE, CODE_GRAPH_FIRST_LINE, checkProof, verifyReportChanges } from "./report.js";
import { repairAndValidateAg2 } from "./agentish.js";

describe("workerContractPrompt — planner classes (orchestrate/plan without the flag)", () => {
  for (const cls of ["orchestrate", "plan"]) {
    it(`${cls} gets the L1 planner opening and starts L2 implementers`, () => {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toContain("L1 planner");
      expect(p).toContain("--class implement");
      expect(p).toContain("pai worker merge <id>");
      // the exact start/wait/merge commands reach it without the flag
      expect(p).toContain(ORCHESTRATOR_START_BLOCK);
    });
    it(`${cls} does not get the implementation-worker opening`, () => {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).not.toContain("this task is yours to finish");
      expect(p).not.toContain("Never hand your whole task");
      expect(p).not.toContain("Child workers are for two things");
      // the rest of the full contract still applies
      expect(p).toContain("Answer it FIRST");
      expect(p).toContain("pai worker help");
      expect(p).toMatch(/heredoc/i);
      expect(p).toContain("AG2 `R` message");
    });
  }

  it("the --orchestrate flag path still appends ORCHESTRATOR_CONTRACT and now uses the planner opening too", () => {
    const p = workerContractPrompt("implement", "ag2", true);
    expect(p).toContain("Orchestrator mode");
    expect(p).toContain("L1 planner");
  });

  it("class implement without the flag is unchanged (implementation-worker opening)", () => {
    const p = workerContractPrompt("implement", "ag2");
    expect(p).toContain("this task is yours to finish");
    expect(p).toContain("PARALLELISING");
    expect(p).not.toContain("L1 planner");
    expect(p).not.toContain("Orchestrator mode");
  });

  it("spotcheck/simple keep the short contract", () => {
    for (const cls of ["spotcheck", "simple"]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toContain("No child workers, no handoff");
      expect(p).not.toContain("L1 planner");
      expect(p.length).toBeLessThan(workerContractPrompt("implement", "ag2").length);
    }
  });

  it("the keepalive baseline stays the worker-role full contract", () => {
    expect(WORKER_CONTRACT_PROMPT).toContain("this task is yours to finish");
    expect(WORKER_CONTRACT_PROMPT).not.toContain("L1 planner");
  });
});

describe("workerContractPrompt — local-provider repeat-stop line", () => {
  it("a local provider gets the repeat-stop line; a cloud provider does not", () => {
    const local = workerContractPrompt("implement", "ag2", false, undefined, undefined, false, true);
    const cloud = workerContractPrompt("implement", "ag2", false, undefined, undefined, false, false);
    expect(local).toContain(REPEAT_STOP_LINE);
    expect(cloud).not.toContain(REPEAT_STOP_LINE);
  });

  it("a short-class local worker gets it too", () => {
    const p = workerContractPrompt("simple", "ag2", false, undefined, undefined, false, true);
    expect(p).toContain("A denied or repeated call will not change its result");
  });
});

describe("workerContractPrompt — code graph lines", () => {
  it("every class gets the find-code-before-grep line (issue #23)", () => {
    for (const cls of ["implement", "simple", "spotcheck", undefined]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toContain("Find code with `pai code explore <symbol>` / `pai code search <words>` before grep");
      expect(p).toContain("Tests: extend an existing test file next to the code you change first; a new test file only with a tests/KEPT.md entry written BEFORE creating it — add the entry with `pai tests keep <file> --kind <a|b|c> --evidence \"<why>\"` (never rewrite the ledger by hand); one-off checks go under .pai-scratch/ and are never committed.");
      expect(p).toContain("The live router/daemon/cockpit run main, not your branch: prove your change with tests or a headless render from your worktree; never poll live endpoints for it (L0 checks live after the merge).");
    }
  });

  it("indexed repo gets the code-graph lines; unindexed gets none", () => {
    const on = workerContractPrompt(undefined, "ag2", false, undefined, undefined, true);
    const off = workerContractPrompt(undefined, "ag2", false, undefined, undefined, false);
    expect(on).toContain("pai code explore");
    expect(on).toContain("pai code callers <symbol>");
    expect(on).toContain("pai code search <text>");
    expect(off).not.toContain("indexed in the code graph");
  });

  it("local providers get no code-graph lines; cloud providers do (A/B #23 result, forge #23 comment 21176)", () => {
    const local = workerContractPrompt("implement", "ag2", false, undefined, undefined, true, true);
    expect(local).not.toContain(CODE_EXPLORE_LINE);
    expect(local).not.toContain(CODE_GRAPH_FIRST_LINE);
    expect(local).not.toContain("indexed in the code graph");
    expect(local).toContain(REPEAT_STOP_LINE);

    const cloud = workerContractPrompt("implement", "ag2", false, undefined, undefined, true, false);
    expect(cloud).toContain(CODE_EXPLORE_LINE);
    expect(cloud).toContain(CODE_GRAPH_FIRST_LINE);

    const saved = process.env.PAI_BRIEF_CODE_GRAPH;
    try {
      process.env.PAI_BRIEF_CODE_GRAPH = "0";
      const cloudOff = workerContractPrompt("implement", "ag2", false, undefined, undefined, true, false);
      expect(cloudOff).not.toContain(CODE_EXPLORE_LINE);
      expect(cloudOff).not.toContain(CODE_GRAPH_FIRST_LINE);
    } finally {
      if (saved === undefined) delete process.env.PAI_BRIEF_CODE_GRAPH;
      else process.env.PAI_BRIEF_CODE_GRAPH = saved;
    }
  });

  it("PAI_BRIEF_CODE_GRAPH=0 drops both code-graph lines from the brief (A/B #23)", () => {
    const saved = process.env.PAI_BRIEF_CODE_GRAPH;
    try {
      delete process.env.PAI_BRIEF_CODE_GRAPH;
      const unset = workerContractPrompt(undefined, "ag2", false, undefined, undefined, true);
      expect(unset).toContain("Find code with `pai code explore <symbol>`");
      expect(unset).toContain("indexed in the code graph");

      process.env.PAI_BRIEF_CODE_GRAPH = "0";
      const zero = workerContractPrompt(undefined, "ag2", false, undefined, undefined, true);
      expect(zero).not.toContain("Find code with `pai code explore <symbol>`");
      expect(zero).not.toContain("indexed in the code graph");

      process.env.PAI_BRIEF_CODE_GRAPH = "1";
      const one = workerContractPrompt(undefined, "ag2", false, undefined, undefined, true);
      expect(one).toContain("Find code with `pai code explore <symbol>`");
      expect(one).toContain("indexed in the code graph");
    } finally {
      if (saved === undefined) delete process.env.PAI_BRIEF_CODE_GRAPH;
      else process.env.PAI_BRIEF_CODE_GRAPH = saved;
    }
  });
});

describe("proof check and report validation credit what really ran (2026-11-22/23 false 'invalid report')", () => {
  const R = (c: string, p: string): string => `R\ni=job\nr=+\nG=+\nc=${c}\nt=Check+\np=${p}\nz=done`;

  it("a repo-root c= path is repaired to ./name so the validator accepts it", () => {
    const out = repairAndValidateAg2(R("config.yaml add entry | workers.yaml add entry", "python3 -I chk.py"));
    expect(out.repairs).toContain("c root path");
    expect(out.validation.errors).toEqual([]);
  });

  it("r=+ with a p= line is not 'without proof'; a failing t= entry is named (#26)", () => {
    const base = "R\ni=stale-verify-repro\nr=+\nG=+\nc=src/workers/report.ts fix\nt=Tsc+ ReportTest+ ProbeBefore- ProbeAfter+\np=npx tsx .pai-scratch/probe.ts → before: ok=false. After: ok=true. npx tsc --noEmit && npx vitest run src/workers/report.test.ts → 14 passed\nz=Cause was DELETED_RE.";
    const bad = repairAndValidateAg2(base).validation;
    expect(bad.errors.join()).not.toContain("without proof");
    expect(bad.errors.join()).toContain("ProbeBefore-");
    expect(repairAndValidateAg2(base.replace("ProbeBefore-", "ProbeBefore+")).validation.errors).toEqual([]);
    const noP = repairAndValidateAg2(base.replace(/\np=.*/, "").replace("ProbeBefore-", "ProbeBefore+")).validation;
    expect(noP.ok).toBe(false);
    expect(noP.errors.join()).toContain("without proof");
  });

  it("a script run from $TMPDIR inside a && chain counts as run", () => {
    const runs = [{ command: `sed -i '' -e 's/a/b/' config.yaml && printf 'x' > "$TMPDIR/p.py" && python3 -I "$TMPDIR/p.py"; sed -n 1p config.yaml`, failed: false }];
    const chk = checkProof(R("./config.yaml x", 'python3 -I p.py (yaml.safe_load config.yaml) → ok; line 331: "--reasoning on"'), runs);
    expect(chk.rewritten).toBe(false);
  });

  it("per-command `cmd → result; cmd2 → result` claims stand when each ran (loop variable, description prefix)", () => {
    const runs = [
      { command: "sed -e 's#cd x#cd .#' b.sh > $TMPDIR/b.sh; (time bash $TMPDIR/b.sh) 2>&1 | tail -25", failed: false },
      { command: "cd build-metal; for t in gemv_parity pair_parity; do echo == $t; timeout 100 ./$t 2>&1 | tail -8; done", failed: false },
    ];
    const chk = checkProof(R("./a/b.metal x", "bash build script copy (cd .) → BUILD EXIT 0; build-metal/gemv_parity → ALL PASS; build-metal/pair_parity → ALL PASS"), runs);
    expect(chk.rewritten).toBe(false);
  });

  it("a later `cmd → result` segment that never ran still downgrades the report", () => {
    const runs = [{ command: "cd build-metal; ./gemv_parity | tail -3", failed: false }];
    const chk = checkProof(R("./a/b.metal x", "bash build script copy (cd .) → BUILD EXIT 0; build-metal/gemv_parity → ALL PASS; build-metal/pair_parity → ALL PASS"), runs);
    expect(chk.rewritten).toBe(true);
  });

  it("a proof command that never ran is still downgraded", () => {
    const runs = [{ command: "npx tsc --noEmit", failed: false }];
    const chk = checkProof(R("./a/b.ts x", "npx vitest run src/a.test.ts → 3 passed"), runs);
    expect(chk.rewritten).toBe(true);
    expect(chk.text).toContain("r=~");
  });
});

describe("claim check against the diff", () => {
  const diff = ["diff --git a/src/Board.tsx b/src/Board.tsx", "--- a/src/Board.tsx", "+++ b/src/Board.tsx", "@@ -1 +1,3 @@", "+const listOk = true;", "+const dragIds = [];"].join("\n");
  const base = (summary: string, result: "+" | "-" = "+") => ({ result, changed: [{ path: "src/Board.tsx", summary }], checks: [{ name: "Tsc", ok: true }] });

  it("passes when every claimed identifier is in the added lines", () => {
    const r = applyClaimCheck(base("listOk guard, dragIds"), diff);
    expect(r.result).toBe("+");
    expect(r.checks?.find((c) => c.name === "ClaimsInDiff")?.ok).toBe(true);
  });

  it("fails naming dragend (Paperfull #74) and downgrades + to ~", () => {
    const r = applyClaimCheck(base("listOk guard, dragIds, dragend"), diff);
    const ck = r.checks?.find((c) => c.name === "ClaimsInDiff");
    expect(ck?.ok).toBe(false);
    expect(ck?.detail).toContain("dragend");
    expect(ck?.detail).not.toContain("dragIds");
    expect(r.result).toBe("~");
  });

  it("leaves a failing result alone and flags prose-only entries as no claim", () => {
    expect(applyClaimCheck(base("listOk, dragend", "-"), diff).result).toBe("-");
    const prose = base("fixes the drag handling and cleans up the layout");
    expect(claimIdentifiers("src/Board.tsx", "fixes the drag handling and cleans up the layout")).toEqual([]);
    expect(applyClaimCheck(prose, diff)).toBe(prose);
  });

  it("extracts backticked, dotted and call tokens, not file names", () => {
    expect(claimIdentifiers("a/x.ts", "`foo_bar` in x.ts, api.get, build() and Board")).toEqual(expect.arrayContaining(["foo_bar", "api.get", "build"]));
    expect(claimIdentifiers("a/x.ts", "x.ts")).toEqual([]);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { recordFailures, suspectLines, SUSPECT_PHRASE } from "./suspect-test.js";
import { renderReport } from "./report.js";

describe("suspect test", () => {
  const dir = (): string => mkdtempSync(pjoin(tmpdir(), "suspect-"));
  const t0 = 1_700_000_000_000;
  it("2 workers, same test: suspect line with the phrase", () => {
    const d = dir();
    recordFailures(d, "w1", "m1", [{ id: "a.test.ts > x", assertion: "expected 1 to be 2" }], t0);
    recordFailures(d, "w2", "m2", [{ id: "a.test.ts > x", assertion: "expected 1 to be 2" }], t0 + 1000);
    const l = suspectLines(d, ["a.test.ts > x"], t0 + 2000);
    expect(l).toHaveLength(1);
    expect(l[0]).toContain(SUSPECT_PHRASE);
    expect(l[0]).toContain("expected 1 to be 2");
    const n = Date.now();
    recordFailures(d, "w3", "m1", [{ id: "a.test.ts > x", assertion: "a" }], n);
    recordFailures(d, "w4", "m2", [{ id: "a.test.ts > x", assertion: "a" }], n);
    const out = renderReport((_k, t) => t, "", { checks: [{ name: "a.test.ts > x", ok: false }] } as never, "", d);
    expect(out.join("\n")).toContain("suspect test");
  });
  it("same worker twice: none", () => {
    const d = dir();
    recordFailures(d, "w1", "m1", [{ id: "t" }], t0);
    recordFailures(d, "w1", "m1", [{ id: "t" }], t0 + 1000);
    expect(suspectLines(d, undefined, t0 + 2000)).toEqual([]);
  });
  it("outside 24h: none", () => {
    const d = dir();
    recordFailures(d, "w1", "m1", [{ id: "t" }], t0);
    recordFailures(d, "w2", "m2", [{ id: "t" }], t0 + 25 * 3600_000);
    expect(suspectLines(d, undefined, t0 + 25 * 3600_000 + 1)).toEqual([]);
  });
});
