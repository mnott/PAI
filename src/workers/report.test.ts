/**
 * Tests for the worker contract report — the per-class/per-format contract
 * prompt, parsing the final message (AG2 or JSON) and rendering the compact
 * block. Pure functions only.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeColor, headerLine } from "./render.js";
import { validateAg2 } from "./agentish.js";
import {
  OPERATOR_MARK,
  parseWorkerReport,
  promptTrailer,
  renderReport,
  workerContractPrompt,
  verifyReportChanges,
  verifyFailNote,
  WORKER_CONTRACT_PROMPT,
} from "./report.js";

const sample = {
  changed: [{ path: "src/a.ts", summary: "added the guard" }],
  commands: ["npm test"],
  checks: [
    { name: "tests", ok: true, detail: "12 passed" },
    { name: "lint", ok: false, detail: "1 new error" },
  ],
  open: ["decide the retry count"],
  notes: "guard added, lint needs a look",
};

describe("parseWorkerReport — JSON fallback", () => {
  it("parses a bare JSON final message", () => {
    expect(parseWorkerReport(JSON.stringify(sample))?.notes).toBe("guard added, lint needs a look");
  });

  it("parses a ```json fenced final message", () => {
    const text = "```json\n" + JSON.stringify(sample, null, 2) + "\n```";
    const r = parseWorkerReport(text);
    expect(r?.changed).toEqual([{ path: "src/a.ts", summary: "added the guard" }]);
    expect(r?.checks?.[1]).toEqual({ name: "lint", ok: false, detail: "1 new error" });
    expect(r?.format).toBe("json");
  });

  it("parses JSON embedded in prose (first { to last })", () => {
    const text = "Done!\n" + JSON.stringify(sample) + "\nThat's all.";
    expect(parseWorkerReport(text)?.open).toEqual(["decide the retry count"]);
  });

  it("accepts a partial report (any of changed/checks/notes is the fingerprint)", () => {
    expect(parseWorkerReport('{"changed":[],"notes":"x"}')?.notes).toBe("x");
    expect(parseWorkerReport('{"changed":[],"checks":[]}')?.changed).toEqual([]);
  });

  it("rejects JSON that does not look like the contract", () => {
    expect(parseWorkerReport('{"foo":1,"bar":[2]}')).toBeNull();
    expect(parseWorkerReport('["changed","checks"]')).toBeNull();
  });

  it("returns null for plain prose", () => {
    expect(parseWorkerReport("All done, tests green.")).toBeNull();
    expect(parseWorkerReport("")).toBeNull();
  });
});

describe("parseWorkerReport — AG2 precedence", () => {
  it("parses an AG2 R message before ever trying JSON", () => {
    const text = [
      "R",
      "i=fix-flaky-retry",
      "r=+",
      "z=widened the jitter window",
      "c=src/net/retry.ts widened jitter",
      "t=RegressionAdded+ RetryTest+",
      "p=npx vitest run src/net",
    ].join("\n");
    const r = parseWorkerReport(text);
    expect(r?.format).toBe("ag2");
    expect(r?.result).toBe("+");
    expect(r?.notes).toBe("widened the jitter window");
    expect(r?.changed).toEqual([{ path: "src/net/retry.ts", summary: "widened jitter" }]);
    expect(r?.checks).toEqual([
      { name: "RegressionAdded", ok: true, detail: "+" },
      { name: "RetryTest", ok: true, detail: "+" },
    ]);
    expect(r?.commands).toEqual(["npx vitest run src/net"]);
  });

  it("an R with a failing test and a next-step falls through to open[]", () => {
    const text = ["R", "i=x", "r=-", "y=one test still flakes", "t=RetryTest-", "c=a.ts fix", "p=vitest", "x=investigate timeout"].join(
      "\n"
    );
    const r = parseWorkerReport(text);
    expect(r?.result).toBe("-");
    expect(r?.why).toBe("one test still flakes");
    expect(r?.checks).toEqual([{ name: "RetryTest", ok: false, detail: "-" }]);
    expect(r?.open).toContain("investigate timeout");
  });

  it("a non-R kind (T, S, Q, A, X) does not parse as a report", () => {
    expect(parseWorkerReport("T\ni=x\ng=do it")).toBeNull();
  });

  it("still falls back to JSON when the text is not AG2 at all", () => {
    expect(parseWorkerReport(JSON.stringify(sample))?.format).toBe("json");
  });
});

describe("renderReport", () => {
  const c = makeColor(false); // plain: assert the text, not the colors
  const r = parseWorkerReport(JSON.stringify(sample))!;

  it("renders changed paths, checks with marks, notes", () => {
    const lines = renderReport(c, "  ", r, "/repo").join("\n");
    expect(lines).toContain("changed");
    expect(lines).toContain("src/a.ts — added the guard");
    expect(lines).toContain("✓ tests");
    expect(lines).toContain("12 passed");
    expect(lines).toContain("✗ lint");
    expect(lines).toContain("1 new error");
    expect(lines).toContain("open");
    expect(lines).toContain("decide the retry count");
    expect(lines).toContain("guard added, lint needs a look");
  });

  it("shortens changed paths against cwd", () => {
    const lines = renderReport(c, "", { ...r, changed: [{ path: "/repo/src/a.ts", summary: "s" }] }, "/repo");
    expect(lines.join("\n")).toContain("src/a.ts — s");
    expect(lines.join("\n")).not.toContain("/repo/src/a.ts");
  });

  it("skips empty sections, keeps the notes line labelled", () => {
    const lines = renderReport(c, "", { changed: [], commands: [], checks: [], open: [], notes: "nothing" }, "");
    expect(lines.join("\n")).toBe("notes  nothing");
  });
});

describe("workerContractPrompt — class selection", () => {
  it("spotcheck and simple get the short contract (json format: under 1200 chars)", () => {
    // the ag2 format's own floor is the fixed AG2 spec text plus the mandated
    // R-message field list — this is the token-ish check on the contract's
    // own prose, isolated from that fixed external blob (see below for the
    // ag2 comparison, which checks relative shortness instead)
    for (const cls of ["spotcheck", "simple"]) {
      const p = workerContractPrompt(cls, "json");
      expect(p.length).toBeLessThan(1200);
      expect(p).not.toMatch(/PARALLELISING/);
      expect(p).toContain("No child workers, no handoff");
    }
  });

  it("spotcheck/simple stay shorter than the full contract in both formats", () => {
    for (const format of ["json", "ag2"] as const) {
      const short = workerContractPrompt("spotcheck", format).length;
      const full = workerContractPrompt("implement", format).length;
      expect(short).toBeLessThan(full);
    }
  });

  it("every other class, and no class, gets the full contract", () => {
    for (const cls of ["implement", "complex", "draft", "review", undefined]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toMatch(/PARALLELISING/);
      expect(p).toMatch(/You are the worker/);
    }
  });

  it("both lengths carry the file-not-inline rule", () => {
    for (const p of [workerContractPrompt("spotcheck", "ag2"), workerContractPrompt("implement", "ag2")]) {
      expect(p).toMatch(/heredoc/i);
      expect(p).toMatch(/Write tool/);
      expect(p).toMatch(/\$\(cat /);
      expect(p).toMatch(/python3 -c/);
    }
  });

  it("format ag2 ends with the AG2 spec and the R-message instructions", () => {
    for (const cls of ["spotcheck", "implement"]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toMatch(/^AG2\./m);
      expect(p).toContain("AG2 `R` message");
      expect(p).toContain("every t entry +");
    }
  });

  // aibroker's real R schema (verified against `aibroker agentish check`
  // 2026-09-20): i/r/t/c required, r=+ needs gate+proof+all-t-passing, and R
  // has no u/out field at all (u is T-only) — the answer goes in z instead.
  it("format ag2 carries the real R field set and a literal, validator-passing example block", () => {
    for (const cls of ["spotcheck", "implement"]) {
      const p = workerContractPrompt(cls, "ag2");
      expect(p).toMatch(/R requires i \(id\), r/);
      expect(p).not.toMatch(/\bu= /);
      expect(p).toContain("Example:");
      expect(p).toMatch(
        /\nR\ni=count-audit-ts\nr=\+\nG=\+\nc=src\/audit summary of files counted\nt=Count\+\np=wc -l src\/audit\/\*\.ts\nz=19 files, 2523 lines/
      );
    }
  });

  it("the short contract in ag2 format stays under 1500 characters", () => {
    expect(workerContractPrompt("spotcheck", "ag2").length).toBeLessThan(1500);
    expect(workerContractPrompt("simple", "ag2").length).toBeLessThan(1500);
  });

  it("the example block itself passes the real aibroker validator, when it is available", () => {
    const p = workerContractPrompt("spotcheck", "ag2");
    const example = p.slice(p.indexOf("\nR\n") + 1);
    const v = validateAg2(example);
    if (v.validator === "aibroker") expect(v).toEqual({ ok: true, errors: [], validator: "aibroker" });
  });

  it("format json ends with the JSON contract instead", () => {
    for (const cls of ["spotcheck", "implement"]) {
      const p = workerContractPrompt(cls, "json");
      expect(p).toContain('"changed"');
      expect(p).toContain('"checks"');
      expect(p).not.toMatch(/^AG2\./m);
    }
  });
});

describe("promptTrailer", () => {
  it("ag2 format names the AG2 R message, one final line", () => {
    const t = promptTrailer("ag2");
    expect(t.startsWith("\n\n")).toBe(true);
    expect(t.split("\n").filter(Boolean)).toHaveLength(1);
    expect(t).toMatch(/AG2 R message only/);
  });

  it("json format names a JSON object, one final line", () => {
    const t = promptTrailer("json");
    expect(t.startsWith("\n\n")).toBe(true);
    expect(t.split("\n").filter(Boolean)).toHaveLength(1);
    expect(t).toMatch(/JSON object only/);
  });
});

describe("WORKER_CONTRACT_PROMPT — full-contract AG2 baseline (keepalive path)", () => {
  it("is the full contract in AG2 format", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/You are the worker/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/^AG2\./m);
  });

  it("tells the worker to answer [operator] messages first, then continue", () => {
    expect(WORKER_CONTRACT_PROMPT).toContain(OPERATOR_MARK);
    expect(WORKER_CONTRACT_PROMPT).toContain("Answer it FIRST");
    expect(WORKER_CONTRACT_PROMPT).toContain("then continue the");
  });

  it("bans shell heredocs: write a script file, then run it", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/heredoc/i);
    expect(WORKER_CONTRACT_PROMPT).toContain("Write tool");
    expect(WORKER_CONTRACT_PROMPT).toMatch(/write it to a file with/);
  });

  it("bans inline multi-line/quoted payloads broadly, not just heredocs", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/inline/i);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/Write tool/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/\$\(cat /);
  });

  it("bans inline interpreter one-liners: permission layer denies them, write a script file or use jq", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/python3 -c/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/node -e/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/ruby -e/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/permission layer\s+denies/i);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/command denied by permission rules/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/python3 script\.py/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/use jq/);
  });

  it("states the worker's role first: finish the task itself, don't hand it off wholesale", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/You are the worker/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/PARALLELISING/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/one tier down/);
  });

  it("tells the worker its turn ending ends the run: no ScheduleWakeup, no leaving children running", () => {
    expect(WORKER_CONTRACT_PROMPT).toMatch(/Ending your turn ends/);
    expect(WORKER_CONTRACT_PROMPT).toMatch(/ScheduleWakeup/);
  });
});

describe("verifyReportChanges", () => {
  function withTmpDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "report-verify-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("passes when every changed path exists and was written after start", () => {
    withTmpDir((dir) => {
      const start = Date.now();
      writeFileSync(join(dir, "a.ts"), "x");
      const r = verifyReportChanges([{ path: "a.ts", summary: "added" }], dir, start);
      expect(r).toEqual({ ok: true, failures: [] });
    });
  });

  it("flags a claimed path that was never written", () => {
    withTmpDir((dir) => {
      const start = Date.now();
      const r = verifyReportChanges([{ path: "missing.ts", summary: "added" }], dir, start);
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([{ path: "missing.ts", reason: "missing" }]);
    });
  });

  it("flags a claimed path that exists but predates the run's start", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "old.ts"), "x");
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "old.ts"), old, old);
      const start = Date.now();
      const r = verifyReportChanges([{ path: "old.ts", summary: "touched" }], dir, start);
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([{ path: "old.ts", reason: "stale" }]);
    });
  });

  it("passes a path a summary says was deleted when it is actually absent", () => {
    withTmpDir((dir) => {
      const r = verifyReportChanges([{ path: "gone.ts", summary: "deleted the dead helper" }], dir, Date.now());
      expect(r).toEqual({ ok: true, failures: [] });
    });
  });

  it("flags a path a summary says was deleted when it still exists", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "still.ts"), "x");
      const r = verifyReportChanges([{ path: "still.ts", summary: "removed the helper" }], dir, Date.now());
      expect(r.ok).toBe(false);
      expect(r.failures).toEqual([{ path: "still.ts", reason: "not-deleted" }]);
    });
  });

  it("resolves relative paths against cwd", () => {
    withTmpDir((dir) => {
      const start = Date.now();
      writeFileSync(join(dir, "nested.ts"), "x");
      const r = verifyReportChanges([{ path: "./nested.ts" }], dir, start);
      expect(r.ok).toBe(true);
    });
  });
});

describe("verifyFailNote", () => {
  it("names the failure count and the first paths", () => {
    const note = verifyFailNote({
      ok: false,
      failures: [
        { path: "a.ts", reason: "missing" },
        { path: "b.csv", reason: "missing" },
      ],
    });
    expect(note).toBe("verify: 2 claimed changes not confirmed: a.ts, b.csv");
  });

  it("uses the singular for one failure", () => {
    const note = verifyFailNote({ ok: false, failures: [{ path: "a.ts", reason: "stale" }] });
    expect(note).toBe("verify: 1 claimed change not confirmed: a.ts");
  });
});

describe("headerLine — report markers", () => {
  const c = makeColor(false);
  const base = { id: "w1", label: "task", cwd: "/tmp/x" };

  it("shows no marker when the report is valid", () => {
    expect(headerLine(c, { ...base, reportFormat: "ag2", reportValid: true })).not.toContain("R!");
    expect(headerLine(c, { ...base, reportFormat: "ag2", reportValid: true })).not.toContain("R?");
  });

  it("shows R! for a structurally invalid AG2 report", () => {
    expect(
      headerLine(c, { ...base, reportFormat: "ag2", reportValid: false, reportErrors: ["bad r"] })
    ).toContain("R!");
  });

  it("shows R? for a json report whose claimed changes failed filesystem verification", () => {
    expect(headerLine(c, { ...base, reportFormat: "json", reportValid: false })).toContain("R?");
  });
});
