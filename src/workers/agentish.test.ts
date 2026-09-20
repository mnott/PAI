/**
 * Tests for the AG2 (Agentish v2) module: spec fallback, message parsing,
 * mapping onto WorkerReport, and the aibroker validator wrapper.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  AG2_EXTENSIONS_FALLBACK,
  AG2_SPEC_FALLBACK,
  ag2Spec,
  ag2ToWorkerReport,
  parseAg2Report,
  resetAg2SpecCache,
  validateAg2,
} from "./agentish.js";

afterEach(() => {
  resetAg2SpecCache();
  delete process.env.PATH_BACKUP_FOR_TEST;
});

describe("ag2Spec", () => {
  it("returns a spec line starting with AG2. and an extensions line", () => {
    const s = ag2Spec();
    expect(s.spec.startsWith("AG2.")).toBe(true);
    expect(s.extensions.length).toBeGreaterThan(0);
  });

  it("falls back to the frozen spec when aibroker is not on PATH", () => {
    resetAg2SpecCache();
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-bin-dir-for-test";
      const s = ag2Spec();
      expect(s.source).toBe("builtin");
      expect(s.spec).toBe(AG2_SPEC_FALLBACK);
      expect(s.extensions).toBe(AG2_EXTENSIONS_FALLBACK);
    } finally {
      process.env.PATH = savedPath;
      resetAg2SpecCache();
    }
  });

  it("memoises: a second call does not re-probe (same object identity)", () => {
    resetAg2SpecCache();
    const a = ag2Spec();
    const b = ag2Spec();
    expect(a).toBe(b);
  });
});

describe("parseAg2Report", () => {
  it("parses kind, k=v fields and @n symbol declarations", () => {
    const text = ["R", "i=fix-flaky-retry", "r=+", "@1=/repo/src/net/retry.ts", "c=@1:88 widened jitter"].join(
      "\n"
    );
    const parsed = parseAg2Report(text);
    expect(parsed?.kind).toBe("R");
    expect(parsed?.fields.i).toBe("fix-flaky-retry");
    expect(parsed?.fields.r).toBe("+");
    expect(parsed?.fields.c).toBe("@1:88 widened jitter");
    expect(parsed?.symbols["1"]).toBe("/repo/src/net/retry.ts");
  });

  it("ignores ```-fenced lines", () => {
    const text = ["R", "```", "not a field", "```", "i=x", "r=+"].join("\n");
    const parsed = parseAg2Report(text);
    expect(parsed?.fields.i).toBe("x");
    expect(Object.keys(parsed?.fields ?? {})).not.toContain("```");
  });

  it("returns null when the first line is not a known kind", () => {
    expect(parseAg2Report("Hello, here is my report:\ni=x")).toBeNull();
    expect(parseAg2Report("")).toBeNull();
  });

  it("takes only the first character of the kind line as the kind", () => {
    expect(parseAg2Report("R\ni=x")?.kind).toBe("R");
  });
});

describe("ag2ToWorkerReport", () => {
  it("maps c/t/p/z/r/y onto the WorkerReport shape", () => {
    const parsed = parseAg2Report(
      [
        "R",
        "i=x",
        "r=+",
        "z=one line note",
        "c=a.ts summary a|b.ts summary b",
        "t=Foo+ Bar-",
        "p=npm test|npm run lint",
      ].join("\n")
    )!;
    const report = ag2ToWorkerReport(parsed);
    expect(report.format).toBe("ag2");
    expect(report.result).toBe("+");
    expect(report.notes).toBe("one line note");
    expect(report.changed).toEqual([
      { path: "a.ts", summary: "summary a" },
      { path: "b.ts", summary: "summary b" },
    ]);
    expect(report.checks).toEqual([
      { name: "Foo", ok: true, detail: "+" },
      { name: "Bar", ok: false, detail: "-" },
    ]);
    expect(report.commands).toEqual(["npm test", "npm run lint"]);
  });

  it("maps x (next) and y (why) into open[] and why", () => {
    const parsed = parseAg2Report(["R", "i=x", "r=-", "y=blocked on a credential", "x=get the key"].join("\n"))!;
    const report = ag2ToWorkerReport(parsed);
    expect(report.why).toBe("blocked on a credential");
    expect(report.open).toContain("get the key");
  });

  it("changed entries split on ':' or ' ', whichever comes first", () => {
    const parsed = parseAg2Report(["R", "i=x", "r=+", "c=src/a.ts:12 fixed the guard"].join("\n"))!;
    const report = ag2ToWorkerReport(parsed);
    expect(report.changed).toEqual([{ path: "src/a.ts", summary: "12 fixed the guard" }]);
  });
});

describe("validateAg2", () => {
  it("ok:true for a message aibroker's validator accepts", () => {
    const text = [
      "R",
      "i=agentish-worker-scaffolding",
      "r=+",
      "G=+",
      "z=test message",
      "@1=/repo/src/workers/agentish.ts",
      "c=@1 new module",
      "t=Ag2Parse+",
      "p=npx vitest run src/workers",
    ].join("\n");
    const v = validateAg2(text);
    if (v.validator === "aibroker") {
      expect(v.ok).toBe(true);
      expect(v.errors).toEqual([]);
    } else {
      // aibroker not installed on this box: graceful no-validator default
      expect(v.ok).toBe(true);
    }
  });

  it("ok:false with error messages for a message missing required fields", () => {
    const v = validateAg2("R\nfoo=bar\n");
    if (v.validator === "aibroker") {
      expect(v.ok).toBe(false);
      expect(v.errors.length).toBeGreaterThan(0);
    } else {
      expect(v.ok).toBe(true);
    }
  });

  it("never throws and reports validator:none when the CLI cannot run", () => {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-bin-dir-for-test";
      const v = validateAg2("R\ni=x\nr=+\n");
      expect(v).toEqual({ ok: true, errors: [], validator: "none" });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
